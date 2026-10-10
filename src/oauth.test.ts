import assert from "node:assert/strict"
import { Server } from "node:http"
import { test, type TestContext } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Credential, Plugin } from "@opencode/plugin"
import { createCredentialRefresher } from "./oauth-refresh.ts"
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

function refreshStorage(): Plugin.Context["storage"] {
  const entries = new Map<
    string,
    Parameters<Plugin.Context["storage"]["set"]>[1]
  >()
  return {
    get: async (key) => entries.get(key),
    set: async (key, value) => {
      entries.set(key, value)
    },
    remove: async (key) => {
      entries.delete(key)
    },
    scan: async ({ prefix }) => ({
      entries: [...entries]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    }),
  }
}

function refreshDirectory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "claude-oauth-refresh-"))
  const previousDir = process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR
  process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR = dir
  t.after(() => {
    if (previousDir === undefined) {
      delete process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR
    } else {
      process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR = previousDir
    }
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

test("concurrent refreshes of a rotating token share one exchange", async (t) => {
  refreshDirectory(t)
  const credential = {
    type: "oauth" as const,
    methodID: OAUTH_METHOD_ID as never,
    access: "concurrent-old-access",
    refresh: "concurrent-old-refresh",
    expires: 1,
  }
  let calls = 0
  const fetcher: typeof fetch = async () => {
    if (++calls > 1) {
      return Response.json(
        { error: "Refresh token not found or invalid" },
        { status: 400 },
      )
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    return Response.json({
      access_token: "concurrent-new-access",
      refresh_token: "concurrent-new-refresh",
      expires_in: 3600,
    })
  }
  const storage = refreshStorage()
  const options = {
    storage,
    refresh: (value: typeof credential) => refreshCredential(value, fetcher),
  }
  // Separate plugin instances share the database, not closure state.
  const foreground = createCredentialRefresher(options)
  const background = createCredentialRefresher(options)
  t.after(() => {
    foreground.dispose()
    background.dispose()
  })
  const results = await Promise.all([
    foreground.refresh(credential),
    background.refresh({ ...credential }),
  ])
  assert.equal(calls, 1)
  assert.deepEqual(results[0], results[1])
})

test("a stale snapshot adopts the winning refresh without copying account metadata", async (t) => {
  refreshDirectory(t)
  let calls = 0
  const storage = refreshStorage()
  const refresher = createCredentialRefresher({
    storage,
    refresh: async (credential) => {
      calls++
      return {
        ...credential,
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 3600_000,
      }
    },
  })
  t.after(() => refresher.dispose())
  const credential: Credential.OAuth = {
    type: "oauth",
    methodID: OAUTH_METHOD_ID as never,
    access: "stale-access",
    refresh: "stale-refresh",
    expires: 1,
    metadata: { label: "Work" },
  }
  await refresher.refresh(credential)
  const value = await refresher.refresh({
    ...credential,
    metadata: { label: "Another label" },
  })
  assert.equal(calls, 1)
  assert.equal(value.refresh, "rotated-refresh")
  assert.deepEqual(value.metadata, { label: "Another label" })
  const entries = await storage.scan({ prefix: "oauth-refresh/" })
  assert.equal(entries.entries.length, 1)
  assert.ok(!entries.entries[0].key.includes(credential.refresh))
  assert.ok(!JSON.stringify(entries).includes("Work"))
})

test("failed exchanges release the lock and do not cache an invalid token", async (t) => {
  refreshDirectory(t)
  const storage = refreshStorage()
  let fail = true
  const refresher = createCredentialRefresher({
    storage,
    refresh: async (credential) => {
      if (fail) throw new Error("Refresh token not found or invalid")
      return { ...credential, expires: Date.now() + 3600_000 }
    },
  })
  t.after(() => refresher.dispose())
  const credential: Credential.OAuth = {
    type: "oauth",
    methodID: OAUTH_METHOD_ID as never,
    access: "failed-access",
    refresh: "failed-refresh",
    expires: 1,
  }
  await assert.rejects(refresher.refresh(credential), /not found or invalid/)
  assert.deepEqual(await storage.scan({ prefix: "oauth-refresh/" }), {
    entries: [],
  })
  fail = false
  assert.ok((await refresher.refresh(credential)).expires > Date.now())
})

test("expired shared results are removed instead of overwriting a newer refresh", async (t) => {
  refreshDirectory(t)
  const storage = refreshStorage()
  const refresher = createCredentialRefresher({
    storage,
    refresh: async (credential) => ({
      ...credential,
      access: "newer-access",
      refresh: "newer-refresh",
      expires: Date.now() + 3600_000,
    }),
  })
  t.after(() => refresher.dispose())
  const credential: Credential.OAuth = {
    type: "oauth",
    methodID: OAUTH_METHOD_ID as never,
    access: "old-access",
    refresh: "old-refresh",
    expires: 1,
  }
  await refresher.refresh(credential)
  const { entries } = await storage.scan({ prefix: "oauth-refresh/" })
  const key = entries[0].key
  await storage.set(key, {
    access: "expired-result",
    refresh: "spent-refresh",
    expires: Date.now() + 3600_000,
    validUntil: 1,
  })
  assert.equal((await refresher.refresh(credential)).access, "newer-access")
  await storage.set("oauth-refresh/obsolete", {
    access: "expired-access",
    refresh: "expired-refresh",
    expires: 1,
    validUntil: 1,
  })
  await refresher.refresh(credential)
  assert.equal(await storage.get("oauth-refresh/obsolete"), undefined)
})

test("shared token results are deleted after their handoff window", async (t) => {
  refreshDirectory(t)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  const storage = refreshStorage()
  const refresher = createCredentialRefresher({
    storage,
    refresh: async (credential) => ({
      ...credential,
      expires: Date.now() + 3600_000,
    }),
  })
  t.after(() => refresher.dispose())
  await refresher.refresh({
    type: "oauth",
    methodID: OAUTH_METHOD_ID as never,
    access: "handoff-access",
    refresh: "handoff-refresh",
    expires: 1,
  })
  assert.equal(
    (await storage.scan({ prefix: "oauth-refresh/" })).entries.length,
    1,
  )
  t.mock.timers.tick(60_002)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(await storage.scan({ prefix: "oauth-refresh/" }), {
    entries: [],
  })
})

test("separate server processes share one rotating-token exchange", async (t) => {
  refreshDirectory(t)
  const storage = refreshStorage()
  let exchanges = 0
  const worker = `
    import { createCredentialRefresher } from ${JSON.stringify(new URL("./oauth-refresh.ts", import.meta.url).href)}
    import { refreshCredential, OAUTH_METHOD_ID } from ${JSON.stringify(new URL("./oauth.ts", import.meta.url).href)}
    let seq = 0
    const pending = new Map()
    process.on('message', ({ id, value }) => {
      pending.get(id)(value)
      pending.delete(id)
    })
    const rpc = (op, params = {}) => new Promise(resolve => {
      const id = ++seq
      pending.set(id, resolve)
      process.send({ id, op, ...params })
    })
    const storage = {
      get: key => rpc('get', { key }),
      set: (key, value) => rpc('set', { key, value }),
      remove: key => rpc('remove', { key }),
      scan: options => rpc('scan', { options }),
    }
    const refresher = createCredentialRefresher({
      storage,
      refresh: credential => refreshCredential(credential, async () => {
        const response = await rpc('exchange')
        return Response.json(response.body, { status: response.status })
      }),
    })
    try {
      const result = await refresher.refresh({
        type: 'oauth', methodID: OAUTH_METHOD_ID, access: 'process-old-access',
        refresh: 'process-old-refresh', expires: 1,
      })
      if (result.refresh !== 'process-new-refresh') throw new Error('Wrong result')
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    } finally {
      refresher.dispose()
      process.disconnect()
    }
  `
  await Promise.all(
    [1, 2].map(
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--experimental-strip-types", "--input-type=module", "-e", worker],
            { stdio: ["ignore", "ignore", "pipe", "ipc"] },
          )
          t.after(() => {
            if (child.exitCode === null) child.kill()
          })
          let stderr = ""
          child.stderr!.on("data", (chunk) => (stderr += String(chunk)))
          child.once("error", reject)
          child.once("exit", (code) => {
            if (code === 0) resolve()
            else reject(new Error(`Refresh worker failed (${code}): ${stderr}`))
          })
          child.on("message", async (message) => {
            const input = message as {
              id: number
              op: string
              key: string
              value: Parameters<typeof storage.set>[1]
              options: Parameters<typeof storage.scan>[0]
            }
            let value: unknown
            switch (input.op) {
              case "get":
                value = await storage.get(input.key)
                break
              case "set":
                value = await storage.set(input.key, input.value)
                break
              case "remove":
                value = await storage.remove(input.key)
                break
              case "scan":
                value = await storage.scan(input.options)
                break
              case "exchange":
                value =
                  ++exchanges === 1
                    ? {
                        status: 200,
                        body: {
                          access_token: "process-new-access",
                          refresh_token: "process-new-refresh",
                          expires_in: 3600,
                        },
                      }
                    : {
                        status: 400,
                        body: { error: "Refresh token not found or invalid" },
                      }
                await new Promise<void>((done) => setTimeout(done, 100))
                break
              default:
                reject(new Error(`Unexpected worker operation: ${input.op}`))
                return
            }
            child.send({ id: input.id, value })
          })
        }),
    ),
  )
  assert.equal(exchanges, 1)
})
