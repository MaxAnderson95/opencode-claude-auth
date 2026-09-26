import type { Rpc } from "@opencode/plugin/rpc"

/**
 * Claude Code's usage-limit wrap-up. When a subscription hits its 5-hour or
 * weekly limit mid-task, Anthropic keeps serving requests for a short grace
 * window paid from the weekly allowance and reports it in the
 * `anthropic-ratelimit-unified-grace-*` response headers. Claude Code reacts
 * by telling the model to checkpoint instead of running until a hard 429.
 */

export type UsageLimitWindow = "five_hour" | "seven_day"

export type UsageLimitStatus =
  | { readonly state: "ok" }
  | {
      readonly state: "approaching"
      readonly utilization: number
      readonly resetsAt: number
    }
  | {
      readonly state: "grace"
      readonly window: UsageLimitWindow
      readonly resetsAt: number | null
      /** Extra usage (overage) pays for requests past the limit, so the model is not told to stop. */
      readonly covered: boolean
    }

/** Quota belongs to an account, so every call names the credential it is for. */
export interface UsageLimitTracker {
  /** Records an Anthropic response's quota headers. Returns true when status(account) changed. */
  observe(account: string, headers: Headers): boolean
  status(account: string): UsageLimitStatus
  /**
   * Adds wrap-up instructions to a Messages API body for one session's agent
   * loop, based on the account the request is sent with. An instruction is
   * attached to a tool-result message and re-sent at the same position on
   * every later request, so the model keeps seeing it and the prompt-cache
   * prefix stays byte-identical. Each kind of instruction is sent at most once
   * per user turn; a grace instruction can follow an earlier approaching one.
   */
  annotate(account: string, sessionID: string, body: string): string
}

// Exact bytes Claude Code 2.1.283 sends ("next-steps" mode).
export const GRACE_WRAP_UP =
  "[Usage limit reached \u2014 grace window active. Checkpoint now: finish the " +
  "current step, then list up to 3 short bullets of the most impactful remaining work. Don't start subagents or long-running work.]"
export const NEAR_LIMIT_WRAP_UP =
  "[Usage limit approaching. Checkpoint now: finish the current step, then list up to 3 short bullets of the most impactful remaining work. Don't start subagents or long-running work.]"

// Claude Code picks this per plan tier (0.99 on Max 5x, 0.9975 on Max 20x).
// Responses do not carry the tier, so use its default, which applies to Pro.
export const NEAR_LIMIT_THRESHOLD = 0.95

const RESETS_AT = { type: "integer" } as const
const STATUS_SCHEMA = {
  type: "object",
  oneOf: [
    {
      type: "object",
      properties: { state: { const: "ok" } },
      required: ["state"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        state: { const: "approaching" },
        utilization: { type: "number" },
        resetsAt: RESETS_AT,
      },
      required: ["state", "utilization", "resetsAt"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        state: { const: "grace" },
        window: { enum: ["five_hour", "seven_day"] },
        resetsAt: { anyOf: [RESETS_AT, { type: "null" }] },
        covered: { type: "boolean" },
      },
      required: ["state", "window", "resetsAt", "covered"],
      additionalProperties: false,
    },
  ],
} as const

/** Carries the active account's status to the TUI status line. */
export const UsageLimitRpc = {
  id: "opencode-claude-auth.usage-limit",
  methods: {
    status: { input: { type: "object" }, output: STATUS_SCHEMA },
  },
  events: {
    changed: { schema: STATUS_SCHEMA },
  },
} as const satisfies Rpc.PortableDefinition

const HEADER = "anthropic-ratelimit-unified-"
const OK: UsageLimitStatus = { state: "ok" }

type ContentBlock = { type?: string; tool_use_id?: string } & Record<
  string,
  unknown
>
type WireMessage = { role?: string; content?: string | ContentBlock[] }

interface SessionNotes {
  /** Wrap-up text keyed by the first tool_use_id of the message it follows. */
  readonly anchors: Map<string, string>
  /** 5-hour window (reset epoch seconds) whose near-limit note was already sent. */
  nearLimitWindow: number | null
}

export function createUsageLimitTracker(
  now: () => number = Date.now,
): UsageLimitTracker {
  const accounts = new Map<string, UsageLimitStatus>()
  const sessions = new Map<string, SessionNotes>()

  const status = (account: string): UsageLimitStatus => {
    const current = accounts.get(account) ?? OK
    if (
      current.state !== "ok" &&
      current.resetsAt !== null &&
      now() / 1000 >= current.resetsAt
    ) {
      accounts.delete(account)
      return OK
    }
    return current
  }

  const noteFor = (
    limit: UsageLimitStatus,
    notes: SessionNotes,
    sentThisTurn: ReadonlySet<string>,
  ): string | undefined => {
    if (sentThisTurn.has(GRACE_WRAP_UP)) return undefined
    if (limit.state === "grace")
      return limit.covered ? undefined : GRACE_WRAP_UP
    if (
      limit.state === "approaching" &&
      !sentThisTurn.has(NEAR_LIMIT_WRAP_UP) &&
      notes.nearLimitWindow !== limit.resetsAt
    ) {
      notes.nearLimitWindow = limit.resetsAt
      return NEAR_LIMIT_WRAP_UP
    }
    return undefined
  }

  return {
    observe(account, headers) {
      if (headers.get(`${HEADER}status`) === null) return false
      const before = JSON.stringify(status(account))
      const next = readStatus(headers, now() / 1000)
      if (next.state === "ok") accounts.delete(account)
      else accounts.set(account, next)
      return JSON.stringify(status(account)) !== before
    },

    status,

    annotate(account, sessionID, body) {
      let parsed: { messages?: unknown }
      try {
        parsed = JSON.parse(body) as { messages?: unknown }
      } catch {
        return body
      }
      if (!Array.isArray(parsed.messages)) return body
      const messages = parsed.messages as WireMessage[]
      const notes = sessions.get(sessionID) ?? {
        anchors: new Map<string, string>(),
        nearLimitWindow: null,
      }

      // Compaction and edits drop old messages; forget their anchors.
      const present = new Set(messages.map(toolResultID))
      for (const id of notes.anchors.keys()) {
        if (!present.has(id)) notes.anchors.delete(id)
      }

      // Claude Code only nudges mid-turn, after tool results, never on the
      // request that carries a fresh user prompt.
      const lastID = toolResultID(messages.at(-1))
      if (lastID !== undefined && !notes.anchors.has(lastID)) {
        const sentThisTurn = new Set<string>()
        for (let i = messages.length - 1; i >= 0; i--) {
          const id = toolResultID(messages[i])
          if (id === undefined && messages[i].role === "user") break
          const note = id === undefined ? undefined : notes.anchors.get(id)
          if (note !== undefined) sentThisTurn.add(note)
        }
        const note = noteFor(status(account), notes, sentThisTurn)
        if (note !== undefined) notes.anchors.set(lastID, note)
      }

      if (notes.anchors.size === 0) {
        sessions.delete(sessionID)
        return body
      }
      sessions.set(sessionID, notes)

      for (const message of messages) {
        const note = notes.anchors.get(toolResultID(message) ?? "")
        if (note === undefined || !Array.isArray(message.content)) continue
        message.content.push({ type: "text", text: note })
      }
      return JSON.stringify(parsed)
    },
  }
}

function readStatus(headers: Headers, nowSeconds: number): UsageLimitStatus {
  const reset5h = readReset(headers.get(`${HEADER}5h-reset`), nowSeconds)
  const reset7d = readReset(headers.get(`${HEADER}7d-reset`), nowSeconds)
  // A window whose reset time has passed has no grace left to report.
  const grace5h =
    reset5h === "elapsed"
      ? 0
      : fraction(headers.get(`${HEADER}grace-5h-utilization`))
  const grace7d =
    reset7d === "elapsed"
      ? 0
      : fraction(headers.get(`${HEADER}grace-7d-utilization`))
  const resets5h = typeof reset5h === "number" ? reset5h : undefined
  const resets7d = typeof reset7d === "number" ? reset7d : undefined
  const overage = headers.get(`${HEADER}overage-status`)
  const covered =
    overage === "allowed" ||
    overage === "allowed_warning" ||
    headers.get(`${HEADER}overage-in-use`) === "true"

  if (grace5h > 0 || grace7d > 0) {
    // Same choice as Claude Code: the weekly window wins unless the 5-hour
    // window is also in grace and resets after it.
    const window: UsageLimitWindow =
      grace7d > 0 &&
      !(
        grace5h > 0 &&
        resets5h !== undefined &&
        (resets7d === undefined || resets5h > resets7d)
      )
        ? "seven_day"
        : "five_hour"
    const resetsAt = window === "seven_day" ? resets7d : resets5h
    return { state: "grace", window, resetsAt: resetsAt ?? null, covered }
  }

  const used5h = fraction(headers.get(`${HEADER}5h-utilization`))
  if (resets5h !== undefined && used5h >= NEAR_LIMIT_THRESHOLD && !covered) {
    return { state: "approaching", utilization: used5h, resetsAt: resets5h }
  }
  return OK
}

function fraction(value: string | null): number {
  const parsed = Number(value ?? NaN)
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0
}

function readReset(
  value: string | null,
  nowSeconds: number,
): number | "elapsed" | undefined {
  const parsed = Number(value ?? NaN)
  if (!Number.isFinite(parsed)) return undefined
  return parsed > nowSeconds ? Math.round(parsed) : "elapsed"
}

function toolResultID(message: WireMessage | undefined): string | undefined {
  if (message?.role !== "user" || !Array.isArray(message.content)) return
  return message.content.find((block) => block.type === "tool_result")
    ?.tool_use_id
}
