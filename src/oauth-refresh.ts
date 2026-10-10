import { createHash } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import type { Credential, Plugin } from "@opencode/plugin"
import { acquireRefreshLock } from "./refresh-lock.ts"
import { log } from "./logger.ts"

const PREFIX = "oauth-refresh/"
const RESULT_TTL_MS = 60_000
// The token request times out after 30 seconds. A crashed lock holder can be
// replaced after a minute, without taking over a live network exchange.
const LOCK_TTL_MS = 60_000
const WAIT_MS = LOCK_TTL_MS + 5_000

type Storage = Plugin.Context["storage"]
type Result = Pick<Credential.OAuth, "access" | "refresh" | "expires"> & {
  validUntil: number
}

function result(
  value: Awaited<ReturnType<Storage["get"]>>,
): Result | undefined {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "access" in value &&
    "refresh" in value &&
    "expires" in value &&
    "validUntil" in value &&
    typeof value.access === "string" &&
    typeof value.refresh === "string" &&
    typeof value.expires === "number" &&
    typeof value.validUntil === "number"
  ) {
    return {
      access: value.access,
      refresh: value.refresh,
      expires: value.expires,
      validUntil: value.validUntil,
    }
  }
}

function fresh(value: Result | undefined): value is Result {
  return !!value && value.validUntil > Date.now() && value.expires > Date.now()
}

function tokens(credential: Credential.OAuth, value: Result): Credential.OAuth {
  // Account labels and other metadata belong to the caller's credential.
  return {
    ...credential,
    access: value.access,
    refresh: value.refresh,
    expires: value.expires,
  }
}

export function createCredentialRefresher(options: {
  storage: Plugin.Context["storage"]
  refresh: (credential: Credential.OAuth) => Promise<Credential.OAuth>
}) {
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const removeExpired = async (key: string) => {
    const lock = acquireRefreshLock(`v2:${key}`, {
      ttlMs: LOCK_TTL_MS,
      strict: true,
    })
    if (!lock) return
    try {
      const saved = result(await options.storage.get(key))
      if (!fresh(saved)) await options.storage.remove(key)
    } finally {
      lock.release()
    }
  }

  const prune = async () => {
    let after: string | undefined
    do {
      const page = await options.storage.scan({ prefix: PREFIX, after })
      for (const entry of page.entries) {
        if (!fresh(result(entry.value))) await removeExpired(entry.key)
      }
      after = page.next
    } while (after !== undefined)
  }

  return {
    async refresh(credential: Credential.OAuth): Promise<Credential.OAuth> {
      await prune()
      const key =
        PREFIX + createHash("sha256").update(credential.refresh).digest("hex")
      const deadline = Date.now() + WAIT_MS
      while (true) {
        const saved = result(await options.storage.get(key))
        if (fresh(saved)) return tokens(credential, saved)
        const lock = acquireRefreshLock(`v2:${key}`, {
          ttlMs: LOCK_TTL_MS,
          strict: true,
        })
        if (lock) {
          try {
            // Another process may have finished between the read and lock.
            const latest = result(await options.storage.get(key))
            if (fresh(latest)) return tokens(credential, latest)
            const refreshed = await options.refresh(credential)
            const value: Result = {
              access: refreshed.access,
              refresh: refreshed.refresh,
              expires: refreshed.expires,
              validUntil: Date.now() + RESULT_TTL_MS,
            }
            // Core saves after this callback returns. Publish under the lock
            // first so waiting callbacks never exchange the spent token.
            await options.storage.set(key, value)
            const timer = setTimeout(() => {
              timers.delete(timer)
              void removeExpired(key).catch((error: unknown) => {
                log("refresh_result_cleanup_failed", {
                  error: error instanceof Error ? error.message : String(error),
                })
              })
            }, RESULT_TTL_MS + 1)
            timer.unref()
            timers.add(timer)
            return tokens(credential, value)
          } finally {
            lock.release()
          }
        }
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for another Claude token refresh")
        }
        await delay(50)
      }
    },
    dispose() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    },
  }
}
