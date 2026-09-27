import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
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
  "oauth.ts",
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
  "usage-limit.ts",
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
  events?: Array<
    | { type: "credential.updated"; data: Record<string, never> }
    | {
        type: "credential.switched"
        data: { integrationID: string; credentialID: string | null }
      }
  >
  resolvedCredential?:
    | { type: "key"; key: string }
    | {
        type: "oauth"
        methodID: string
        access: string
        refresh: string
        expires: number
      }
}

function makeCtx(opts: FakeCtxOptions = {}) {
  const hooks = new Map<string, HookCallback>()
  const integrationTransforms: TransformCallback[] = []
  const modelTransforms: TransformCallback[] = []
  let modelReloads = 0
  let eventSubscriptions = 0
  const registration = { dispose: async () => {} }
  const rpcEvents: Array<{ name: string; data: unknown }> = []
  const rpcHandlers = new Map<string, () => Promise<unknown>>()

  const ctx = {
    integration: {
      transform: async (cb: TransformCallback) => {
        integrationTransforms.push(cb)
        return registration
      },
      connection: {
        active: async () =>
          opts.activeConnection ?? {
            type: "credential",
            id: "cred_subscription",
            label: "Claude subscription",
          },
        resolve: async () =>
          opts.resolvedCredential ?? {
            type: "oauth",
            methodID: "claude-subscription",
            access: "token",
            refresh: "refresh",
            expires: freshExpiry(),
          },
      },
    },
    model: {
      transform: async (cb: TransformCallback) => {
        modelTransforms.push(cb)
        return registration
      },
      reload: async () => {
        modelReloads++
      },
    },
    session: {
      hook: async (name: string, cb: HookCallback) => {
        hooks.set(name, cb)
        return registration
      },
    },
    event: {
      subscribe: () => {
        const events = eventSubscriptions++ === 0 ? (opts.events ?? []) : []
        return (async function* () {
          yield* events
        })()
      },
    },
    rpc: {
      register: async (
        definition: { id: string },
        handlers: Record<string, () => Promise<unknown>>,
      ) => {
        for (const [name, handler] of Object.entries(handlers)) {
          rpcHandlers.set(`${definition.id}.${name}`, handler)
        }
        return {
          ...registration,
          events: {
            emit: async (name: string, data: unknown) => {
              rpcEvents.push({ name, data })
            },
          },
        }
      },
    },
  }

  return {
    ctx,
    hooks,
    rpcEvents,
    rpcHandlers,
    integrationTransforms,
    modelTransforms,
    modelReloads: () => modelReloads,
  }
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
  it("uses a stable Claude session ID per OpenCode session and credential", async () => {
    const { setupModule } = await loadV2(freshExpiry())
    const bundle = makeCtx()

    await withSetup(setupModule, bundle, async () => {
      const hook = bundle.hooks.get("http.request")!
      const makeEvent = (sessionID: string) => ({
        ...requestEvt(
          messagesRequest({
            model: "claude-opus-5",
            messages: [{ role: "user", content: "hello" }],
          }),
        ),
        sessionID,
      })
      const first = makeEvent("ses_first")
      const same = makeEvent("ses_first")
      const other = makeEvent("ses_other")

      await hook(first)
      await hook(same)
      await hook(other)

      const header = (event: Record<string, unknown>) =>
        (event.request as Request).headers.get("x-claude-code-session-id")
      assert.match(
        header(first) ?? "",
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
      assert.equal(header(first), header(same))
      assert.notEqual(header(first), header(other))
    })
  })

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
        update: (_p: string, m: string) => updates.push(m),
      }
      for (const transform of bundle.modelTransforms) {
        transform(draft as never)
      }
      assert.deepEqual(updates, [])
    })
  })
})

describe("v2 model transform", () => {
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
      }
      for (const transform of bundle.modelTransforms) {
        transform(draft as never)
      }
      assert.deepEqual(costs.get("claude-sonnet-4-6"), [])
      assert.deepEqual(costs.get("claude-haiku-4-5"), [])
    })
  })

  it("reloads model costs when the active anthropic credential changes", async () => {
    const { setupModule } = await loadV2(freshExpiry())
    const bundle = makeCtx({
      events: [
        {
          type: "credential.switched",
          data: {
            integrationID: "anthropic",
            credentialID: "cred_subscription",
          },
        },
      ],
    })

    await withSetup(setupModule, bundle, async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(bundle.modelReloads(), 1)
    })
  })
})

describe("v2 integration method", () => {
  it("registers direct subscription authorization and refresh", async () => {
    const { setupModule } = await loadV2(freshExpiry())
    const bundle = makeCtx()

    await withSetup(setupModule, bundle, async () => {
      interface Registered {
        integrationID: string
        method: {
          id: string
          type: string
          label: string
          form: { key: string; default: string; options: { value: string }[] }[]
        }
        refresh?: (credential: unknown) => Promise<unknown>
        authorize: (answer: Record<string, unknown>) => Promise<unknown>
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
      assert.equal(registered.method.id, "claude-subscription")
      assert.equal(registered.method.type, "oauth")
      assert.equal(registered.method.label, "Claude Pro/Max subscription")
      assert.equal(registered.method.form[0].key, "loginMode")
      assert.equal(registered.method.form[0].default, "auto")
      assert.deepEqual(
        registered.method.form[0].options.map((option) => option.value),
        ["auto", "manual", "local"],
      )
      assert.equal(typeof registered.authorize, "function")
      const authorization = (await registered.authorize({
        loginMode: "manual",
      })) as { mode: string; url: string }
      assert.equal(authorization.mode, "code")
      assert.equal(
        new URL(authorization.url).searchParams.get("redirect_uri"),
        "https://platform.claude.com/oauth/code/callback",
      )
      assert.equal(typeof registered.refresh, "function")
      assert.equal(registered.label?.({}), "Claude subscription")
    })
  })
})

describe("v2 http.response hook", () => {
  it("surfaces a 401 unchanged", async () => {
    const { setupModule } = await loadV2(freshExpiry())
    const bundle = makeCtx()

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
    })
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

async function lastContent(evt: Record<string, unknown>) {
  const body = JSON.parse(await (evt.request as Request).text()) as {
    messages: Array<{ content: Array<{ type: string; text?: string }> }>
  }
  return body.messages.at(-1)!.content
}

describe("v2 usage-limit wrap-up", () => {
  it("logs session-correlated quota evidence without secret response headers", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "claude-quota-log-"))
    const logPath = join(logDir, "diagnostics.log")
    const previous = process.env.CLAUDE_AUTH_DEBUG
    process.env.CLAUDE_AUTH_DEBUG = logPath
    try {
      const { setupModule } = await loadV2(freshExpiry())
      const bundle = makeCtx()
      await withSetup(setupModule, bundle, async () => {
        const evt = {
          ...requestEvt(
            messagesRequest({
              model: "claude-opus-5-5",
              messages: [{ role: "user", content: "hello" }],
            }),
          ),
          kind: "primary",
        }
        await bundle.hooks.get("http.request")!(evt)
        await bundle.hooks.get("http.response")!({
          ...evt,
          response: new Response("", {
            headers: {
              "anthropic-ratelimit-unified-status": "allowed",
              "anthropic-ratelimit-unified-grace-5h-utilization": "0.12",
              "anthropic-ratelimit-unified-overage-in-use": "false",
              "request-id": "req_test",
              "set-cookie": "secret-cookie",
              authorization: "Bearer secret-token",
            },
          }),
        })
      })
      const text = await readFile(logPath, "utf8")
      const rows = text
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row))
      const response = rows.find((row) => row.event === "usage_limit_response")
      assert.equal(response.sessionID, "ses_test")
      assert.equal(response.account, "cred_subscription")
      assert.equal(response.pid, process.pid)
      assert.equal(response.status, 200)
      assert.deepEqual(response.headers, {
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-grace-5h-utilization": "0.12",
        "anthropic-ratelimit-unified-overage-in-use": "false",
        "request-id": "req_test",
      })
      assert.ok(
        !text.includes("secret-cookie") && !text.includes("secret-token"),
      )
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_AUTH_DEBUG
      else process.env.CLAUDE_AUTH_DEBUG = previous
      await rm(logDir, { recursive: true, force: true })
    }
  })

  it("publishes grace status and nudges the agent loop, not auxiliary requests", async () => {
    const { setupModule } = await loadV2(freshExpiry())
    const bundle = makeCtx()

    await withSetup(setupModule, bundle, async () => {
      const requestHook = bundle.hooks.get("http.request")!
      const responseHook = bundle.hooks.get("http.response")!
      const resetsAt = Math.floor(Date.now() / 1000) + 3600

      const first = {
        ...requestEvt(
          messagesRequest({
            model: "claude-opus-5-5",
            messages: [{ role: "user", content: "go" }],
          }),
        ),
        kind: "primary",
      }
      await requestHook(first)
      await responseHook({
        ...first,
        response: new Response("", {
          status: 200,
          headers: {
            "anthropic-ratelimit-unified-status": "allowed",
            "anthropic-ratelimit-unified-grace-5h-utilization": "0.1",
            "anthropic-ratelimit-unified-5h-reset": String(resetsAt),
          },
        }),
      })

      const grace = {
        state: "grace",
        window: "five_hour",
        resetsAt,
        covered: false,
      }
      assert.deepEqual(bundle.rpcEvents, [{ name: "changed", data: grace }])
      assert.deepEqual(
        await bundle.rpcHandlers.get(
          "opencode-claude-auth.usage-limit.status",
        )!(),
        grace,
      )

      const midTurn = (kind: string) => ({
        ...requestEvt(
          messagesRequest({
            model: "claude-opus-5-5",
            messages: [
              { role: "user", content: "go" },
              {
                role: "assistant",
                content: [
                  { type: "tool_use", id: "toolu_1", name: "bash", input: {} },
                ],
              },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "toolu_1",
                    content: "ok",
                  },
                ],
              },
            ],
          }),
        ),
        kind,
      })
      const title = midTurn("title")
      await requestHook(title)
      assert.deepEqual(
        (await lastContent(title)).map((block) => block.type),
        ["tool_result"],
      )

      const primary = midTurn("primary")
      await requestHook(primary)
      const content = await lastContent(primary)
      assert.equal(content.at(-1)?.type, "text")
      assert.match(
        content.at(-1)?.text ?? "",
        /^\[Usage limit reached \u2014 grace window active\./,
      )
      await responseHook({
        ...primary,
        response: new Response(
          '{"error":{"type":"rate_limit_error","message":"Usage limit reached"}}',
          {
            status: 429,
            headers: {
              "anthropic-ratelimit-unified-status": "rejected",
              "anthropic-ratelimit-unified-representative-claim": "five_hour",
              "anthropic-ratelimit-unified-5h-utilization": "1",
              "anthropic-ratelimit-unified-5h-reset": String(resetsAt),
            },
          },
        ),
      })
      const exhausted = { state: "exhausted", window: "five_hour", resetsAt }
      assert.deepEqual(bundle.rpcEvents.at(-1), {
        name: "changed",
        data: exhausted,
      })
      assert.deepEqual(
        await bundle.rpcHandlers.get(
          "opencode-claude-auth.usage-limit.status",
        )!(),
        exhausted,
      )
    })
  })
})
