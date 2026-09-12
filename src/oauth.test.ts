import assert from "node:assert/strict"
import { Server } from "node:http"
import { test } from "node:test"
import {
  OAUTH_AUTHORIZE_URL,
  OAUTH_CLIENT_ID,
  OAUTH_MANUAL_REDIRECT_URL,
  OAUTH_METHOD_ID,
  OAUTH_SCOPES,
  OAUTH_TOKEN_URL,
  createAuthorizationRequest,
  authorize,
  exchangeAuthorizationCode,
  refreshCredential,
} from "./oauth.ts"

const environments: {
  name: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  loginMode?: string
  listenerUnavailable?: boolean
  expected: "auto" | "code"
}[] = [
  {
    name: "SSH connection",
    platform: "darwin",
    env: { SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" },
    expected: "code",
  },
  {
    name: "SSH client with a display",
    platform: "linux",
    env: { SSH_CLIENT: "192.0.2.1 50000 22", DISPLAY: ":0" },
    expected: "code",
  },
  {
    name: "SSH terminal",
    platform: "darwin",
    env: { SSH_TTY: "/dev/pts/1" },
    expected: "code",
  },
  { name: "headless Linux", platform: "linux", env: {}, expected: "code" },
  {
    name: "X11 desktop",
    platform: "linux",
    env: { DISPLAY: ":0" },
    expected: "auto",
  },
  {
    name: "Wayland desktop",
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0" },
    expected: "auto",
  },
  { name: "macOS desktop", platform: "darwin", env: {}, expected: "auto" },
  { name: "Windows desktop", platform: "win32", env: {}, expected: "auto" },
  {
    name: "manual override on desktop",
    platform: "darwin",
    env: {},
    loginMode: "manual",
    expected: "code",
  },
  {
    name: "local override over SSH",
    platform: "linux",
    env: { SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" },
    loginMode: "local",
    expected: "auto",
  },
  {
    name: "callback listener unavailable",
    platform: "darwin",
    env: {},
    listenerUnavailable: true,
    expected: "code",
  },
]

for (const scenario of environments) {
  test(`authorization mode: ${scenario.name}`, async (t) => {
    if (scenario.listenerUnavailable) {
      t.mock.method(Server.prototype, "listen", () => {
        throw new Error("Cannot bind callback listener")
      })
    }
    const previousEnv = process.env
    const previousPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    )!
    process.env = { ...previousEnv }
    for (const key of [
      "SSH_CONNECTION",
      "SSH_CLIENT",
      "SSH_TTY",
      "DISPLAY",
      "WAYLAND_DISPLAY",
    ]) {
      delete process.env[key]
    }
    Object.assign(process.env, scenario.env)
    Object.defineProperty(process, "platform", { value: scenario.platform })
    try {
      const result = await authorize(
        scenario.loginMode ? { loginMode: scenario.loginMode } : {},
      )
      const url = new URL(result.url)
      const redirect = url.searchParams.get("redirect_uri")!
      if (result.mode === "auto") {
        // Exercise the listener and settle it even when mode selection regresses.
        const rejected = assert.rejects(result.callback, /Invalid OAuth state/)
        const callback = new URL(redirect)
        callback.searchParams.set("code", "test-code")
        callback.searchParams.set("state", "wrong-state")
        const response = await fetch(callback)
        assert.equal(response.status, 400)
        await rejected
        assert.match(redirect, /^http:\/\/localhost:\d+\/callback$/)
      } else {
        assert.equal(redirect, OAUTH_MANUAL_REDIRECT_URL)
        await assert.rejects(
          result.callback("test-code#wrong-state"),
          /Invalid OAuth state/,
        )
      }
      assert.equal(result.mode, scenario.expected)
    } finally {
      process.env = previousEnv
      Object.defineProperty(process, "platform", previousPlatform)
    }
  })
}

test("pasted code#state exchanges only the code with the hosted redirect", async () => {
  const request = createAuthorizationRequest()
  let capturedBody = ""
  await exchangeAuthorizationCode(
    `  authorization-code#${request.state}\n`,
    request,
    async (_input, init) => {
      capturedBody = String(init?.body)
      return Response.json({ access_token: "access", refresh_token: "refresh" })
    },
  )
  const body = JSON.parse(capturedBody)
  assert.equal(body.code, "authorization-code")
  assert.equal(body.state, request.state)
  assert.equal(body.redirect_uri, OAUTH_MANUAL_REDIRECT_URL)
  assert.equal(body.code_verifier, request.verifier)
})

test("pasted code with a different state is rejected before token exchange", async () => {
  let exchanged = false
  await assert.rejects(
    exchangeAuthorizationCode(
      "authorization-code#different-state",
      createAuthorizationRequest(),
      async () => {
        exchanged = true
        return Response.json({
          access_token: "access",
          refresh_token: "refresh",
        })
      },
    ),
    /Invalid OAuth state/,
  )
  assert.equal(exchanged, false)
})

test("empty codes and malformed state suffixes are rejected before token exchange", async () => {
  const request = createAuthorizationRequest()
  for (const code of [
    " ",
    `#${request.state}`,
    "code#",
    `code#${request.state}#extra`,
  ]) {
    await assert.rejects(
      exchangeAuthorizationCode(code, request, async () => {
        assert.fail("Invalid input must not reach the token endpoint")
      }),
      /Missing authorization code|Invalid OAuth state/,
    )
  }
})

test("createAuthorizationRequest builds a PKCE authorization URL", () => {
  const request = createAuthorizationRequest("http://localhost:1234/callback")
  const url = new URL(request.url)
  assert.equal(url.origin + url.pathname, OAUTH_AUTHORIZE_URL)
  assert.equal(url.searchParams.get("client_id"), OAUTH_CLIENT_ID)
  assert.equal(url.searchParams.get("redirect_uri"), request.redirectUri)
  assert.equal(url.searchParams.get("scope"), OAUTH_SCOPES)
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  assert.equal(url.searchParams.get("state"), request.state)
  assert.ok(url.searchParams.get("code_challenge"))
  assert.ok(request.verifier)
})

test("exchangeAuthorizationCode returns a native OpenCode credential", async () => {
  let capturedURL = ""
  let capturedBody = ""
  const credential = await exchangeAuthorizationCode(
    "authorization-code",
    {
      verifier: "verifier",
      redirectUri: "http://localhost:1234/callback",
      state: "state",
    },
    async (input, init) => {
      capturedURL = String(input)
      capturedBody = String(init?.body)
      return new Response(
        JSON.stringify({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
        }),
      )
    },
  )

  assert.equal(capturedURL, OAUTH_TOKEN_URL)
  assert.deepEqual(JSON.parse(capturedBody), {
    grant_type: "authorization_code",
    code: "authorization-code",
    state: "state",
    code_verifier: "verifier",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: "http://localhost:1234/callback",
  })
  assert.equal(credential.type, "oauth")
  assert.equal(credential.methodID, OAUTH_METHOD_ID)
  assert.equal(credential.access, "access")
  assert.equal(credential.refresh, "refresh")
  assert.ok(credential.expires > Date.now())
})

test("refreshCredential preserves a non-rotated refresh token and metadata", async () => {
  const credential = await refreshCredential(
    {
      type: "oauth",
      methodID: OAUTH_METHOD_ID as never,
      access: "old-access",
      refresh: "old-refresh",
      expires: 1,
      metadata: { label: "Work" },
    },
    async () =>
      new Response(
        JSON.stringify({ access_token: "new-access", expires_in: 3600 }),
      ),
  )

  assert.equal(credential.access, "new-access")
  assert.equal(credential.refresh, "old-refresh")
  assert.deepEqual(credential.metadata, { label: "Work" })
})
