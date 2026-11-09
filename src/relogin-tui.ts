import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Plugin } from "@opencode/plugin/tui"
import {
  credentialFingerprint,
  LOGIN_OPTIONS,
  ReloginRpc,
  type ReloginAttempt,
} from "./relogin-rpc.ts"

async function openBrowser(url: string) {
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

export function createReloginCommand(
  context: Plugin.Context,
  openUrl: (url: string) => Promise<void> = openBrowser,
) {
  let running = false
  let abort: AbortController | undefined
  const rpc = context.client.rpc(ReloginRpc)

  return {
    async run() {
      if (running) return
      running = true
      const controller = new AbortController()
      abort = controller
      const location = context.location ?? context.data.location.default()
      const options = { location, signal: controller.signal }
      let attempt: ReloginAttempt | undefined
      let committed = false
      try {
        const accounts = (
          await context.client.credential.list({ signal: controller.signal })
        )
          .filter(
            (item) =>
              item.integrationID === "anthropic" &&
              item.value.type === "oauth" &&
              item.value.methodID === "claude-subscription",
          )
          .sort((a, b) => a.label.localeCompare(b.label))
        if (!accounts.length)
          throw new Error(
            "No Claude subscription accounts exist. Use /connect to add one first.",
          )
        const selected = await context.ui.dialog.select({
          title: "Re-login to an existing Claude account",
          options: accounts.map((item) => ({
            title: item.label,
            value: item.id,
            disabled:
              item.value.type !== "oauth" || item.value.expires > Date.now(),
            description:
              item.value.type === "oauth" && item.value.expires > Date.now()
                ? "Access token still valid; re-login is available after expiry"
                : "Keep this account's ID, name and active selection",
          })),
        })
        if (!selected) return
        const account = accounts.find((item) => item.id === selected)!
        if (account.value.type !== "oauth") return
        const fingerprint = credentialFingerprint(account.value)
        const loginMode = await context.ui.dialog.select({
          title: `Authorization method for ${account.label}`,
          options: LOGIN_OPTIONS.map((item) => ({
            title: item.label,
            value: item.value,
            description: item.description,
          })),
        })
        if (!loginMode) return
        attempt = (await rpc.begin(
          {
            credentialID: account.id,
            fingerprint,
            expires: account.value.expires,
            loginMode,
          },
          options,
        )) as ReloginAttempt
        try {
          await openUrl(attempt.url)
        } catch {
          context.ui.toast.show({
            variant: "warning",
            message:
              "Browser could not open. Open the URL shown in the login dialog.",
          })
        }
        controller.signal.throwIfAborted()
        let code: string | undefined
        if (attempt.mode === "code") {
          code = await context.ui.dialog.prompt({
            title: `Sign in to ${account.label}`,
            description: `${attempt.instructions}\n\n${attempt.url}\n\nMax must authorize the Claude account belonging to "${account.label}".`,
            placeholder: "Paste the full code#state",
          })
          if (!code) return
        } else {
          const proceed = await context.ui.dialog.confirm({
            title: `Sign in to ${account.label}`,
            message: `${attempt.url}\n\nComplete browser authorization for "${account.label}", then continue.`,
            label: { confirm: "Continue", cancel: "Cancel login" },
          })
          if (!proceed) return
        }
        await rpc.complete(
          { id: attempt.id, ...(code === undefined ? {} : { code }) },
          options,
        )
        const confirmed = await context.ui.dialog.confirm({
          title: `Update ${account.label}?`,
          message: `Max confirms that the browser authorized the Claude account belonging to "${account.label}". The plugin cannot verify the identity of an expired legacy login. Its ID, name and active selection will be kept.`,
          label: { confirm: "Update existing account", cancel: "Cancel" },
        })
        if (!confirmed) return
        controller.signal.throwIfAborted()
        const current = (
          await context.client.credential.list({ signal: controller.signal })
        ).find((item) => item.id === account.id)
        if (
          current?.integrationID !== "anthropic" ||
          current.value.type !== "oauth" ||
          credentialFingerprint(current.value) !== fingerprint
        ) {
          throw new Error(
            "The account changed during login. Run /claude-login again.",
          )
        }
        // Do not cancel or retry a save whose persistence outcome may be unknown.
        await rpc.commit({ id: attempt.id }, { location })
        committed = true
        context.data.location.integration.invalidate(location)
        context.ui.toast.show({
          variant: "success",
          message: `Re-authenticated ${current.label}. Existing account kept.`,
        })
      } catch (error) {
        if (!controller.signal.aborted)
          context.ui.toast.show({
            variant: "error",
            message: message(error),
            duration: 10_000,
          })
      } finally {
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
