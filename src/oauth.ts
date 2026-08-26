import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { request as httpsRequest } from "node:https"
import type { Credential } from "@opencode-ai/plugin"
import { config } from "./model-config.ts"

export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
export const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
export const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
export const OAUTH_MANUAL_REDIRECT_URL =
  "https://platform.claude.com/oauth/code/callback"
export const OAUTH_SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
export const OAUTH_METHOD_ID = "claude-subscription"

type Fetch = typeof fetch

interface TokenResult {
  status: number
  body: string
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  expires_at?: number
}

interface Pkce {
  verifier: string
  challenge: string
  state: string
}

interface AuthorizationRequest extends Pkce {
  url: string
  redirectUri: string
}

function pkce(): Pkce {
  const verifier = randomBytes(64).toString("base64url")
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  }
}

export function createAuthorizationRequest(
  redirectUri = OAUTH_MANUAL_REDIRECT_URL,
): AuthorizationRequest {
  const proof = pkce()
  const query = new URLSearchParams({
    code: "true",
    client_id: OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES,
    code_challenge: proof.challenge,
    code_challenge_method: "S256",
    state: proof.state,
  })
  return {
    ...proof,
    redirectUri,
    url: `${OAUTH_AUTHORIZE_URL}?${query}`,
  }
}

function expires(data: TokenResponse): number {
  const now = Date.now()
  if (typeof data.expires_at === "number" && data.expires_at > now) {
    return Math.trunc(data.expires_at)
  }
  return Math.trunc(now + (data.expires_in ?? 36_000) * 1000)
}

async function token(
  body: Record<string, string>,
  fetcher?: Fetch,
): Promise<TokenResponse> {
  const result = fetcher
    ? await fetchToken(fetcher, body)
    : await requestToken(body)
  if (result.status < 200 || result.status >= 300) {
    let detail = result.body
    try {
      const parsed = JSON.parse(result.body) as {
        error?: string | { message?: string; type?: string }
        error_description?: string
      }
      detail =
        parsed.error_description ??
        (typeof parsed.error === "string"
          ? parsed.error
          : (parsed.error?.message ?? parsed.error?.type)) ??
        result.body
    } catch {}
    throw new Error(
      `Anthropic OAuth token exchange failed (${result.status}): ${detail}`,
    )
  }
  const data = JSON.parse(result.body) as TokenResponse
  if (!data.access_token) {
    throw new Error(
      "Anthropic OAuth token response did not include an access token",
    )
  }
  return data
}

async function fetchToken(
  fetcher: Fetch,
  body: Record<string, string>,
): Promise<TokenResult> {
  const response = await fetcher(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": `claude-cli/${config.ccVersion} (external, sdk-cli)`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  return { status: response.status, body: await response.text() }
}

function requestToken(body: Record<string, string>): Promise<TokenResult> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      OAUTH_TOKEN_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "User-Agent": `claude-cli/${config.ccVersion} (external, sdk-cli)`,
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        })
      },
    )
    request.setTimeout(30_000, () => {
      request.destroy(new Error("Anthropic OAuth token request timed out"))
    })
    request.on("error", (cause) => {
      reject(
        new Error(`Anthropic OAuth token request failed: ${cause.message}`),
      )
    })
    request.end(payload)
  })
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

export async function exchangeAuthorizationCode(
  code: string,
  request: Pick<AuthorizationRequest, "verifier" | "redirectUri" | "state">,
  fetcher?: Fetch,
): Promise<Credential.OAuth> {
  const data = await token(
    {
      grant_type: "authorization_code",
      code: code.trim(),
      state: request.state,
      code_verifier: request.verifier,
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: request.redirectUri,
    },
    fetcher,
  )
  if (!data.refresh_token) {
    throw new Error(
      "Anthropic OAuth token response did not include a refresh token",
    )
  }
  return {
    type: "oauth",
    methodID: OAUTH_METHOD_ID as Credential.OAuth["methodID"],
    access: data.access_token,
    refresh: data.refresh_token,
    expires: expires(data),
  }
}

export async function refreshCredential(
  credential: Credential.OAuth,
  fetcher?: Fetch,
): Promise<Credential.OAuth> {
  const data = await token(
    {
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: OAUTH_CLIENT_ID,
    },
    fetcher,
  )
  return {
    ...credential,
    access: data.access_token,
    refresh: data.refresh_token ?? credential.refresh,
    expires: expires(data),
  }
}

export async function authorize(): Promise<
  | {
      mode: "auto"
      url: string
      instructions: string
      callback: Promise<Credential.OAuth>
    }
  | {
      mode: "code"
      url: string
      instructions: string
      callback: (code: string) => Promise<Credential.OAuth>
    }
> {
  try {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "localhost", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") {
      server.close()
      throw new Error("Could not determine the OAuth callback port")
    }

    const request = createAuthorizationRequest(
      `http://localhost:${address.port}/callback`,
    )
    const callback = new Promise<Credential.OAuth>((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          server.close()
          reject(
            new Error("Anthropic OAuth callback timed out after 5 minutes"),
          )
        },
        5 * 60 * 1000,
      )
      timeout.unref()

      server.on("request", async (incoming, response) => {
        const url = new URL(
          incoming.url ?? "/",
          `http://localhost:${address.port}`,
        )
        if (url.pathname !== "/callback") {
          response.writeHead(404).end("Not found")
          return
        }
        const error =
          url.searchParams.get("error_description") ??
          url.searchParams.get("error")
        const code = url.searchParams.get("code")
        if (error || !code || url.searchParams.get("state") !== request.state) {
          const message =
            error ??
            (code ? "Invalid OAuth state" : "Missing authorization code")
          response
            .writeHead(400, { "Content-Type": "text/html" })
            .end(`<h2>Authorization failed</h2><p>${message}</p>`)
          clearTimeout(timeout)
          server.close()
          reject(new Error(message))
          return
        }
        clearTimeout(timeout)
        try {
          const credential = await exchangeAuthorizationCode(code, request)
          response
            .writeHead(200, { "Content-Type": "text/html" })
            .end(
              "<h2>Authorization successful</h2><p>You can close this window and return to OpenCode.</p>",
            )
          resolve(credential)
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          response
            .writeHead(502, { "Content-Type": "text/html" })
            .end(
              `<h2>Authorization failed</h2><p>${escapeHtml(message)}</p><p>Return to OpenCode and try again.</p>`,
            )
          reject(cause)
        } finally {
          server.close()
        }
      })
    })

    return {
      mode: "auto",
      url: request.url,
      instructions:
        "Complete authorization in your browser. This window will close automatically.",
      callback,
    }
  } catch {
    const request = createAuthorizationRequest()
    return {
      mode: "code",
      url: request.url,
      instructions:
        "Complete authorization in your browser, then paste the authorization code.",
      callback: (code) => exchangeAuthorizationCode(code, request),
    }
  }
}
