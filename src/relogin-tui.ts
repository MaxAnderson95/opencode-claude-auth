import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Plugin } from "@opencode/plugin/tui"
import {
  credentialFingerprint,
  LOGIN_OPTIONS,
  ReloginRpc,
  type ReloginAttempt,
} from "./relogin-rpc.ts"

export async function openBrowser(url: string) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32"
        : "xdg-open"
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url]
  await promisify(execFile)(command, args, { timeout: 10_000 })
}

/** A progress dialog with no choices; the user can only dismiss it. */
export interface ReloginStatus {
  title: string
  message: string
  url?: string
  hint?: string
  warning?: string
  /** Opens the authorization URL again. */
  onOpen?: () => void
}

export interface ReloginView {
  openUrl(url: string): Promise<void>
  /** Replaces the open dialog. `onClose` runs whenever the dialog closes. */
  status(view: ReloginStatus, onClose: () => void): void
}

function message(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message
  return "Claude re-login failed."
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

function expiredAgo(expires: number, now: number) {
  if (expires <= 0) return "expired"
  const minutes = Math.round((expires - now) / 60_000)
  if (minutes > -60) return `expired ${relative.format(minutes, "minute")}`
  const hours = Math.round(minutes / 60)
  if (hours > -24) return `expired ${relative.format(hours, "hour")}`
  return `expired ${relative.format(Math.round(hours / 24), "day")}`
}

function names(labels: string[]) {
  if (labels.length < 3) return labels.join(" and ")
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`
}

export function createReloginCommand(
  context: Plugin.Context,
  view: ReloginView,
) {
  let running = false
  let abort: AbortController | undefined
  const rpc = context.client.rpc(ReloginRpc)
  const { dialog, toast } = context.ui

  return {
    async run() {
      if (running) return
      running = true
      const controller = new AbortController()
      abort = controller
      const { signal } = controller
      const location = context.location ?? context.data.location.default()
      // Each dialog replaces the previous one and fires its onClose, so only
      // the newest status dialog's close means the user dismissed it.
      let step = 0
      let showing = false
      const status = (value: ReloginStatus) => {
        const current = ++step
        showing = true
        view.status(value, () => {
          if (current !== step) return
          showing = false
          controller.abort()
        })
      }
      const ask = <T>(open: () => Promise<T>) => {
        step++
        showing = false
        return open()
      }
      let attempt: ReloginAttempt | undefined
      let saving = false
      let committed = false
      try {
        const accounts = (await context.client.credential.list({ signal }))
          .filter(
            (item) =>
              item.integrationID === "anthropic" &&
              item.value.type === "oauth" &&
              item.value.methodID === "claude-subscription",
          )
          .sort((a, b) => a.label.localeCompare(b.label))
        if (!accounts.length)
          throw new Error(
            "No Claude subscription accounts exist. Add one with /connect first.",
          )
        const now = Date.now()
        const expired = accounts.filter(
          (item) => item.value.type === "oauth" && item.value.expires <= now,
        )
        if (!expired.length) {
          toast.show({
            variant: "info",
            message: `${names(accounts.map((item) => item.label))} ${accounts.length === 1 ? "is" : "are"} still signed in. /claude-login re-authenticates an account once its token expires.`,
            duration: 8_000,
          })
          return
        }

        const selected = await ask(() =>
          dialog.select({
            title: "Re-login to a Claude account",
            options: expired.map((item) => ({
              title: item.label,
              value: item.id,
              description: item.active ? "active" : undefined,
              footer:
                item.value.type === "oauth"
                  ? expiredAgo(item.value.expires, now)
                  : undefined,
            })),
          }),
        )
        if (!selected) return
        const account = expired.find((item) => item.id === selected)!
        if (account.value.type !== "oauth") return
        const title = `Sign in to ${account.label}`
        const fingerprint = credentialFingerprint(account.value)

        const loginMode = await ask(() =>
          dialog.select({
            title,
            current: "auto" as const,
            options: LOGIN_OPTIONS.map((item) => ({
              title: item.label,
              value: item.value,
              description: item.description,
            })),
          }),
        )
        if (!loginMode) return

        status({ title, message: "Starting sign-in…" })
        // Not aborted with the dialog: the server must report the attempt so
        // the finally block can cancel it.
        attempt = (await rpc.begin(
          {
            credentialID: account.id,
            fingerprint,
            expires: account.value.expires,
            loginMode,
          },
          { location },
        )) as ReloginAttempt
        signal.throwIfAborted()
        const { url } = attempt
        const opened = await view.openUrl(url).then(
          () => true,
          () => false,
        )
        signal.throwIfAborted()
        const hint = `Use the Claude account that belongs to ${account.label}. If claude.ai is signed in to another account, switch accounts first.`
        const warning = opened
          ? undefined
          : "Couldn't open a browser. Open the link above yourself."

        if (attempt.mode === "auto") {
          status({
            title,
            url,
            hint,
            warning,
            message: "Waiting for the browser…",
            onOpen: () => void view.openUrl(url).catch(() => {}),
          })
          await rpc
            .complete({ id: attempt.id }, { location, signal })
            .catch((error: unknown) => {
              throw new Error(`Claude sign-in failed: ${message(error)}`)
            })
        } else {
          let rejected: string | undefined
          let code: string | undefined
          while (true) {
            code = await ask(() =>
              dialog.prompt({
                title,
                description: [
                  rejected && `That code didn't work: ${rejected}`,
                  url,
                  hint,
                  "Paste the code Claude shows after you sign in.",
                  warning,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                placeholder: "code#state",
                value: code,
              }),
            )
            if (code === undefined) return
            if (!code.trim()) {
              rejected = "the code was empty."
              continue
            }
            status({ title, message: "Checking the code…" })
            try {
              await rpc.complete(
                { id: attempt.id, code: code.trim() },
                { location, signal },
              )
              break
            } catch (error) {
              signal.throwIfAborted()
              rejected = message(error)
            }
          }
        }

        const confirmed = await ask(() =>
          dialog.confirm({
            title: `Save this sign-in to ${account.label}?`,
            message: `OpenCode can't check which Claude account approved this sign-in. Save it only if you used ${account.label}'s account. ${account.label} keeps its name and ${account.active ? "stays the active account" : "stays inactive"}.`,
            label: { confirm: "Save", cancel: "Discard" },
          }),
        )
        if (!confirmed) return

        status({ title, message: "Saving…" })
        const current = (await context.client.credential.list({ signal })).find(
          (item) => item.id === account.id,
        )
        if (
          current?.integrationID !== "anthropic" ||
          current.value.type !== "oauth" ||
          credentialFingerprint(current.value) !== fingerprint
        ) {
          throw new Error(
            `${account.label} changed while you were signing in, so nothing was saved. Run /claude-login again.`,
          )
        }
        saving = true
        // Do not cancel or retry a save whose persistence outcome may be unknown.
        await rpc.commit({ id: attempt.id }, { location })
        committed = true
        context.data.location.integration.invalidate(location)
        toast.show({
          variant: "success",
          message: `Saved the new sign-in to ${current.label}.`,
        })
      } catch (error) {
        if (saving || !signal.aborted)
          toast.show({
            variant: "error",
            message: message(error),
            duration: 10_000,
          })
      } finally {
        if (showing) {
          step++
          dialog.clear()
        }
        if (attempt && !committed) {
          await rpc.cancel({ id: attempt.id }, { location }).catch(() => {})
        }
        running = false
        if (abort === controller) abort = undefined
      }
    },
    dispose() {
      abort?.abort()
    },
  }
}
