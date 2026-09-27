import { createHash } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { buildRequestHeaders, buildRequestUrl } from "./index.ts"
import { initLogger, log } from "./logger.ts"
import { fetchWithRetry } from "./http.ts"
import {
  addExcludedBeta,
  getExcludedBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.ts"
import {
  SYSTEM_IDENTITY,
  transformBody,
  transformResponseStream,
} from "./transforms.ts"
import { authorize, OAUTH_METHOD_ID, refreshCredential } from "./oauth.ts"
import { createUsageLimitTracker, UsageLimitRpc } from "./usage-limit.ts"

export const INTEGRATION_ID = "anthropic"
export const METHOD_ID = OAUTH_METHOD_ID
export const METHOD_LABEL = "Claude Pro/Max subscription"

// Every location's plugin instance shares this process, so all of them read
// and update one tracker. It keys quota by account.
const usageLimits = createUsageLimitTracker()

type ActiveConnection = Awaited<
  ReturnType<Plugin.Context["integration"]["connection"]["active"]>
>

function accountID(connection: ActiveConnection): string {
  return connection?.type === "credential" ? connection.id : "oauth"
}

type SystemEntry = { type?: string; text?: string } & Record<string, unknown>

/**
 * Guarantee the Claude Code identity line exists as a system entry before
 * transformBody runs. v1 relied on the host's system.transform hook to
 * prepend it; v2 applies it here, in the body rewrite itself, so it cannot
 * be lost to hook ordering. transformBody then splits/relocates entries so
 * the final system[] is exactly [billing header, identity].
 */
export function ensureSystemIdentity(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return body
    }
    const system = Array.isArray(parsed["system"])
      ? (parsed["system"] as SystemEntry[])
      : []
    // Same containment test v1's system.transform used: an entry that merely
    // contains the identity mid-text still counts as present.
    const hasIdentity = system.some(
      (entry) =>
        typeof entry?.text === "string" && entry.text.includes(SYSTEM_IDENTITY),
    )
    if (hasIdentity) return body
    parsed["system"] = [{ type: "text", text: SYSTEM_IDENTITY }, ...system]
    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

/** Per-request context threaded from the http.request hook into http.response. */
interface RequestMeta {
  modelId: string
  claudeSessionID: string
  account: string
  requestStartedAt: number
  url: string
  body: string | undefined
  /** Headers as the host built them, BEFORE our rewrite — retries rebuild
   * from these so beta-merge semantics match the original request. */
  originalHeaders: Headers
}

export function toClaudeSessionID(
  openCodeSessionID: string,
  credentialID: string,
): string {
  const bytes = createHash("sha256")
    .update(`${openCodeSessionID}:${credentialID}`)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const setup: Plugin.Plugin["setup"] = async (ctx) => {
  initLogger()

  // Subscription OAuth requests need Claude Code's wire format. API-key and
  // environment connections remain native Anthropic requests.
  let owns = false
  const evaluateOwnership = async (): Promise<void> => {
    try {
      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      if (!connection) return void (owns = false)
      const value = await ctx.integration.connection.resolve(connection)
      owns = value?.type === "oauth"
    } catch (err) {
      owns = false
      log("ownership_resolve_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    log("ownership_evaluated", { owns })
  }
  await evaluateOwnership()

  const registrations: Array<{ dispose: () => Promise<void> }> = []

  const activeAccount = async () =>
    accountID(await ctx.integration.connection.active(INTEGRATION_ID))
  const usageLimitRpc = await ctx.rpc.register(UsageLimitRpc, {
    status: async () => usageLimits.status(await activeAccount()),
  })
  registrations.push(usageLimitRpc)
  const publishUsageLimit = async (account: string): Promise<void> => {
    try {
      if (account !== (await activeAccount())) return
      const status = usageLimits.status(account)
      log("usage_limit_status", { ...status })
      await usageLimitRpc.events.emit("changed", status)
    } catch (err) {
      log("usage_limit_emit_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // --- Direct Claude subscription OAuth on the Anthropic integration ---
  registrations.push(
    await ctx.integration.transform((draft) => {
      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: METHOD_ID,
          type: "oauth",
          label: METHOD_LABEL,
          form: [
            {
              key: "loginMode",
              type: "string",
              title: "Authorization method",
              default: "auto",
              options: [
                {
                  value: "auto",
                  label: "Automatic",
                  description:
                    "Use paste-code login on SSH or headless Linux hosts",
                },
                {
                  value: "manual",
                  label: "Paste code",
                  description: "Authorize in a browser on another machine",
                },
                {
                  value: "local",
                  label: "Local callback",
                  description: "Browser can reach this server's localhost",
                },
              ],
            },
          ],
        },
        authorize,
        refresh: refreshCredential,
        label: () => "Claude subscription",
      })
    }),
  )

  // --- Zero-cost override: subscription usage is already paid for ---
  registrations.push(
    await ctx.model.transform((draft) => {
      if (!owns) return
      const record = draft.provider.get(INTEGRATION_ID)
      if (!record) return
      for (const modelID of record.models.keys()) {
        draft.update(INTEGRATION_ID, modelID, (model) => {
          model.cost = []
        })
      }
    }),
  )

  const requestMeta = new WeakMap<Request, RequestMeta>()

  // --- Request rewrite: auth header, beta merge, body transforms ---
  registrations.push(
    await ctx.session.hook("http.request", async (evt) => {
      if (evt.model.providerID !== "anthropic" || !owns) return

      const requestStartedAt = Date.now()
      const original = evt.request

      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      const credential = connection
        ? await ctx.integration.connection.resolve(connection)
        : undefined
      if (credential?.type !== "oauth") {
        log("fetch_no_credentials", { modelId: "unknown" })
        throw new Error(
          "Claude subscription credentials are unavailable. Connect an account through /connect.",
        )
      }
      const account = accountID(connection)
      const claudeSessionID = toClaudeSessionID(evt.sessionID, account)

      const rawBody = await original.clone().text()
      let modelId = String(evt.model.id)
      if (rawBody) {
        try {
          modelId = (JSON.parse(rawBody) as { model?: string }).model ?? modelId
        } catch {}
      }

      log("fetch_credentials", {
        modelId,
        accessToken: credential.access,
        expiresAt: credential.expires,
      })

      // Excluded betas for this model (from previous failed requests).
      const excluded = getExcludedBetas(modelId)
      const url = String(buildRequestUrl(original.url))
      // Snapshot the host's headers before the rewrite: response-side retries
      // rebuild from these so the beta merge sees the same inputs v1's
      // buildRequestHeaders saw on every attempt.
      const originalHeaders = new Headers(original.headers)
      const headers = buildRequestHeaders(
        original,
        {},
        credential.access,
        modelId,
        excluded,
      )
      headers.set("X-Claude-Code-Session-Id", claudeSessionID)
      const transformed = rawBody
        ? transformBody(ensureSystemIdentity(rawBody))
        : undefined
      const body =
        evt.kind === "primary" && typeof transformed === "string"
          ? usageLimits.annotate(account, evt.sessionID, transformed)
          : transformed

      if (body !== transformed) {
        log("usage_limit_annotation", {
          sessionID: evt.sessionID,
          account,
          modelId,
          quota: usageLimits.status(account),
        })
      }

      const headerKeys: string[] = []
      headers.forEach((_, key) => {
        headerKeys.push(key)
      })
      const betas = (headers.get("anthropic-beta") ?? "")
        .split(",")
        .filter(Boolean)
      log("fetch_headers_built", { headerKeys, betas, modelId })

      evt.request = new Request(url, {
        method: original.method,
        headers,
        body: typeof body === "string" ? body : null,
        signal: original.signal,
      })
      requestMeta.set(evt.request, {
        modelId,
        claudeSessionID,
        account,
        requestStartedAt,
        url,
        body: typeof body === "string" ? body : undefined,
        originalHeaders,
      })
    }),
  )

  // --- Response transform and long-context beta fallback ---
  registrations.push(
    await ctx.session.hook("http.response", async (evt) => {
      if (evt.model.providerID !== "anthropic") return
      // Only handle requests we rewrote: the meta doubles as the marker.
      const meta = requestMeta.get(evt.request)
      if (!meta) return
      requestMeta.delete(evt.request)

      const {
        modelId,
        claudeSessionID,
        requestStartedAt,
        url,
        body,
        originalHeaders,
      } = meta
      const signal = evt.request.signal
      const retry = async (excludedBetas: Set<string>): Promise<Response> => {
        return fetchWithRetry(
          url,
          {
            method: evt.request.method,
            body,
            signal,
          },
          3,
          async (input, init) => {
            // Re-resolve on every attempt so a refreshed token is used.
            const connection =
              await ctx.integration.connection.active(INTEGRATION_ID)
            const credential = connection
              ? await ctx.integration.connection.resolve(connection)
              : undefined
            if (credential?.type !== "oauth")
              throw new Error(
                "Claude subscription credentials unavailable for retry",
              )
            const headers = buildRequestHeaders(
              url,
              { headers: originalHeaders },
              credential.access,
              modelId,
              excludedBetas,
            )
            headers.set("X-Claude-Code-Session-Id", claudeSessionID)
            return fetch(input, { ...init, headers })
          },
        )
      }

      let response = evt.response
      log("fetch_response", {
        status: response.status,
        modelId,
        retryAttempt: 0,
      })
      // Check for long-context beta errors and retry with betas excluded,
      // one more exclusion per attempt.
      for (let attempt = 0; attempt < LONG_CONTEXT_BETAS.length; attempt++) {
        if (response.status !== 400 && response.status !== 429) {
          break
        }

        const cloned = response.clone()
        const responseBody = await cloned.text()

        if (!isLongContextError(responseBody)) {
          break
        }

        const betaToExclude = getNextBetaToExclude(modelId)
        if (!betaToExclude) {
          break // All long-context betas already excluded
        }

        addExcludedBeta(modelId, betaToExclude)
        log("fetch_beta_excluded", { modelId, excludedBeta: betaToExclude })

        response = await retry(getExcludedBetas(modelId))
      }

      // Keep the evidence needed to distinguish included grace from paid
      // overage, even if the derived status does not change between requests.
      log("usage_limit_response", {
        sessionID: evt.sessionID,
        account: meta.account,
        modelId,
        kind: evt.kind,
        status: response.status,
        elapsedMs: Date.now() - requestStartedAt,
        headers: Object.fromEntries(
          [...response.headers].filter(
            ([name]) =>
              name.startsWith("anthropic-ratelimit-") ||
              name === "retry-after" ||
              name === "request-id" ||
              name === "x-request-id",
          ),
        ),
      })
      if (usageLimits.observe(meta.account, response.headers)) {
        await publishUsageLimit(meta.account)
      }

      // Record non-200 responses without writing over OpenCode's terminal UI.
      if (!response.ok) {
        const status = response.status
        const cloned = response.clone()
        cloned
          .text()
          .then((errorBody) => {
            let message = errorBody
            try {
              const parsed = JSON.parse(errorBody) as {
                error?: { type?: string; message?: string }
              }
              message = parsed.error?.message ?? parsed.error?.type ?? errorBody
            } catch {}
            log("fetch_error_response", { status, modelId, message })
          })
          .catch(() => {})
      }

      // A 401 that survived recovery carries an error body, not an SSE
      // stream. Everything else goes through the stream transform, which
      // also strips the mcp_ tool-name prefixes the request rewrite added.
      evt.response =
        response.status === 401
          ? response
          : transformResponseStream(response, { modelId, requestStartedAt })
    }),
  )

  // Re-evaluate ownership (and re-run the model cost transform) when the
  // anthropic connection changes — e.g. the user connects an API key or logs
  // in through our method mid-session.
  const eventAbort = new AbortController()
  void (async () => {
    while (!eventAbort.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({
          signal: eventAbort.signal,
        })) {
          if (
            event.type === "credential.updated" ||
            (event.type === "credential.switched" &&
              event.data.integrationID === INTEGRATION_ID)
          ) {
            await evaluateOwnership()
            await ctx.model.reload()
            // The TUI shows the active account's quota, which just changed.
            await publishUsageLimit(await activeAccount())
          }
        }
      } catch (error) {
        log("event_stream_ended", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      // Resubscribe so a dropped stream does not freeze ownership at its last value.
      if (!eventAbort.signal.aborted) {
        await delay(1000, undefined, { signal: eventAbort.signal }).catch(
          () => {},
        )
      }
    }
  })()

  return async () => {
    eventAbort.abort()
    for (const registration of registrations) {
      try {
        await registration.dispose()
      } catch {
        // Host may already have torn the registration down.
      }
    }
  }
}
