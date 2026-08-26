import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { pathToFileURL } from "node:url"

// Keep the cross-process refresh lock off the real OpenCode data dir in tests.
process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR = mkdtempSync(
  join(tmpdir(), "opencode-claude-auth-v2-locktest-"),
)

const SYSTEM_IDENTITY =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK."

interface ClaudeCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

const SOURCE_FILES = [
  "v2-setup.ts",
  "index.ts",
  "betas.ts",
  "model-config.ts",
  "signing.ts",
  "transforms.ts",
  "credentials.ts",
  "refresh-backoff.ts",
  "refresh-lock.ts",
  "logger.ts",
  "http.ts",
] as const

async function copySourceFiles(tempDir: string): Promise<void> {
  await Promise.all(
    SOURCE_FILES.map(async (file) => {
      let source = await readFile(new URL(`./${file}`, import.meta.url), "utf8")
      if (file === "credentials.ts") {
        // Keep refreshViaCli from launching the real claude binary.
        source = source.replace(
          'import { execSync } from "node:child_process"',
          'import { execSync } from "./child-process.ts"',
        )
      }
      await writeFile(join(tempDir, file), source, "utf8")
    }),
  )

  await writeFile(
    join(tempDir, "child-process.ts"),
    `export function execSync() {
  return ""
}
`,
    "utf8",
  )
}

/**
 * Load a fresh, isolated copy of the v2 setup module wired to a fake
 * keychain, so every test gets pristine module state and no test ever
 * touches the real credential store.
 */
async function loadV2(initialExpiresAt: number): Promise<{
  setupModule: typeof import("./v2-setup.ts")
  keychainModule: {
    __getReadCount: () => number
    __setCredentials: (c: ClaudeCredentials) => void
  }
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "opencode-claude-auth-v2-"))
  await copySourceFiles(tempDir)
  await writeFile(
    join(tempDir, "keychain.ts"),
    `let readCount = 0
let credentials = {
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: ${initialExpiresAt}
}

export const PRIMARY_SERVICE = "Claude Code-credentials"

export function readAllClaudeAccounts() {
  readCount += 1
  return [{ label: "Account 1", source: "Claude Code-credentials", credentials }]
}

export function refreshAccount(source) {
  readCount += 1
  return credentials
}

export function writeBackCredentials() { return true }

export function buildAccountLabels(creds) {
  return creds.map((_, i) => \`Account \${i + 1}\`)
}

export function __getReadCount() {
  return readCount
}

export function __setCredentials(c) {
  credentials = c
}
`,
    "utf8",
  )

  const [setupModule, keychainModule] = await Promise.all([
    import(pathToFileURL(join(tempDir, "v2-setup.ts")).href),
    import(pathToFileURL(join(tempDir, "keychain.ts")).href),
  ])

  return {
    setupModule,
    keychainModule: keychainModule as {
      __getReadCount: () => number
      __setCredentials: (c: ClaudeCredentials) => void
    },
  }
}

type HookCallback = (evt: Record<string, unknown>) => Promise<void> | void
type TransformCallback = (draft: never) => void

interface FakeCtxOptions {
  activeConnection?: { type: "credential"; id: string; label: string }
  resolvedCredential?: { type: "key"; key: string } | { type: "oauth" }
}

function makeCtx(opts: FakeCtxOptions = {}) {
  const hooks = new Map<string, HookCallback>()
  const integrationTransforms: TransformCallback[] = []
  const catalogTransforms: TransformCallback[] = []
  const registration = { dispose: async () => {} }

  const ctx = {
    integration: {
      transform: async (cb: TransformCallback) => {
        integrationTransforms.push(cb)
        return registration
      },
      connection: {
        active: async () => opts.activeConnection,
        resolve: async () => opts.resolvedCredential,
      },
    },
    catalog: {
      transform: async (cb: TransformCallback) => {
        catalogTransforms.push(cb)
        return registration
      },
      reload: async () => {},
    },
    session: {
      hook: async (name: string, cb: HookCallback) => {
        hooks.set(name, cb)
        return registration
      },
    },
    event: {
      // Ends immediately: connection-change reactions are exercised live.
      subscribe: () => (async function* () {})(),
    },
  }

  return { ctx, hooks, integrationTransforms, catalogTransforms }
}

/** Run setup with HOME redirected so account-state writes stay in a sandbox. */
async function withSetup<T>(
  setupModule: typeof import("./v2-setup.ts"),
  ctxBundle: ReturnType<typeof makeCtx>,
  fn: () => Promise<T>,
): Promise<T> {
  const originalHome = process.env.HOME
  process.env.HOME = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
  let cleanup: (() => Promise<void>) | void
  try {
    cleanup = (await setupModule.setup(ctxBundle.ctx as never)) as
      | (() => Promise<void>)
      | void
    return await fn()
  } finally {
    if (typeof cleanup === "function") await cleanup()
    if (typeof originalHome === "string") {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
  }
}

function freshExpiry(): number {
  return Date.now() + 10 * 60 * 60 * 1000
}

function messagesRequest(body: Record<string, unknown>): Request {
  return new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      // The host's built-in anthropic plugin default — must be preserved.
      "anthropic-beta":
        "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
      "x-api-key": "stale-imported-token",
    },
    body: JSON.stringify(body),
  })
}

function requestEvt(request: Request): Record<string, unknown> {
  return {
    sessionID: "ses_test",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-sonnet-4-6" },
    request,
  }
}

describe("v2 http.request hook", () => {
  it("injects auth headers, merges betas, and rewrites the body", async () => {
    const { setupModule } = await loadV2(freshExpiry())
    const bundle = makeCtx()

    await withSetup(setupModule, bundle, async () => {
      const hook = bundle.hooks.get("http.request")
      assert.ok(hook, "http.request hook must be registered")

      const evt = requestEvt(
        messagesRequest({
          model: "claude-sonnet-4-6",
          system: [{ type: "text", text: "OpenCode system prompt" }],
          messages: [{ role: "user", content: "hello" }],
          tools: [{ name: "bash", input_schema: {} }],
        }),
      )
      await hook(evt)

      const request = evt.request as Request
      assert.equal(
        request.url,
        "https://api.anthropic.com/v1/messages?beta=true",
      )
      assert.equal(request.headers.get("authorization"), "Bearer token")
      assert.equal(request.headers.get("x-api-key"), null)
      assert.equal(request.headers.get("x-app"), "cli")
      assert.equal(request.headers.get("anthropic-version"), "2023-06-01")

      const betas = (request.headers.get("anthropic-beta") ?? "").split(",")
      // Claude Code's current beta set replaces stale host-only flags.
      assert.ok(betas.includes("interleaved-thinking-2025-05-14"))
      assert.ok(!betas.includes("fine-grained-tool-streaming-2025-05-14"))
      assert.ok(betas.includes("claude-code-20250219"))
      assert.ok(betas.includes("oauth-2025-04-20"))
      assert.ok(betas.includes("fallback-credit-2026-06-01"))
      assert.ok(betas.includes("mid-conversation-system-2026-04-07"))

      const body = JSON.parse(await request.text()) as {
        system: Array<{ type: string; text: string }>
        messages: Array<{ role: string; content: unknown }>
        tools: Array<{ name: string }>
      }
      // system[] is exactly [billing header, identity]; everything else is
      // relocated into the first user message.
      assert.equal(body.system.length, 2)
      assert.ok(body.system[0].text.startsWith("x-anthropic-billing-header"))
      assert.equal(body.system[1].text, SYSTEM_IDENTITY)
      const firstUser = body.messages.find((m) => m.role === "user")
      assert.ok(String(firstUser?.content).startsWith("OpenCode system prompt"))
      assert.equal(body.tools[0].name, "mcp_Bash")
    })
  })

  it("guarantees the identity block even when the host sends no system[]", async () => {
    const { setupModule } = await loadV2(freshExpiry())
    const bundle = makeCtx()

    await withSetup(setupModule, bundle, async () => {
      const hook = bundle.hooks.get("http.request")!
      const evt = requestEvt(
        messagesRequest({
          model: "claude-haiku-4-5",
          messages: [{ role: "user", content: "title this" }],
        }),
      )
      await hook(evt)

      const body = JSON.parse(await (evt.request as Request).text()) as {
        system: Array<{ text: string }>
      }
      assert.equal(body.system.length, 2)
      assert.ok(body.system[0].text.startsWith("x-anthropic-billing-header"))
      assert.equal(body.system[1].text, SYSTEM_IDENTITY)
    })
  })

  it("leaves non-anthropic requests untouched", async () => {
    const { setupModule } = await loadV2(freshExpiry())
    const bundle = makeCtx()

    await withSetup(setupModule, bundle, async () => {
      const hook = bundle.hooks.get("http.request")!
      const request = new Request("https://api.openai.com/v1/responses", {
        method: "POST",
        body: "{}",
      })
      const evt = {
        sessionID: "ses_test",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.6" },
        request,
      }
      await hook(evt)
      assert.equal(evt.request, request, "request must not be replaced")
    })
  })

  it("stays passive when the active anthropic connection is an API key", async () => {
    const { setupModule } = await loadV2(freshExpiry())
    const bundle = makeCtx({
      activeConnection: { type: "credential", id: "cred_1", label: "api key" },
      resolvedCredential: { type: "key", key: "sk-ant-api-key" },
    })

    await withSetup(setupModule, bundle, async () => {
      const hook = bundle.hooks.get("http.request")!
      const request = messagesRequest({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
      })
      const evt = requestEvt(request)
      await hook(evt)
      assert.equal(evt.request, request, "key mode must not rewrite requests")

      // The zero-cost override must not apply either.
      const updates: string[] = []
      const draft = {
        provider: {
          get: () => ({ provider: { id: "anthropic" }, models: new Map() }),
        },
        model: {
          update: (_p: string, m: string) => updates.push(m),
        },
      }
      for (const transform of bundle.catalogTransforms) {
        transform(draft as never)
      }
      assert.deepEqual(updates, [])
    })
  })
})

describe("v2 catalog transform", () => {
  it("zeroes anthropic model costs when a Claude Code account is active", async () => {
    const { setupModule } = await loadV2(freshExpiry())
    const bundle = makeCtx()

    await withSetup(setupModule, bundle, async () => {
      const costs = new Map<string, unknown>()
      const models = new Map([
        ["claude-sonnet-4-6", {}],
        ["claude-haiku-4-5", {}],
      ])
      const draft = {
        provider: {
          get: (id: string) =>
            id === "anthropic"
              ? { provider: { id: "anthropic" }, models }
              : undefined,
        },
        model: {
          update: (
            providerID: string,
            modelID: string,
            update: (model: { cost: unknown }) => void,
          ) => {
            assert.equal(providerID, "anthropic")
            const model = { cost: [{ input: 3, output: 15 }] }
            update(model)
            costs.set(modelID, model.cost)
          },
        },
      }
      for (const transform of bundle.catalogTransforms) {
        transform(draft as never)
      }
      assert.deepEqual(costs.get("claude-sonnet-4-6"), [])
      assert.deepEqual(costs.get("claude-haiku-4-5"), [])
    })
  })
})

describe("v2 integration method", () => {
  it("registers a refresh-less claude-code oauth method whose authorize maps store credentials", async () => {
    const now = Date.now()
    const { setupModule } = await loadV2(now + 10 * 60 * 60 * 1000 + 0.5)
    const bundle = makeCtx()

    await withSetup(setupModule, bundle, async () => {
      interface Registered {
        integrationID: string
        method: { id: string; type: string; label: string }
        refresh?: unknown
        authorize: (answer: Record<string, unknown>) => Promise<{
          url: string
          instructions: string
          mode: string
          callback: Promise<{
            type: string
            methodID: string
            access: string
            refresh: string
            expires: number
            metadata?: Record<string, unknown>
          }>
        }>
        label?: (credential: {
          metadata?: Record<string, unknown>
        }) => string | undefined
      }
      const updates: Registered[] = []
      const draft = {
        method: { update: (input: Registered) => updates.push(input) },
      }
      for (const transform of bundle.integrationTransforms) {
        transform(draft as never)
      }

      assert.equal(updates.length, 1)
      const registered = updates[0]
      assert.equal(registered.integrationID, "anthropic")
      assert.equal(registered.method.id, "claude-code")
      assert.equal(registered.method.type, "oauth")
      assert.equal(
        registered.refresh,
        undefined,
        "the plugin owns refresh; the host must never rotate our tokens",
      )

      const authorization = await registered.authorize({})
      assert.equal(authorization.mode, "auto")
      assert.ok(authorization.instructions.includes("Account 1"))

      const credential = await authorization.callback
      assert.equal(credential.type, "oauth")
      assert.equal(credential.methodID, "claude-code")
      assert.equal(credential.access, "token")
      assert.equal(credential.refresh, "refresh")
      assert.equal(
        credential.expires,
        Math.floor(now + 10 * 60 * 60 * 1000 + 0.5),
        "expires must be floored to an integer",
      )
      assert.equal(
        registered.label?.({ metadata: credential.metadata }),
        "Account 1",
      )
    })
  })
})

describe("v2 http.response hook", () => {
  it("retries a 401 once with an externally rotated token and swaps the response", async () => {
    const originalFetch = globalThis.fetch
    const { setupModule, keychainModule } = await loadV2(freshExpiry())
    const bundle = makeCtx()

    const retryAuthHeaders: string[] = []
    try {
      await withSetup(setupModule, bundle, async () => {
        const requestHook = bundle.hooks.get("http.request")!
        const responseHook = bundle.hooks.get("http.response")!

        const evt = requestEvt(
          messagesRequest({
            model: "claude-sonnet-4-6",
            messages: [{ role: "user", content: "hello" }],
          }),
        )
        await requestHook(evt)

        // Another process rotates the shared store after the request went out.
        keychainModule.__setCredentials({
          accessToken: "rotated-token",
          refreshToken: "rotated-refresh",
          expiresAt: freshExpiry(),
        })

        globalThis.fetch = (async (
          _input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          retryAuthHeaders.push(
            new Headers(init?.headers).get("authorization") ?? "",
          )
          return new Response("data: {}\n\n", { status: 200 })
        }) as typeof fetch

        const responseEvt = {
          ...evt,
          response: new Response('{"error":"expired"}', { status: 401 }),
        }
        await responseHook(responseEvt)

        const response = responseEvt.response as Response
        assert.equal(response.status, 200)
        assert.deepEqual(retryAuthHeaders, ["Bearer rotated-token"])
        assert.equal(await response.text(), "data: {}\n\n")
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("surfaces the 401 unchanged when recovery cannot progress", async () => {
    const originalFetch = globalThis.fetch
    const { setupModule } = await loadV2(freshExpiry())
    const bundle = makeCtx()

    let apiRetries = 0
    try {
      await withSetup(setupModule, bundle, async () => {
        const requestHook = bundle.hooks.get("http.request")!
        const responseHook = bundle.hooks.get("http.response")!

        const evt = requestEvt(
          messagesRequest({
            model: "claude-sonnet-4-6",
            messages: [{ role: "user", content: "hello" }],
          }),
        )
        await requestHook(evt)

        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : String(input)
          if (url.includes("/oauth/token")) {
            // retry-after beyond the 30s cap makes fetchWithRetry return
            // instead of backing off, so the forced refresh fails fast.
            return new Response('{"error":"rate_limited"}', {
              status: 429,
              headers: { "retry-after": "3600" },
            })
          }
          apiRetries += 1
          return new Response("should not be reached", { status: 200 })
        }) as typeof fetch

        const errorBody = '{"error":{"type":"authentication_error"}}'
        const original = new Response(errorBody, {
          status: 401,
          headers: { "x-request-id": "unchanged-401" },
        })
        const responseEvt = { ...evt, response: original }
        await responseHook(responseEvt)

        const response = responseEvt.response as Response
        assert.equal(response.status, 401)
        assert.equal(response.headers.get("x-request-id"), "unchanged-401")
        assert.equal(await response.text(), errorBody)
        assert.equal(apiRetries, 0, "no retry without a different token")
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("strips mcp_ tool-name prefixes from the response stream", async () => {
    const { setupModule } = await loadV2(freshExpiry())
    const bundle = makeCtx()

    await withSetup(setupModule, bundle, async () => {
      const requestHook = bundle.hooks.get("http.request")!
      const responseHook = bundle.hooks.get("http.response")!

      const evt = requestEvt(
        messagesRequest({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hello" }],
          tools: [{ name: "bash", input_schema: {} }],
        }),
      )
      await requestHook(evt)

      const sse =
        'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Bash"}}\n\n'
      const responseEvt = {
        ...evt,
        response: new Response(sse, { status: 200 }),
      }
      await responseHook(responseEvt)

      const text = await (responseEvt.response as Response).text()
      assert.ok(text.includes('"name": "bash"'), `got: ${text}`)
      assert.ok(!text.includes("mcp_Bash"))
    })
  })

  it("ignores responses for requests it did not rewrite", async () => {
    const { setupModule } = await loadV2(freshExpiry())
    const bundle = makeCtx()

    await withSetup(setupModule, bundle, async () => {
      const responseHook = bundle.hooks.get("http.response")!
      const untouched = new Response('{"name":"mcp_Bash"}', { status: 200 })
      const responseEvt = {
        sessionID: "ses_test",
        agent: "build",
        model: { providerID: "anthropic", id: "claude-sonnet-4-6" },
        request: new Request("https://api.anthropic.com/v1/messages"),
        response: untouched,
      }
      await responseHook(responseEvt)
      assert.equal(responseEvt.response, untouched)
    })
  })
})
