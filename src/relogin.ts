import { randomUUID } from "node:crypto"
import type { Credential, Plugin } from "@opencode/plugin"
import { authorize, OAUTH_METHOD_ID } from "./oauth.ts"
import { credentialFingerprint, type ReloginInput } from "./relogin-rpc.ts"

type Authorization = Awaited<ReturnType<typeof authorize>>
interface Attempt {
  input: ReloginInput
  abort: AbortController
  timer: ReturnType<typeof setTimeout>
  authorization?: Authorization
  pending?: Promise<void>
  credential?: Credential.OAuth
  failure?: unknown
  committing: boolean
}

export function createRelogin(options: {
  integration: Pick<Plugin.Context["integration"], "get" | "connection">
  authorize?: typeof authorize
}) {
  const attempts = new Map<string, Attempt>()
  const replacements = new Map<string, Attempt>()

  const connection = async (credentialID: string) => {
    const { data } = await options.integration.get({
      integrationID: "anthropic",
    })
    const found = data.connections.find(
      (item) => item.type === "credential" && item.id === credentialID,
    )
    if (!found || found.type !== "credential" || found.method !== "oauth") {
      throw new Error("The selected Anthropic OAuth account no longer exists.")
    }
    return found
  }

  const remove = (id: string) => {
    const attempt = attempts.get(id)
    if (!attempt) return
    clearTimeout(attempt.timer)
    attempt.abort.abort(new Error("Claude re-login cancelled or expired."))
    if (replacements.get(attempt.input.fingerprint) === attempt) {
      replacements.delete(attempt.input.fingerprint)
    }
    attempts.delete(id)
  }
  const cancel = (id: string) => {
    // Once resolve starts, core may already be persisting the returned tokens.
    if (!attempts.get(id)?.committing) remove(id)
  }

  const get = (id: string) => {
    const attempt = attempts.get(id)
    if (!attempt)
      throw new Error("Claude re-login expired. Run /claude-login again.")
    return attempt
  }

  return {
    async begin(input: ReloginInput) {
      if (input.expires > Date.now()) {
        throw new Error(
          "This account's access token is still valid. Re-login is available after it expires.",
        )
      }
      await connection(input.credentialID)
      if (
        [...attempts.values()].some(
          (item) =>
            item.input.credentialID === input.credentialID ||
            item.input.fingerprint === input.fingerprint,
        )
      ) {
        throw new Error("A re-login for this account is already in progress.")
      }
      const id = randomUUID()
      const attempt: Attempt = {
        input,
        abort: new AbortController(),
        timer: setTimeout(() => cancel(id), 5 * 60_000),
        committing: false,
      }
      attempt.timer.unref()
      attempts.set(id, attempt)
      try {
        const authorization = await (options.authorize ?? authorize)(
          { loginMode: input.loginMode },
          attempt.abort.signal,
        )
        attempt.authorization = authorization
        if (authorization.mode === "auto") {
          // Attach rejection handling before returning the browser URL.
          attempt.pending = authorization.callback.then(
            (credential) => {
              attempt.credential = credential
            },
            (error: unknown) => {
              attempt.failure = error
            },
          )
        }
        attempt.abort.signal.throwIfAborted()
        return {
          id,
          mode: authorization.mode,
          url: authorization.url,
          instructions: authorization.instructions,
        }
      } catch (error) {
        cancel(id)
        throw error
      }
    },

    async complete(id: string, code?: string) {
      const attempt = get(id)
      if (attempt.committing)
        throw new Error("This re-login is already being saved.")
      if (attempt.credential) return
      if (attempt.authorization?.mode === "code") {
        if (!code)
          throw new Error("Paste the authorization code including #state.")
        // A code can be exchanged only once, including with concurrent clients.
        attempt.pending ??= attempt.authorization.callback(code).then(
          (credential) => {
            attempt.credential = credential
          },
          (error: unknown) => {
            attempt.failure = error
          },
        )
      }
      await attempt.pending
      attempt.abort.signal.throwIfAborted()
      if (attempt.failure) throw attempt.failure
      if (!attempt.credential)
        throw new Error("Browser authorization has not completed.")
    },

    async commit(id: string) {
      const attempt = get(id)
      if (attempt.committing)
        throw new Error("This re-login is already being saved.")
      if (!attempt.credential)
        throw new Error("Complete browser authorization first.")
      attempt.committing = true
      clearTimeout(attempt.timer)
      try {
        const target = await connection(attempt.input.credentialID)
        attempt.abort.signal.throwIfAborted()
        replacements.set(attempt.input.fingerprint, attempt)
        // Core owns the credential lock, persistence, ID, label and active selection.
        const saved = await options.integration.connection.resolve(target)
        if (
          saved?.type !== "oauth" ||
          saved.access !== attempt.credential.access
        ) {
          throw new Error(
            "The account changed during login. No replacement was applied. Run /claude-login again.",
          )
        }
      } finally {
        remove(id)
      }
    },

    replacement(credential: Credential.OAuth): Credential.OAuth | undefined {
      const attempt = replacements.get(credentialFingerprint(credential))
      if (!attempt?.credential || credential.methodID !== OAUTH_METHOD_ID)
        return
      attempt.abort.signal.throwIfAborted()
      return {
        ...credential,
        access: attempt.credential.access,
        refresh: attempt.credential.refresh,
        expires: attempt.credential.expires,
      }
    },

    cancel,
    dispose() {
      for (const id of attempts.keys()) remove(id)
    },
  }
}
