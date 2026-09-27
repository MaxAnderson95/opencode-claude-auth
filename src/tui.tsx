/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import { UsageLimitRpc, type UsageLimitStatus } from "./usage-limit.ts"

export default Plugin.define({
  id: "opencode-claude-auth",
  setup(context) {
    const usage = context.client.rpc(UsageLimitRpc)
    const [status, setStatus] = createSignal<UsageLimitStatus>({ state: "ok" })
    const [now, setNow] = createSignal(Date.now())

    // The server validates both payloads against UsageLimitRpc's schema.
    usage
      .status({})
      .then((value) => setStatus(value as UsageLimitStatus))
      .catch(() => {})
    const unsubscribe = usage.events.on("changed", (event) => {
      setStatus(event.data as UsageLimitStatus)
    })
    // Windows reset without a response to announce it.
    const clock = setInterval(() => setNow(Date.now()), 30_000)

    // OpenCode 2.0.18 exposes the prompt's selected model; the pinned 2.0.4
    // plugin types predate it.
    const selectedModel = (
      context.ui as {
        model?: { current(): { providerID: string } | undefined }
      }
    ).model

    const label = (sessionID: string | undefined) => {
      const limit = status()
      if (limit.state === "ok") return
      if (limit.resetsAt !== null && now() / 1000 >= limit.resetsAt) return
      const provider =
        selectedModel?.current()?.providerID ??
        (sessionID
          ? context.data.session.get(sessionID)?.model?.providerID
          : undefined)
      if (provider !== "anthropic") return
      if (limit.state === "approaching") {
        return `Approaching 5-hour limit · ${Math.round(limit.utilization * 100)}%`
      }
      if (limit.covered) return "Usage limit reached · using extra usage"
      if (sessionID && context.data.session.status(sessionID) === "running") {
        return "Usage limit reached · wrapping up"
      }
      if (limit.resetsAt === null) return "Usage limit reached"
      const resets = new Date(limit.resetsAt * 1000).toLocaleString([], {
        ...(limit.window === "seven_day" && { weekday: "short" }),
        hour: "numeric",
        minute: "2-digit",
      })
      return `Usage limit reached · resets ${resets}`
    }

    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => (
        <Show when={label(input.sessionID)}>
          {(text) => (
            <box flexShrink={0}>
              <text
                fg={context.theme.text.feedback.warning.base}
                wrapMode="none"
              >
                {text()}
              </text>
            </box>
          )}
        </Show>
      ),
    })

    return () => {
      unsubscribe()
      clearInterval(clock)
    }
  },
})
