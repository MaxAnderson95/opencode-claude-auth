import { createHash } from "node:crypto"
import type { Plugin } from "@opencode-ai/plugin"
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

export const INTEGRATION_ID = "anthropic"
export const METHOD_ID = OAUTH_METHOD_ID
export const METHOD_LABEL = "Claude Pro/Max subscription"

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

  // --- Direct Claude subscription OAuth on the Anthropic integration ---
  registrations.push(
    await ctx.integration.transform((draft) => {
      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: METHOD_ID,
          type: "oauth",
          label: METHOD_LABEL,
        },
        authorize,
        refresh: refreshCredential,
        label: () => "Claude subscription",
      })
    }),
  )

  // --- Zero-cost override: subscription usage is already paid for ---
  registrations.push(
    await ctx.catalog.transform((draft) => {
      if (!owns) return
      const record = draft.provider.get(INTEGRATION_ID)
      if (!record) return
      for (const modelID of record.models.keys()) {
        draft.model.update(INTEGRATION_ID, modelID, (model) => {
          model.cost = []
        })
      }
    }),
  )

  const requestMeta = new WeakMap<Request, RequestMeta>()

  // --- Request rewrite: auth header, beta merge, body transforms ---
  registrations.push(
    await ctx.session.hook("http.request", async (evt) => {
      if (evt.model.providerID !== "anthropic") return
      if (!owns) return

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
      const claudeSessionID = toClaudeSessionID(
        evt.sessionID,
        connection?.type === "credential" ? connection.id : "oauth",
      )

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
      const body = rawBody
        ? transformBody(ensureSystemIdentity(rawBody))
        : undefined

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
      const retry = (
        token: string,
        excludedBetas: Set<string>,
      ): Promise<Response> => {
        const headers = buildRequestHeaders(
          url,
          { headers: originalHeaders },
          token,
          modelId,
          excludedBetas,
        )
        headers.set("X-Claude-Code-Session-Id", claudeSessionID)
        return fetchWithRetry(url, {
          method: evt.request.method,
          body,
          headers,
          signal,
        })
      }

      let response = evt.response
      log("fetch_response", {
        status: response.status,
        modelId,
        retryAttempt: 0,
      })
      const tokenInUse =
        evt.request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""

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

        response = await retry(tokenInUse, getExcludedBetas(modelId))
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

  // Re-evaluate ownership (and re-run the catalog cost transform) when the
  // anthropic connection changes — e.g. the user connects an API key or logs
  // in through our method mid-session.
  const eventAbort = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({
        signal: eventAbort.signal,
      })) {
        if (
          event.type === "integration.connection.updated" &&
          event.data.integrationID === INTEGRATION_ID
        ) {
          await evaluateOwnership()
          await ctx.catalog.reload()
        }
      }
    } catch {
      // Subscription ended (shutdown/abort); ownership stays as last evaluated.
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
