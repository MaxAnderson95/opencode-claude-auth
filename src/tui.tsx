/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import { UsageLimitRpc, type UsageLimitStatus } from "./usage-limit.ts"
import {
  createReloginCommand,
  openBrowser,
  type ReloginStatus,
} from "./relogin-tui.ts"

// Mirrors the layout of OpenCode's own sign-in progress dialog.
function ReloginStatusDialog(props: {
  context: Plugin.Context
  view: ReloginStatus
}) {
  const theme = props.context.theme.surface("dialog")
  props.context.keymap.layer(() => ({
    mode: "modal",
    enabled: props.view.onOpen !== undefined,
    commands: [
      {
        bind: "return",
        title: "Open sign-in link",
        group: "Dialog",
        run: () => props.view.onOpen?.(),
      },
    ],
  }))
  return (
    <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.base}>
          <strong>{props.view.title}</strong>
        </text>
        <text fg={theme.text.muted} flexShrink={0}>
          esc
        </text>
      </box>
      <Show when={props.view.url}>
        {(url) => (
          <text fg={theme.markdown.link} wrapMode="char">
            <a href={url()}>{url()}</a>
          </text>
        )}
      </Show>
      <Show when={props.view.hint}>
        {(hint) => <text fg={theme.text.muted}>{hint()}</text>}
      </Show>
      <Show when={props.view.warning}>
        {(warning) => (
          <text fg={theme.text.feedback.warning.base}>{warning()}</text>
        )}
      </Show>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.base}>{props.view.message}</text>
        <Show when={props.view.onOpen}>
          <text fg={theme.text.muted} flexShrink={0}>
            open link <span style={{ fg: theme.text.base }}>enter</span>
          </text>
        </Show>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-claude-auth",
  setup(context) {
    const relogin = createReloginCommand(context, {
      openUrl: openBrowser,
      status: (view, onClose) =>
        context.ui.dialog.show(
          () => <ReloginStatusDialog context={context} view={view} />,
          onClose,
        ),
    })
    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "opencode-claude-auth.relogin",
              title: "Re-login to an existing Claude account",
              group: "Claude",
              palette: true,
              slash: { name: "claude-login" },
              run: () => relogin.run(),
            },
          ],
        }))
        return null
      },
    })
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
        return `Approaching 5-hour limit · ${Math.floor(limit.utilization * 100)}%`
      }
      if (limit.state === "grace" && limit.covered)
        return "Usage limit reached · using extra usage"
      if (
        limit.state === "grace" &&
        sessionID &&
        context.data.session.status(sessionID) === "running"
      ) {
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
      relogin.dispose()
      unsubscribe()
      clearInterval(clock)
    }
  },
})
