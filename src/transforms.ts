import { buildBillingHeaderValue } from "./signing.ts"
import { config, getModelOverride } from "./model-config.ts"
import { log, isLoggingEnabled } from "./logger.ts"

const TOOL_PREFIX = "mcp_"

// How long the SSE reader may sit blocked on a single read() before we emit a
// `stream_idle` diagnostic. This is passive — it only logs, it never aborts the
// stream. The watchdog only counts time while we are actively awaiting upstream
// bytes (not while the consumer is applying backpressure), so a `stream_idle`
// line is strong evidence of an upstream mid-stream stall.
// Override with OPENCODE_CLAUDE_AUTH_STREAM_IDLE_LOG_MS.
const DEFAULT_STREAM_IDLE_LOG_MS = 30_000

function getStreamIdleLogMs(): number {
  const env = process.env.OPENCODE_CLAUDE_AUTH_STREAM_IDLE_LOG_MS
  if (env) {
    const parsed = parseInt(env, 10)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_STREAM_IDLE_LOG_MS
}

// How long the SSE reader may sit blocked on a single read() before we ABORT
// the stalled stream so OpenCode can retry it, instead of hanging indefinitely.
// Reimplements the idle-abort behavior from upstream PR #139. Unlike the idle
// LOG threshold above, this changes behavior: it cancels the upstream read and
// errors the stream. Set to 0 to disable (logging-only). Override with
// OPENCODE_CLAUDE_AUTH_STREAM_IDLE_ABORT_MS.
const DEFAULT_STREAM_IDLE_ABORT_MS = 60_000

function getStreamIdleAbortMs(): number {
  const env = process.env.OPENCODE_CLAUDE_AUTH_STREAM_IDLE_ABORT_MS
  if (env !== undefined) {
    const parsed = parseInt(env, 10)
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed
  }
  return DEFAULT_STREAM_IDLE_ABORT_MS
}

/** Diagnostic context threaded from the fetch handler into stream logging. */
export interface StreamLogContext {
  modelId?: string
  requestStartedAt?: number
}

/**
 * Prefix a tool name with TOOL_PREFIX and uppercase the first character.
 * Claude Code uses PascalCase tool names (e.g. mcp_Bash, mcp_Read);
 * lowercase names (mcp_bash, mcp_read) are flagged as non-Claude-Code clients.
 */
function prefixName(name: string): string {
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

/**
 * Reverse prefixName: strip TOOL_PREFIX and restore the original leading case.
 */
function unprefixName(name: string): string {
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`
}

const SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

type SystemEntry = { type?: string; text?: string } & Record<string, unknown>
type ContentBlock = { type?: string; text?: string } & Record<string, unknown>
type Message = {
  role?: string
  content?: string | ContentBlock[]
}

export function repairToolPairs(messages: Message[]): Message[] {
  // Collect all tool_use ids and tool_result tool_use_ids
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      const id = block["id"]
      if (block.type === "tool_use" && typeof id === "string") {
        toolUseIds.add(id)
      }
      const toolUseId = block["tool_use_id"]
      if (block.type === "tool_result" && typeof toolUseId === "string") {
        toolResultIds.add(toolUseId)
      }
    }
  }

  // Find orphaned IDs
  const orphanedUses = new Set<string>()
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) orphanedUses.add(id)
  }
  const orphanedResults = new Set<string>()
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) orphanedResults.add(id)
  }

  // Early return if nothing to fix
  if (orphanedUses.size === 0 && orphanedResults.size === 0) {
    return messages
  }

  // Filter orphaned blocks and remove messages with empty content arrays
  return messages
    .map((message) => {
      if (!Array.isArray(message.content)) return message
      const filtered = message.content.filter((block) => {
        const id = block["id"]
        if (block.type === "tool_use" && typeof id === "string") {
          return !orphanedUses.has(id)
        }
        const toolUseId = block["tool_use_id"]
        if (block.type === "tool_result" && typeof toolUseId === "string") {
          return !orphanedResults.has(toolUseId)
        }
        return true
      })
      return { ...message, content: filtered }
    })
    .filter(
      (message) =>
        !(Array.isArray(message.content) && message.content.length === 0),
    )
}

export function transformBody(
  body: BodyInit | null | undefined,
): BodyInit | null | undefined {
  if (typeof body !== "string") {
    return body
  }

  try {
    const parsed = JSON.parse(body) as {
      model?: string
      system?: SystemEntry[]
      thinking?: Record<string, unknown>
      // eslint-disable-next-line @typescript-eslint/naming-convention
      output_config?: Record<string, unknown>
      tools?: Array<{ name?: string } & Record<string, unknown>>
      messages?: Array<{
        role?: string
        content?:
          | string
          | Array<{ type?: string; text?: string } & Record<string, unknown>>
      }>
    }

    // --- Billing header: inject as system[0] (no cache_control) ---
    const version = process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "cli"
    const billingHeader = buildBillingHeaderValue(
      (parsed.messages ?? []) as Array<{
        role?: string
        content?: string | Array<{ type?: string; text?: string }>
      }>,
      version,
      entrypoint,
    )

    if (!Array.isArray(parsed.system)) {
      parsed.system = []
    }

    // Remove any existing billing header entries
    parsed.system = parsed.system.filter(
      (e) =>
        !(
          e.type === "text" &&
          typeof e.text === "string" &&
          e.text.startsWith("x-anthropic-billing-header")
        ),
    )

    // Insert billing header as system[0], without cache_control
    parsed.system.unshift({ type: "text", text: billingHeader })

    // --- Split identity prefix into its own system entry ---
    // OpenCode's system.transform hook prepends the identity string, but
    // OpenCode then concatenates all system entries into a single text block.
    // Anthropic's API requires the identity string as a separate entry for
    // OAuth validation (see issue #98).
    const splitSystem: SystemEntry[] = []
    for (const entry of parsed.system) {
      if (
        entry.type === "text" &&
        typeof entry.text === "string" &&
        entry.text.startsWith(SYSTEM_IDENTITY) &&
        entry.text.length > SYSTEM_IDENTITY.length
      ) {
        const rest = entry.text
          .slice(SYSTEM_IDENTITY.length)
          .replace(/^\n+/, "")
        // Preserve all properties except text (e.g. cache_control)
        const { text: _text, ...entryProps } = entry
        // Only keep cache_control on the remainder block to avoid exceeding
        // the API limit of 4 cache_control blocks per request.
        const { cache_control: _cc, ...identityProps } = entryProps
        splitSystem.push({ ...identityProps, text: SYSTEM_IDENTITY })
        if (rest.length > 0) {
          splitSystem.push({ ...entryProps, text: rest })
        }
      } else {
        splitSystem.push(entry)
      }
    }
    parsed.system = splitSystem

    // --- Relocate non-core system entries to user messages ---
    // Anthropic's API now validates the system prompt for OAuth-authenticated
    // requests that use Claude Code billing.  Third-party system prompts
    // (like OpenCode's) trigger a 400 "out of extra usage" rejection when
    // they appear inside the system[] array alongside the identity prefix.
    //
    // Work-around: keep only the billing header and identity prefix in
    // system[], and prepend all other system content to the first user
    // message where it is functionally equivalent but avoids the check.
    const BILLING_PREFIX = "x-anthropic-billing-header"
    const keptSystem: SystemEntry[] = []
    const movedTexts: string[] = []
    for (const entry of parsed.system) {
      const txt = typeof entry === "string" ? entry : (entry.text ?? "")
      if (txt.startsWith(BILLING_PREFIX) || txt.startsWith(SYSTEM_IDENTITY)) {
        keptSystem.push(entry)
      } else if (txt.length > 0) {
        movedTexts.push(txt)
      }
    }
    if (movedTexts.length > 0 && Array.isArray(parsed.messages)) {
      const firstUser = parsed.messages.find((m) => m.role === "user")
      if (firstUser) {
        parsed.system = keptSystem
        const prefix = movedTexts.join("\n\n")
        if (typeof firstUser.content === "string") {
          firstUser.content = prefix + "\n\n" + firstUser.content
        } else if (Array.isArray(firstUser.content)) {
          firstUser.content.unshift({ type: "text", text: prefix })
        }
      }
    }

    // Strip effort for models that don't support it (e.g. haiku).
    // OpenCode sends { output_config: { effort: "high" } } but haiku
    // rejects the effort parameter with a 400 error.
    const modelId = parsed.model ?? ""
    const override = getModelOverride(modelId)
    if (override?.disableEffort) {
      if (parsed.output_config) {
        delete parsed.output_config.effort
        if (Object.keys(parsed.output_config).length === 0) {
          delete parsed.output_config
        }
      }
      if (parsed.thinking && "effort" in parsed.thinking) {
        delete parsed.thinking.effort
        if (Object.keys(parsed.thinking).length === 0) {
          delete parsed.thinking
        }
      }
    }

    // Anthropic's OAuth billing validation rejects lowercase tool names
    // when multiple tools are present. Claude Code uses PascalCase after
    // the mcp_ prefix (e.g. mcp_Bash, mcp_Read). Apply the same convention.
    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => ({
        ...tool,
        name: tool.name ? prefixName(tool.name) : tool.name,
      }))
    }

    if (Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((message) => {
        if (!Array.isArray(message.content)) {
          return message
        }

        return {
          ...message,
          content: message.content.map((block) => {
            if (block.type !== "tool_use" || typeof block.name !== "string") {
              return block
            }

            return { ...block, name: prefixName(block.name) }
          }),
        }
      })
    }

    if (Array.isArray(parsed.messages)) {
      parsed.messages = repairToolPairs(parsed.messages)
    }

    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

export function stripToolPrefix(text: string): string {
  return text.replace(
    /"name"\s*:\s*"mcp_([^"]+)"/g,
    (_match, name: string) => `"name": "${unprefixName(name)}"`,
  )
}

/**
 * Cheaply scan a complete SSE event for diagnostic markers. Returns the parsed
 * `event:` type (if any) plus terminal/error flags, without allocating beyond a
 * small regex match. Used only when logging is enabled.
 */
function inspectSseEvent(evt: string): {
  eventType: string | null
  isMessageStop: boolean
  isErrorEvent: boolean
} {
  const match = /event:\s*([a-zA-Z_.-]+)/.exec(evt)
  const eventType = match ? match[1] : null
  const isMessageStop = evt.includes("message_stop")
  const isErrorEvent =
    evt.includes("overloaded_error") ||
    evt.includes("event: error") ||
    evt.includes('"type":"error"')
  return { eventType, isMessageStop, isErrorEvent }
}

export function transformResponseStream(
  response: Response,
  ctx?: StreamLogContext,
): Response {
  const modelId = ctx?.modelId ?? "unknown"

  if (!response.body) {
    log("stream_no_body", { modelId, status: response.status })
    return response
  }

  // Don't wrap error responses through the SSE parser — pass them through
  // with only tool-prefix stripping on the raw body. This preserves error
  // messages for OpenCode / AI SDK to handle properly.
  if (!response.ok) {
    log("stream_error_response_body", { modelId, status: response.status })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()

    const passthrough = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        const text = decoder.decode(value, { stream: true })
        controller.enqueue(encoder.encode(stripToolPrefix(text)))
      },
      cancel(reason) {
        void reader.cancel(reason).catch(() => {})
      },
    })

    return new Response(passthrough, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  // --- Stream lifecycle instrumentation (logging only; no behavior change) ---
  const logEnabled = isLoggingEnabled()
  const streamStartedAt = Date.now()
  let firstChunkAt = 0
  let byteCount = 0
  let eventCount = 0
  let sawMessageStop = false
  let sawErrorEvent = false
  let lastEventType = "none"
  let closed = false
  // Only the interval below reads these; they track an in-flight upstream read
  // so the idle watchdog measures upstream silence, not consumer backpressure.
  let awaitingRead = false
  let readStartedAt = 0
  let idleOccurrences = 0
  let idleTimer: ReturnType<typeof setInterval> | undefined

  const clearIdle = (): void => {
    if (idleTimer !== undefined) {
      clearInterval(idleTimer)
      idleTimer = undefined
    }
  }

  log("stream_start", { modelId, status: response.status })

  const stream = new ReadableStream({
    start(controller) {
      const idleLogMs = getStreamIdleLogMs()
      const abortMs = getStreamIdleAbortMs()
      // Nothing to do if both logging and abort are off.
      if (!logEnabled && abortMs <= 0) return
      // Tick at the finer of the two thresholds so the abort fires promptly.
      const tickMs = abortMs > 0 ? Math.min(idleLogMs, abortMs) : idleLogMs
      idleTimer = setInterval(() => {
        if (closed || !awaitingRead) return
        const idleFor = Date.now() - readStartedAt

        // Active recovery: abort a stalled upstream read so OpenCode can retry,
        // instead of hanging indefinitely. Reimplements upstream PR #139.
        if (abortMs > 0 && idleFor >= abortMs) {
          closed = true
          clearIdle()
          log("stream_idle_abort", {
            modelId,
            idleMs: idleFor,
            sinceStartMs: Date.now() - streamStartedAt,
            eventCount,
            byteCount,
            lastEventType,
          })
          void reader.cancel().catch(() => {})
          try {
            controller.error(
              new Error(
                `Anthropic stream idle for ${idleFor}ms with no data; aborting so the request can be retried`,
              ),
            )
          } catch {
            // Controller may already be closed/errored; ignore.
          }
          return
        }

        if (logEnabled && idleFor >= idleLogMs) {
          idleOccurrences++
          log("stream_idle", {
            modelId,
            idleMs: idleFor,
            sinceStartMs: Date.now() - streamStartedAt,
            eventCount,
            byteCount,
            lastEventType,
            sawMessageStop,
            occurrence: idleOccurrences,
          })
        }
      }, tickMs)
      // Never keep the process alive solely for this diagnostic timer.
      idleTimer.unref?.()
    },
    async pull(controller) {
      for (;;) {
        const boundary = buffer.indexOf("\n\n")
        if (boundary !== -1) {
          const completeEvent = buffer.slice(0, boundary + 2)
          buffer = buffer.slice(boundary + 2)
          eventCount++
          if (logEnabled) {
            const info = inspectSseEvent(completeEvent)
            if (info.eventType) lastEventType = info.eventType
            if (info.isMessageStop) sawMessageStop = true
            if (info.isErrorEvent && !sawErrorEvent) {
              sawErrorEvent = true
              log("stream_error_event", {
                modelId,
                sinceStartMs: Date.now() - streamStartedAt,
                eventCount,
                snippet: completeEvent.slice(0, 200),
              })
            }
          }
          controller.enqueue(encoder.encode(stripToolPrefix(completeEvent)))
          return
        }

        let result: ReadableStreamReadResult<Uint8Array>
        readStartedAt = Date.now()
        awaitingRead = true
        try {
          result = await reader.read()
        } catch (err) {
          awaitingRead = false
          closed = true
          clearIdle()
          log("stream_error", {
            modelId,
            sinceStartMs: Date.now() - streamStartedAt,
            eventCount,
            byteCount,
            error: err instanceof Error ? err.message : String(err),
          })
          controller.error(err)
          return
        }
        awaitingRead = false
        // The idle watchdog may have aborted (and errored the controller)
        // while we were blocked; cancelling resolves this read as done.
        if (closed) return

        const { done, value } = result

        if (done) {
          if (buffer) {
            eventCount++
            if (logEnabled) {
              const info = inspectSseEvent(buffer)
              if (info.eventType) lastEventType = info.eventType
              if (info.isMessageStop) sawMessageStop = true
            }
            controller.enqueue(encoder.encode(stripToolPrefix(buffer)))
            buffer = ""
          }
          closed = true
          clearIdle()
          log("stream_end", {
            modelId,
            durationMs: Date.now() - streamStartedAt,
            requestToEndMs: ctx?.requestStartedAt
              ? Date.now() - ctx.requestStartedAt
              : undefined,
            eventCount,
            byteCount,
            sawMessageStop,
            sawErrorEvent,
            lastEventType,
            // A clean Anthropic stream ends with message_stop; its absence here
            // flags a truncated/severed stream even though the socket closed.
            truncated: !sawMessageStop && !sawErrorEvent,
          })
          controller.close()
          return
        }

        if (firstChunkAt === 0) {
          firstChunkAt = Date.now()
          log("stream_first_chunk", {
            modelId,
            ttfbMs: firstChunkAt - streamStartedAt,
            requestToFirstChunkMs: ctx?.requestStartedAt
              ? firstChunkAt - ctx.requestStartedAt
              : undefined,
          })
        }
        byteCount += value.byteLength
        buffer += decoder.decode(value, { stream: true })
      }
    },
    cancel(reason) {
      closed = true
      clearIdle()
      log("stream_cancel", {
        modelId,
        sinceStartMs: Date.now() - streamStartedAt,
        eventCount,
        byteCount,
        sawMessageStop,
        lastEventType,
        reason: reason instanceof Error ? reason.message : String(reason ?? ""),
      })
      void reader.cancel(reason).catch(() => {})
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
