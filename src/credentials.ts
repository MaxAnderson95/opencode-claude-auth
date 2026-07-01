import { execFileSync, execSync, type StdioOptions } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  readAllClaudeAccounts,
  refreshAccount,
  writeBackCredentials,
  type ClaudeCredentials,
  type ClaudeAccount,
} from "./keychain.ts"
import { resetExcludedBetas } from "./betas.ts"
import { log } from "./logger.ts"

export type { ClaudeCredentials } from "./keychain.ts"
export type { ClaudeAccount } from "./keychain.ts"

const CREDENTIAL_CACHE_TTL_MS = 30_000

/** Truncate a string for safe logging, appending the original length. */
function truncate(value: string, max: number): string {
  return value.length > max
    ? `${value.slice(0, max)}... [${value.length} chars]`
    : value
}

const accountCacheMap = new Map<
  string,
  { creds: ClaudeCredentials; cachedAt: number }
>()
let activeAccountSource: string | null = null
let allAccounts: ClaudeAccount[] = []

export function initAccounts(accounts: ClaudeAccount[]): void {
  allAccounts = accounts
}

export function getAccounts(): ClaudeAccount[] {
  return allAccounts
}

export function setActiveAccountSource(source: string): void {
  const previous = activeAccountSource
  activeAccountSource = source
  accountCacheMap.delete(source)
  resetExcludedBetas()
  if (previous && previous !== source) {
    log("account_switch", { newSource: source, previousSource: previous })
  }
}

export function refreshAccountsList(): ClaudeAccount[] {
  allAccounts = readAllClaudeAccounts()
  return allAccounts
}

function getActiveAccount(): ClaudeAccount | null {
  if (allAccounts.length === 0) return null
  if (activeAccountSource) {
    const found = allAccounts.find((a) => a.source === activeAccountSource)
    if (found) return found
  }
  return allAccounts[0]
}

function getAccountStateFile(): string {
  return join(
    homedir(),
    ".local",
    "share",
    "opencode",
    "claude-account-source.txt",
  )
}

export function loadPersistedAccountSource(): string | null {
  try {
    const path = getAccountStateFile()
    if (existsSync(path)) {
      return readFileSync(path, "utf-8").trim() || null
    }
  } catch {
    // ignore
  }
  return null
}

export function saveAccountSource(source: string): void {
  try {
    const path = getAccountStateFile()
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, source, "utf-8")
  } catch {
    // Non-fatal
  }
}

function getAuthJsonPaths(): string[] {
  const xdgPath = join(homedir(), ".local", "share", "opencode", "auth.json")
  if (process.platform === "win32") {
    const appData =
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    const localAppDataPath = join(appData, "opencode", "auth.json")
    return [xdgPath, localAppDataPath]
  }
  return [xdgPath]
}

function syncToPath(authPath: string, creds: ClaudeCredentials): void {
  let auth: Record<string, unknown> = {}
  if (existsSync(authPath)) {
    const raw = readFileSync(authPath, "utf-8").trim()
    if (raw) {
      try {
        auth = JSON.parse(raw)
      } catch {
        // Malformed file, start fresh
      }
    }
  }
  auth.anthropic = {
    type: "oauth",
    access: creds.accessToken,
    refresh: creds.refreshToken,
    expires: Math.floor(creds.expiresAt),
  }
  const dir = dirname(authPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  writeFileSync(authPath, JSON.stringify(auth, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  })
  if (process.platform !== "win32") {
    chmodSync(authPath, 0o600)
  }
}

export function syncAuthJson(creds: ClaudeCredentials): void {
  for (const authPath of getAuthJsonPaths()) {
    try {
      syncToPath(authPath, creds)
      log("sync_auth_json", { path: authPath, success: true })
    } catch (err) {
      log("sync_auth_json", {
        path: authPath,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }
}

export const OAUTH_TOKEN_URL = "https://claude.ai/v1/oauth/token"
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

/**
 * Parse a raw OAuth token response into ClaudeCredentials.
 * Returns null if the response is missing a valid access_token.
 * Defaults expires_in to 36000s (10h) to match observed Claude token lifetime.
 */
export function parseOAuthResponse(
  raw: string,
  currentRefreshToken: string,
  now: number = Date.now(),
): ClaudeCredentials | null {
  let data: {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
  }
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }

  if (!data.access_token) return null

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? currentRefreshToken,
    expiresAt: now + (data.expires_in ?? 36_000) * 1000,
  }
}

export function refreshViaOAuth(
  refreshToken: string,
): ClaudeCredentials | null {
  // Use a Node subprocess to perform the HTTP request synchronously.
  // The refresh token is passed via stdin to avoid exposure in process args.
  const script = `
    process.stdin.resume();
    let input = '';
    process.stdin.on('data', c => input += c);
    process.stdin.on('end', () => {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: '${OAUTH_CLIENT_ID}',
        refresh_token: input.trim()
      });
      fetch('${OAUTH_TOKEN_URL}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      })
      .then(r => r.text().then(t => ({ status: r.status, ok: r.ok, body: t })))
      .then(o => { process.stdout.write(JSON.stringify(o)); })
      .catch(e => { process.stdout.write(JSON.stringify({ status: 0, ok: false, body: String(e) })); });
    });
  `

  const startedAt = Date.now()
  try {
    log("refresh_started", { source: "oauth" })
    const result = execFileSync(process.execPath, ["-e", script], {
      input: refreshToken,
      timeout: 15_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    })

    let envelope: { status?: number; ok?: boolean; body?: string }
    try {
      envelope = JSON.parse(result) as {
        status?: number
        ok?: boolean
        body?: string
      }
    } catch {
      envelope = {}
    }

    if (!envelope.ok) {
      log("refresh_failed", {
        source: "oauth",
        status: envelope.status ?? "unknown",
        // Non-2xx bodies carry an OAuth error (e.g. invalid_grant / expired
        // refresh token), never the access/refresh tokens — safe to log.
        error: truncate(envelope.body ?? "no response body", 500),
        // Synchronous execFileSync blocks the event loop for this long.
        durationMs: Date.now() - startedAt,
      })
      return null
    }

    const creds = parseOAuthResponse(envelope.body ?? "", refreshToken)
    if (!creds) {
      log("refresh_failed", {
        source: "oauth",
        status: envelope.status ?? "unknown",
        error: "no access_token in response",
        durationMs: Date.now() - startedAt,
      })
      return null
    }

    log("refresh_success", {
      source: "oauth",
      status: envelope.status,
      durationMs: Date.now() - startedAt,
    })
    return creds
  } catch (err) {
    // Network error, timeout, or subprocess spawn failure.
    const e = err as { killed?: boolean }
    log("refresh_failed", {
      source: "oauth",
      error: err instanceof Error ? err.message : String(err),
      killed: e.killed,
      durationMs: Date.now() - startedAt,
    })
    return null
  }
}

/**
 * Resolve the `claude` CLI to an absolute path so the refresh fallback works
 * even under a minimal PATH (e.g. launchd-managed servers). Honors the
 * CLAUDE_CLI_PATH override, then checks known install locations, then falls
 * back to a shell PATH lookup, and finally to the bare command name.
 */
function resolveClaudeBinary(): string {
  const override = process.env.CLAUDE_CLI_PATH
  if (override) return override

  if (process.platform !== "win32") {
    const candidates = [
      join(homedir(), ".local", "bin", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      "/usr/bin/claude",
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    try {
      const found = execFileSync("/bin/sh", ["-c", "command -v claude"], {
        timeout: 2000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
      if (found && existsSync(found)) return found
    } catch {
      // fall through to bare command name
    }
  }

  // Bare name; resolved via PATH (execFile on POSIX, shell on Windows).
  return "claude"
}

function runClaudeRefresh(claudeBin: string): void {
  const env = { ...process.env, TERM: "dumb" }
  // Capture stderr so refresh failures are diagnosable; ignore stdin/stdout.
  const stdio: StdioOptions = ["ignore", "ignore", "pipe"]
  if (process.platform === "win32") {
    // Use a shell so Windows resolves claude.cmd/.exe via PATHEXT.
    execSync(`${claudeBin} -p . --model haiku`, {
      timeout: 60_000,
      encoding: "utf-8",
      env,
      stdio,
      cwd: tmpdir(),
    })
  } else {
    execFileSync(claudeBin, ["-p", ".", "--model", "haiku"], {
      timeout: 60_000,
      encoding: "utf-8",
      env,
      stdio,
      cwd: tmpdir(),
    })
  }
}

function refreshViaCli(): void {
  const claudeBin = resolveClaudeBinary()
  const maxAttempts = 2
  for (let i = 0; i < maxAttempts; i++) {
    log("refresh_started", { source: "cli", attempt: i + 1, bin: claudeBin })
    const startedAt = Date.now()
    try {
      runClaudeRefresh(claudeBin)
      log("refresh_success", {
        source: "cli",
        // Synchronous exec blocks the entire event loop for this long.
        durationMs: Date.now() - startedAt,
      })
      return
    } catch (err) {
      const e = err as {
        stderr?: unknown
        code?: string
        status?: number
        killed?: boolean
      }
      log("refresh_failed", {
        source: "cli",
        attempt: i + 1,
        bin: claudeBin,
        code: e.code,
        status: e.status,
        killed: e.killed,
        error: err instanceof Error ? err.message : String(err),
        stderr: e.stderr ? truncate(String(e.stderr), 500) : undefined,
        durationMs: Date.now() - startedAt,
      })
      // Non-fatal: retry once, then give up
    }
  }
}

export function refreshIfNeeded(
  account?: ClaudeAccount,
): ClaudeCredentials | null {
  const target = account ?? getActiveAccount()
  if (!target) return null

  // Pick up external updates to the credential store before deciding whether a
  // refresh is needed. Claude Code rewrites the macOS keychain on its own
  // refreshes (rotating the refresh token out from under us), and
  // switch_claude_account replaces .credentials.json on Windows. Without
  // re-reading, we'd operate on a stale in-memory copy and attempt to refresh
  // with an already-invalidated refresh token — the failure mode that forces a
  // manual `claude` run. Bounded by getCachedCredentials's 30s TTL: fires at
  // most ~2x/min under load.
  try {
    const reloaded = refreshAccount(target.source)
    if (reloaded) {
      const changed = reloaded.accessToken !== target.credentials.accessToken
      const previousExpiry = target.credentials.expiresAt
      target.credentials = reloaded
      if (changed) {
        log("credentials_reloaded", {
          source: target.source,
          previousExpiry,
          newExpiry: reloaded.expiresAt,
        })
      }
    }
  } catch (err) {
    // Transient store read failure (keychain locked/denied/timeout) — fall back
    // to the in-memory copy rather than aborting the refresh path.
    log("credentials_reload_failed", {
      source: target.source,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const creds = target.credentials
  if (creds.expiresAt > Date.now() + 60_000) return creds

  log("refresh_needed", {
    source: target.source,
    expiresAt: creds.expiresAt,
    expiresIn: creds.expiresAt - Date.now(),
  })

  // Try direct OAuth refresh first (zero LLM tokens consumed)
  if (creds.refreshToken) {
    const oauthCreds = refreshViaOAuth(creds.refreshToken)
    if (oauthCreds && oauthCreds.expiresAt > Date.now() + 60_000) {
      target.credentials = oauthCreds
      writeBackCredentials(target.source, oauthCreds)
      return oauthCreds
    }
  }

  // Fall back to CLI-based refresh (consumes Haiku tokens)
  log("refresh_fallback_cli", { source: target.source })
  refreshViaCli()
  const refreshed = refreshAccount(target.source)
  if (refreshed && refreshed.expiresAt > Date.now() + 60_000) {
    target.credentials = refreshed
    return refreshed
  }

  log("refresh_exhausted", {
    source: target.source,
    hadCredentials: !!refreshed,
    expiresAt: refreshed?.expiresAt,
  })
  return null
}

/**
 * Returns the active account's credentials for auth.json sync purposes.
 * Unlike getCachedCredentials(), this does NOT trigger a refresh.
 * It returns the account's current in-memory credentials if they're still valid.
 * Returns null if no account or credentials are expired.
 */
export function getCredentialsForSync(): ClaudeCredentials | null {
  const account = getActiveAccount()
  if (!account) return null

  const creds = account.credentials
  if (creds.expiresAt > Date.now() + 60_000) {
    return creds
  }

  // Credentials are near expiry -- don't refresh here, let the per-request path handle it
  return null
}

/**
 * Drop cached credentials so the next getCachedCredentials() call re-reads the
 * store (keychain/file) and re-evaluates refresh. Used after a 401 to recover
 * from a token that was rotated externally (e.g. by an interactive Claude Code
 * run) while we held a stale in-memory copy.
 */
export function clearCredentialCache(source?: string): void {
  if (source) {
    accountCacheMap.delete(source)
  } else {
    accountCacheMap.clear()
  }
}

export function getCachedCredentials(): ClaudeCredentials | null {
  const account = getActiveAccount()
  if (!account) return null

  const now = Date.now()
  const cached = accountCacheMap.get(account.source)
  if (
    cached &&
    now - cached.cachedAt < CREDENTIAL_CACHE_TTL_MS &&
    cached.creds.expiresAt > now + 60_000
  ) {
    log("cache_hit", {
      source: account.source,
      ttlRemaining: CREDENTIAL_CACHE_TTL_MS - (now - cached.cachedAt),
    })
    return cached.creds
  }

  log("cache_miss", {
    source: account.source,
    reason: cached ? "stale or expiring" : "empty",
  })

  const fresh = refreshIfNeeded(account)
  if (!fresh) {
    log("credentials_unavailable", { source: account.source })
    accountCacheMap.delete(account.source)
    return null
  }

  accountCacheMap.set(account.source, { creds: fresh, cachedAt: now })
  return fresh
}
