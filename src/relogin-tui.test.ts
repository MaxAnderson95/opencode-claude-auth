import assert from "node:assert/strict"
import { test } from "node:test"
import { createReloginCommand } from "./relogin-tui.ts"

function fixture(
  options: {
    cancel?: "account" | "mode" | "code" | "confirm"
    changed?: boolean
    automatic?: boolean
    browserFails?: boolean
  } = {},
) {
  const account = {
    id: "cred_original",
    integrationID: "anthropic",
    label: "Custom Max account",
    value: {
      type: "oauth",
      methodID: "claude-subscription",
      access: "old-access",
      refresh: "old-refresh",
      expires: 0,
    },
  }
  const calls: Array<{ method: string; input?: unknown; options?: unknown }> =
    []
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
    complete: async (input: unknown) => {
      calls.push({ method: "complete", input })
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
          prompt: async () =>
            options.cancel === "code" ? undefined : "code#state",
          confirm: async () => options.cancel !== "confirm",
        },
        toast: {
          show: (input: unknown) => {
            calls.push({ method: "toast", input })
          },
        },
      },
    } as never,
    async () => {
      calls.push({ method: "browser" })
      if (options.browserFails) throw new Error("no browser")
    },
  )
  return { command, calls, account }
}

test("Claude login command targets an existing credential without calling native connect", async () => {
  const { command, calls } = fixture()
  await command.run()
  assert.deepEqual(
    calls.map((call) => call.method),
    ["begin", "browser", "complete", "commit", "invalidate", "toast"],
  )
  const begin = calls[0].input as { credentialID: string; fingerprint: string }
  assert.equal(begin.credentialID, "cred_original")
  assert.match(begin.fingerprint, /^[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(calls).includes("old-refresh"))
  assert.deepEqual((calls[0].options as { location: unknown }).location, {
    directory: "/project",
  })
  assert.match(JSON.stringify(calls.at(-1)), /Custom Max account/)
})

for (const cancel of ["account", "mode", "code", "confirm"] as const) {
  test(`Claude login cancellation at ${cancel} never commits`, async () => {
    const { command, calls } = fixture({ cancel })
    await command.run()
    assert.ok(!calls.some((call) => call.method === "commit"))
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
  assert.match(JSON.stringify(calls), /account changed during login/)
  assert.equal(calls.at(-1)?.method, "cancel")
})

test("Claude login supports a local callback without a pasted code", async () => {
  const { command, calls } = fixture({ automatic: true })
  await command.run()
  assert.deepEqual(calls.find((call) => call.method === "complete")?.input, {
    id: "attempt",
  })
  assert.ok(calls.some((call) => call.method === "commit"))
})

test("browser launch failure leaves manual login usable", async () => {
  const { command, calls } = fixture({ browserFails: true })
  await command.run()
  assert.match(JSON.stringify(calls), /Browser could not open/)
  assert.ok(calls.some((call) => call.method === "commit"))
})
