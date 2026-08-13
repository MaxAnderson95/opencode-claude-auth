import type { Credential, Plugin } from "@opencode-ai/plugin"
import { buildRequestHeaders, buildRequestUrl } from "./index.ts"
import { readAllClaudeAccounts, type ClaudeAccount } from "./keychain.ts"
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
import {
  forceRefreshActiveAccount,
  getActiveAccount,
  getActiveRefreshFailureKind,
  getCachedCredentials,
  getCredentialsWithBackoff,
  initAccounts,
  loadPersistedAccountSource,
  refreshAccountsList,
  refreshIfNeeded,
  reloadCredentialsFromSource,
  saveAccountSource,
  setActiveAccountSource,
  type ClaudeCredentials,
} from "./credentials.ts"

export const INTEGRATION_ID = "anthropic"
// Deliberately NOT "oauth": the v1->v2 migration imports the legacy
// auth.json anthropic entry with methodID "oauth". Registering our refresh
// owner under a different method id keeps the host from ever matching that
// imported row to our implementation and persisting divergent tokens —
// Claude Code's store stays the single source of truth.
export const METHOD_ID = "claude-code"
export const METHOD_LABEL = "Claude Code (Pro/Max subscription)"

const SYNC_INTERVAL = 5 * 60 * 1000 // 5 minutes
const PROACTIVE_REFRESH_THRESHOLD_MS = 60 * 60 * 1000 // 1 hour before expiry

/**
 * Map Claude Code store credentials onto the host's OAuth credential shape.
 * The metadata lets the method's label callback show which account a stored
 * credential belongs to.
 */
export function toOAuthCredential(
  creds: ClaudeCredentials,
  account: ClaudeAccount,
): Credential.OAuth {
  return {
    type: "oauth",
    methodID: METHOD_ID as Credential.OAuth["methodID"],
    access: creds.accessToken,
    refresh: creds.refreshToken,
    // The credential schema rejects a non-integer `expires`. Credentials read
    // straight from the keychain/file can carry fractional milliseconds.
    expires: Math.floor(creds.expiresAt),
    metadata: { source: account.source, label: account.label },
  }
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
  requestStartedAt: number
  url: string
  body: string | undefined
  /** Headers as the host built them, BEFORE our rewrite — retries rebuild
   * from these so beta-merge semantics match the original request. */
  originalHeaders: Headers
  /** Betas excluded at request-build time; 401/429 retries reuse this set. */
  excluded: Set<string>
}

export const setup: Plugin.Plugin["setup"] = async (ctx) => {
  initLogger()

  let accounts: ClaudeAccount[] = []
  try {
    accounts = readAllClaudeAccounts()
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log("plugin_init_error", { error })
    console.warn(
      "opencode-claude-auth: Failed to read Claude Code credentials:",
      error,
    )
    return
  }

  initAccounts(accounts)

  const defaultAccountSource = accounts[0]?.source ?? null
  let syncTimer: ReturnType<typeof setInterval> | undefined

  if (accounts.length > 0) {
    const persistedSource = loadPersistedAccountSource()
    const defaultAccount =
      (persistedSource && accounts.find((a) => a.source === persistedSource)) ||
      accounts[0]

    setActiveAccountSource(defaultAccount.source)

    log("plugin_init", {
      accountCount: accounts.length,
      sources: accounts.map((a) => a.source),
      activeSource: defaultAccount.source,
    })

    const initialCreds = await getCachedCredentials()
    if (!initialCreds) {
      console.warn(
        "opencode-claude-auth: Claude credentials are expired and could not be refreshed. Run `claude` to re-authenticate.",
      )
    }

    // Proactively refresh before expiry. refreshIfNeeded() always resolves
    // the currently ACTIVE account (via getActiveAccount() internally) — not
    // a closure-captured account list — so this stays correct across account
    // switches. Passing PROACTIVE_REFRESH_THRESHOLD_MS (1 hour) means it
    // triggers a real OAuth refresh once the token is within that window of
    // expiry, and simply returns the untouched credentials otherwise (no-op
    // refresh). This prevents mid-session expiry surprises.
    let proactiveRefreshWarned = false
    syncTimer = setInterval(async () => {
      try {
        const account = getActiveAccount()
        log("proactive_refresh_check", {
          source: account?.source ?? null,
          expiresAt: account?.credentials?.expiresAt ?? null,
          thresholdMs: PROACTIVE_REFRESH_THRESHOLD_MS,
        })

        const creds = await refreshIfNeeded(
          undefined,
          PROACTIVE_REFRESH_THRESHOLD_MS,
        )
        if (creds) {
          if (proactiveRefreshWarned) {
            log("proactive_refresh_recovered", { source: account?.source })
          }
          proactiveRefreshWarned = false
        } else {
          log("proactive_refresh_failed", { source: account?.source })
          // Only warn once per outage — otherwise this fires every
          // SYNC_INTERVAL (5 min) for as long as refresh keeps failing.
          if (!proactiveRefreshWarned) {
            proactiveRefreshWarned = true
            console.warn(
              "opencode-claude-auth: Proactive token refresh failed. Run `claude` to re-authenticate.",
            )
          }
        }
      } catch {
        // Non-fatal
      }
    }, SYNC_INTERVAL)
    syncTimer.unref()
  } else {
    log("plugin_init_no_accounts", { reason: "no credentials found" })
    console.warn(
      "opencode-claude-auth: No Claude Code credentials found. Anthropic requests are left untouched until you log in with `claude`.",
    )
  }

  // Whether this plugin owns anthropic requests: Claude Code accounts exist
  // and the host's active anthropic connection is not an explicit API key
  // (key credential or ANTHROPIC_API_KEY env). The legacy imported oauth row
  // and our own "claude-code" credential both resolve as oauth, so both
  // count as ours. Re-evaluated on integration.connection.updated events;
  // like v1, newly-created accounts still need a restart to be discovered.
  let owns = false
  const evaluateOwnership = async (): Promise<void> => {
    if (accounts.length === 0) {
      owns = false
      return
    }
    try {
      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      if (!connection) {
        // No credential yet: own the provider so a login through our method
        // works immediately and the catalog transform is ready.
        owns = true
        return
      }
      const value = await ctx.integration.connection.resolve(connection)
      owns = value?.type !== "key"
    } catch (err) {
      // Prefer serving subscription auth over silently sending a stale
      // imported token when the connection cannot be inspected.
      owns = true
      log("ownership_resolve_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    log("ownership_evaluated", { owns })
  }
  await evaluateOwnership()

  const registrations: Array<{ dispose: () => Promise<void> }> = []

  // --- Login method: "Login with Claude Code" on the anthropic integration ---
  registrations.push(
    await ctx.integration.transform((draft) => {
      const currentAccounts = refreshAccountsList()
      const currentSource = loadPersistedAccountSource() ?? defaultAccountSource
      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: METHOD_ID,
          type: "oauth",
          label: METHOD_LABEL,
          ...(currentAccounts.length > 1
            ? {
                form: [
                  {
                    type: "string" as const,
                    key: "account",
                    title: "Claude Code account",
                    description: "Select which Claude Code account to use",
                    required: true,
                    options: currentAccounts.map((a) => ({
                      value: a.source,
                      label: a.label,
                      ...(a.source === currentSource
                        ? { description: "active" }
                        : {}),
                    })),
                    ...(currentSource ? { default: currentSource } : {}),
                  },
                ],
              }
            : {}),
        },
        // No `refresh` on purpose: this plugin (and the claude CLI / sibling
        // processes) own token rotation against Claude Code's store. A host
        // refresh would rotate the refresh token out from under that store.
        authorize: async (answer) => {
          const latestAccounts = refreshAccountsList()
          const requested =
            typeof answer["account"] === "string"
              ? answer["account"]
              : undefined
          const source =
            requested ?? latestAccounts[0]?.source ?? accounts[0]?.source
          const chosen =
            latestAccounts.find((a) => a.source === source) ??
            accounts.find((a) => a.source === source) ??
            latestAccounts[0] ??
            accounts[0]
          if (!chosen) {
            throw new Error(
              "No Claude Code credentials found. Run `claude` to log in first.",
            )
          }

          setActiveAccountSource(chosen.source)
          const creds = (await getCachedCredentials()) ?? chosen.credentials
          saveAccountSource(chosen.source)

          const sourceDescription =
            chosen.source === "file"
              ? `credentials file (${chosen.configDir ?? "~/.claude"}/.credentials.json)`
              : `macOS Keychain (${chosen.source})`

          return {
            url: "",
            instructions: `Using ${chosen.label} — credentials loaded from ${sourceDescription}.`,
            mode: "auto" as const,
            callback: Promise.resolve(toOAuthCredential(creds, chosen)),
          }
        },
        label: (credential) => {
          const label = credential.metadata?.["label"]
          return typeof label === "string" ? label : undefined
        },
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

      let latest = await getCachedCredentials()
      if (!latest) {
        // A transient refresh rate-limit must not surface as a hard error.
        // Wait (bounded, abort-aware) for our cooldown to clear or for a
        // sibling OpenCode instance / the claude CLI to write a fresh token
        // to the shared store.
        latest = await getCredentialsWithBackoff({ signal: original.signal })
      }
      if (!latest) {
        if (getActiveRefreshFailureKind() === "transient") {
          // v1 returned a synthetic 429 here so the SDK would retry; the
          // http.request hook cannot substitute a response, so this surfaces
          // as a request error instead once the wait budget is exhausted.
          log("fetch_credentials_transient_exhausted", { modelId: "unknown" })
          throw new Error(
            "Claude token refresh is rate-limited; retry shortly.",
          )
        }
        log("fetch_no_credentials", { modelId: "unknown" })
        throw new Error(
          "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
        )
      }

      const rawBody = await original.clone().text()
      let modelId = String(evt.model.id)
      if (rawBody) {
        try {
          modelId = (JSON.parse(rawBody) as { model?: string }).model ?? modelId
        } catch {}
      }

      log("fetch_credentials", {
        modelId,
        accessToken: latest.accessToken,
        expiresAt: latest.expiresAt,
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
        latest.accessToken,
        modelId,
        excluded,
      )
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
        requestStartedAt,
        url,
        body: typeof body === "string" ? body : undefined,
        originalHeaders,
        excluded,
      })
    }),
  )

  // --- Response recovery: 401 refresh-retry, 429 rotation, beta fallback ---
  registrations.push(
    await ctx.session.hook("http.response", async (evt) => {
      if (evt.model.providerID !== "anthropic") return
      // Only handle requests we rewrote: the meta doubles as the marker.
      const meta = requestMeta.get(evt.request)
      if (!meta) return
      requestMeta.delete(evt.request)

      const {
        modelId,
        requestStartedAt,
        url,
        body,
        originalHeaders,
        excluded,
      } = meta
      const signal = evt.request.signal
      const retry = (
        token: string,
        excludedBetas: Set<string>,
      ): Promise<Response> =>
        fetchWithRetry(url, {
          method: evt.request.method,
          body,
          headers: buildRequestHeaders(
            url,
            { headers: originalHeaders },
            token,
            modelId,
            excludedBetas,
          ),
          signal,
        })

      let response = evt.response
      log("fetch_response", {
        status: response.status,
        modelId,
        retryAttempt: 0,
      })

      // Recover from a rejected token: first by adopting credentials rotated
      // externally (cswap switching accounts, the claude CLI, another
      // OpenCode instance), then by forcing an OAuth refresh when the store
      // still holds the token that was just rejected. See v1 index.ts for the
      // full rationale; the loop shape and cap are ported unchanged.
      const MAX_AUTH_RECOVERY_ATTEMPTS = 2
      // The token the request went out with lives in the rewritten request's
      // own authorization header.
      let tokenInUse =
        evt.request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""

      for (
        let attempt = 0;
        response.status === 401 && attempt < MAX_AUTH_RECOVERY_ATTEMPTS;
        attempt++
      ) {
        let candidate: ClaudeCredentials | null = null
        // reloadCredentialsFromSource catches its own source read and returns
        // null, so this is unreachable today. It stays because no reload
        // failure may turn a well-formed 401 into an exception thrown out of
        // the hook — degrading to the original response beats crashing the
        // request.
        try {
          candidate = reloadCredentialsFromSource()
        } catch (err) {
          log("auth_recovery_reload_threw", {
            modelId,
            attempt: attempt + 1,
            error: err instanceof Error ? err.message : String(err),
          })
        }

        if (!candidate || candidate.accessToken === tokenInUse) {
          try {
            candidate = await forceRefreshActiveAccount()
          } catch (err) {
            log("auth_recovery_force_refresh_threw", {
              modelId,
              attempt: attempt + 1,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }

        if (!candidate || candidate.accessToken === tokenInUse) {
          log("auth_recovery_exhausted", { modelId, attempt: attempt + 1 })
          break
        }

        tokenInUse = candidate.accessToken
        log("auth_recovery_retry", { modelId, attempt: attempt + 1 })
        response = await retry(tokenInUse, excluded)
      }

      // An external switch — cswap rotating off an exhausted account — leaves
      // this session on the old token until the 30s credential cache expires.
      // Re-read once so a rate limit that has already been resolved elsewhere
      // is not surfaced. Ordered AFTER the 401 recovery loop (must compare
      // against the token the loop last tried) and BEFORE the long-context
      // beta loop (a long-context 429 rotates no token and falls through
      // untouched). See v1 index.ts for the full ordering rationale.
      if (response.status === 429) {
        let rotated: ClaudeCredentials | null = null
        try {
          rotated = reloadCredentialsFromSource()
        } catch (err) {
          log("rate_limit_reload_threw", {
            modelId,
            error: err instanceof Error ? err.message : String(err),
          })
        }

        if (rotated && rotated.accessToken !== tokenInUse) {
          // A changed token is not proof of an account switch — see v1.
          log("rate_limit_token_changed", { modelId })
          tokenInUse = rotated.accessToken
          response = await retry(tokenInUse, excluded)
          log("rate_limit_retry_response", {
            modelId,
            status: response.status,
          })
        }
      }

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

        // Falls back to tokenInUse, not the request-time token: after a 401
        // recovery the latter is the token the API already rejected.
        const currentCreds = await getCachedCredentials()
        const retryToken = currentCreds?.accessToken ?? tokenInUse
        response = await retry(retryToken, getExcludedBetas(modelId))
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
    if (syncTimer !== undefined) clearInterval(syncTimer)
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
