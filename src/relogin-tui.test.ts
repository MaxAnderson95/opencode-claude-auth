import assert from "node:assert/strict"
import { test } from "node:test"
import { createReloginCommand, type ReloginStatus } from "./relogin-tui.ts"

function fixture(
  options: {
    cancel?: "account" | "mode" | "code" | "confirm"
    changed?: boolean
    automatic?: boolean
    browserFails?: boolean
    signedIn?: boolean
    codes?: string[]
    rejectCode?: string
    dismissWaiting?: boolean
  } = {},
) {
  const account = {
    id: "cred_original",
    integrationID: "anthropic",
    label: "Custom Max account",
    active: false,
    value: {
      type: "oauth",
      methodID: "claude-subscription",
      access: "old-access",
      refresh: "old-refresh",
      expires: options.signedIn ? Date.now() + 3_600_000 : 0,
    },
  }
  const calls: Array<{ method: string; input?: unknown; options?: unknown }> =
    []
  const statuses: ReloginStatus[] = []
  const prompts: Array<{ description?: string; value?: string }> = []
  const codes = [...(options.codes ?? ["code#state"])]
  let closeStatus: (() => void) | undefined
  let selections = 0
  let reads = 0
  const rpc = {
    begin: async (input: unknown, requestOptions: unknown) => {
      calls.push({ method: "begin", input, options: requestOptions })
      return {
        id: "attempt",
        mode: options.automatic ? "auto" : "code",
        url: "https://claude.ai/oauth/authorize",
        instructions: "Paste code",
      }
    },
    complete: async (
      input: { code?: string },
      requestOptions: { signal: AbortSignal },
    ) => {
      calls.push({ method: "complete", input })
      if (options.dismissWaiting) {
        closeStatus?.()
        requestOptions.signal.throwIfAborted()
      }
      if (options.rejectCode && input.code === options.rejectCode)
        throw new Error("Invalid OAuth state")
    },
    commit: async (input: unknown) => {
      calls.push({ method: "commit", input })
    },
    cancel: async (input: unknown) => {
      calls.push({ method: "cancel", input })
    },
  }
  const command = createReloginCommand(
    {
      location: { directory: "/project" },
      client: {
        rpc: () => rpc,
        credential: {
          list: async () => {
            reads++
            return [
              {
                ...account,
                value: {
                  ...account.value,
                  refresh:
                    options.changed && reads > 1
                      ? "externally-refreshed"
                      : "old-refresh",
                },
              },
            ]
          },
        },
      },
      data: {
        location: {
          integration: {
            invalidate: () => {
              calls.push({ method: "invalidate" })
            },
          },
        },
      },
      ui: {
        dialog: {
          select: async () => {
            selections++
            if (selections === 1)
              return options.cancel === "account" ? undefined : account.id
            return options.cancel === "mode" ? undefined : "manual"
          },
          prompt: async (input: { description?: string; value?: string }) => {
            prompts.push(input)
            return options.cancel === "code" ? undefined : codes.shift()
          },
          confirm: async () => options.cancel !== "confirm",
          clear: () => {
            calls.push({ method: "clear" })
          },
        },
        toast: {
          show: (input: unknown) => {
            calls.push({ method: "toast", input })
          },
        },
      },
    } as never,
    {
      openUrl: async () => {
        calls.push({ method: "browser" })
        if (options.browserFails) throw new Error("no browser")
      },
      status: (view, onClose) => {
        statuses.push(view)
        closeStatus = onClose
      },
    },
  )
  const methods = () =>
    calls.map((call) => call.method).filter((method) => method !== "clear")
  return { command, calls, methods, statuses, prompts }
}

test("Claude login command targets an existing credential without calling native connect", async () => {
  const { command, calls, methods } = fixture()
  await command.run()
  assert.deepEqual(methods(), [
    "begin",
    "browser",
    "complete",
    "commit",
    "invalidate",
    "toast",
  ])
  const begin = calls[0].input as { credentialID: string; fingerprint: string }
  assert.equal(begin.credentialID, "cred_original")
  assert.match(begin.fingerprint, /^[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(calls).includes("old-refresh"))
  assert.deepEqual((calls[0].options as { location: unknown }).location, {
    directory: "/project",
  })
  assert.match(JSON.stringify(calls.at(-2)), /Custom Max account/)
  assert.equal(calls.at(-1)?.method, "clear")
})

for (const cancel of ["account", "mode", "code", "confirm"] as const) {
  test(`Claude login cancellation at ${cancel} never commits`, async () => {
    const { command, calls } = fixture({ cancel })
    await command.run()
    assert.ok(!calls.some((call) => call.method === "commit"))
    assert.ok(!calls.some((call) => call.method === "toast"))
    assert.equal(
      calls.some((call) => call.method === "cancel"),
      cancel === "code" || cancel === "confirm",
    )
  })
}

test("Claude login rejects an account changed during browser authorization", async () => {
  const { command, calls } = fixture({ changed: true })
  await command.run()
  assert.ok(!calls.some((call) => call.method === "commit"))
  assert.match(JSON.stringify(calls), /changed while you were signing in/)
  assert.equal(calls.at(-1)?.method, "cancel")
})

test("Claude login waits for a local callback in a status dialog", async () => {
  const { command, calls, statuses } = fixture({ automatic: true })
  await command.run()
  assert.deepEqual(calls.find((call) => call.method === "complete")?.input, {
    id: "attempt",
  })
  assert.equal(statuses[1]?.url, "https://claude.ai/oauth/authorize")
  assert.ok(statuses[1]?.onOpen)
  assert.ok(calls.some((call) => call.method === "commit"))
})

test("dismissing the waiting dialog cancels the attempt without an error", async () => {
  const { command, calls } = fixture({
    automatic: true,
    dismissWaiting: true,
  })
  await command.run()
  assert.ok(!calls.some((call) => call.method === "commit"))
  assert.ok(!calls.some((call) => call.method === "toast"))
  assert.equal(calls.at(-1)?.method, "cancel")
})

test("a rejected code is shown in a prefilled retry prompt", async () => {
  const { command, calls, prompts } = fixture({
    codes: ["typo#state", "code#state"],
    rejectCode: "typo#state",
  })
  await command.run()
  assert.equal(prompts.length, 2)
  assert.equal(prompts[1].value, "typo#state")
  assert.match(prompts[1].description ?? "", /Invalid OAuth state/)
  assert.ok(calls.some((call) => call.method === "commit"))
})

test("browser launch failure leaves manual login usable", async () => {
  const { command, calls, prompts } = fixture({ browserFails: true })
  await command.run()
  assert.match(prompts[0].description ?? "", /Couldn't open a browser/)
  assert.ok(calls.some((call) => call.method === "commit"))
})

test("an account with a valid token explains why nothing is listed", async () => {
  const { command, calls } = fixture({ signedIn: true })
  await command.run()
  assert.deepEqual(
    calls.map((call) => call.method),
    ["toast"],
  )
  assert.match(
    JSON.stringify(calls[0].input),
    /Custom Max account is still signed in/,
  )
})
