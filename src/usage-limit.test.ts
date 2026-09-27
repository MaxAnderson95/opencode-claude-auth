import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  createUsageLimitTracker,
  GRACE_WRAP_UP,
  NEAR_LIMIT_WRAP_UP,
} from "./usage-limit.ts"

const NOW = 1_800_000_000_000
const ACCOUNT = "cred_a"
const IN_ONE_HOUR = NOW / 1000 + 3600
const IN_ONE_DAY = NOW / 1000 + 86_400

function quota(fields: Record<string, string | number>): Headers {
  const headers = new Headers({
    "anthropic-ratelimit-unified-status": "allowed",
  })
  for (const [name, value] of Object.entries(fields)) {
    headers.set(`anthropic-ratelimit-unified-${name}`, String(value))
  }
  return headers
}

type Block = { type: string; text?: string; tool_use_id?: string }
type Message = { role: string; content: string | Block[] }

const prompt = (text: string): Message => ({ role: "user", content: text })
const toolUse = (id: string): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", tool_use_id: id }],
})
const toolResult = (id: string): Message => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id }],
})

function annotate(
  tracker: ReturnType<typeof createUsageLimitTracker>,
  messages: Message[],
  sessionID = "ses_a",
): Message[] {
  const body = JSON.stringify({ model: "claude-opus-5-5", messages })
  return (
    JSON.parse(tracker.annotate(ACCOUNT, sessionID, body)) as {
      messages: Message[]
    }
  ).messages
}

function notes(messages: Message[]): Array<[number, string]> {
  return messages.flatMap((message, index) =>
    Array.isArray(message.content)
      ? message.content
          .filter((block) => block.type === "text")
          .map((block): [number, string] => [index, block.text ?? ""])
      : [],
  )
}

describe("usage limit status", () => {
  it("reports reached rather than approaching at 100% without grace", () => {
    const tracker = createUsageLimitTracker(() => NOW)
    tracker.observe(
      ACCOUNT,
      quota({ "5h-utilization": 1, "5h-reset": IN_ONE_HOUR }),
    )
    assert.deepEqual(tracker.status(ACCOUNT), {
      state: "exhausted",
      window: "five_hour",
      resetsAt: IN_ONE_HOUR,
    })
  })

  it("reports a rejected limit without requiring utilization headers", () => {
    const tracker = createUsageLimitTracker(() => NOW)
    tracker.observe(
      ACCOUNT,
      quota({
        status: "rejected",
        "representative-claim": "seven_day",
        reset: IN_ONE_DAY,
      }),
    )
    assert.deepEqual(tracker.status(ACCOUNT), {
      state: "exhausted",
      window: "seven_day",
      resetsAt: IN_ONE_DAY,
    })
  })

  it("stops reporting grace when the server rejects further usage", () => {
    const tracker = createUsageLimitTracker(() => NOW)
    tracker.observe(
      ACCOUNT,
      quota({
        status: "rejected",
        "grace-5h-utilization": 1,
        "representative-claim": "five_hour",
        "5h-reset": IN_ONE_HOUR,
      }),
    )
    assert.equal(tracker.status(ACCOUNT).state, "exhausted")
  })

  it("keeps granted grace distinct from a fully used base window", () => {
    const tracker = createUsageLimitTracker(() => NOW)
    tracker.observe(
      ACCOUNT,
      quota({
        "5h-utilization": 1,
        "grace-5h-utilization": 0.1,
        "5h-reset": IN_ONE_HOUR,
      }),
    )
    assert.equal(tracker.status(ACCOUNT).state, "grace")
  })

  it("does not report exhaustion when extra usage covers the full window", () => {
    const tracker = createUsageLimitTracker(() => NOW)
    tracker.observe(
      ACCOUNT,
      quota({
        "5h-utilization": 1,
        "5h-reset": IN_ONE_HOUR,
        "overage-in-use": "true",
      }),
    )
    assert.deepEqual(tracker.status(ACCOUNT), { state: "ok" })
  })

  it("reports 5-hour grace from response headers", () => {
    const tracker = createUsageLimitTracker(() => NOW)
    const headers = quota({
      "grace-5h-utilization": 0.2,
      "5h-reset": IN_ONE_HOUR,
      "7d-reset": IN_ONE_DAY,
    })

    assert.equal(tracker.observe(ACCOUNT, headers), true)
    assert.deepEqual(tracker.status(ACCOUNT), {
      state: "grace",
      window: "five_hour",
      resetsAt: IN_ONE_HOUR,
      covered: false,
    })
    assert.equal(tracker.observe(ACCOUNT, headers), false)
  })

  it("prefers the weekly window unless the 5-hour grace resets later", () => {
    const tracker = createUsageLimitTracker(() => NOW)
    tracker.observe(
      ACCOUNT,
      quota({
        "grace-5h-utilization": 0.1,
        "grace-7d-utilization": 0.1,
        "5h-reset": IN_ONE_HOUR,
        "7d-reset": IN_ONE_DAY,
      }),
    )
    assert.deepEqual(tracker.status(ACCOUNT), {
      state: "grace",
      window: "seven_day",
      resetsAt: IN_ONE_DAY,
      covered: false,
    })
  })

  it("marks grace covered when extra usage pays for it", () => {
    const tracker = createUsageLimitTracker(() => NOW)
    tracker.observe(
      ACCOUNT,
      quota({
        "grace-5h-utilization": 0.1,
        "5h-reset": IN_ONE_HOUR,
        "overage-status": "allowed",
      }),
    )
    assert.deepEqual(tracker.status(ACCOUNT), {
      state: "grace",
      window: "five_hour",
      resetsAt: IN_ONE_HOUR,
      covered: true,
    })
  })

  it("reports approaching at 95% of the 5-hour window", () => {
    const tracker = createUsageLimitTracker(() => NOW)
    tracker.observe(
      ACCOUNT,
      quota({ "5h-utilization": 0.94, "5h-reset": IN_ONE_HOUR }),
    )
    assert.deepEqual(tracker.status(ACCOUNT), { state: "ok" })

    tracker.observe(
      ACCOUNT,
      quota({ "5h-utilization": 0.96, "5h-reset": IN_ONE_HOUR }),
    )
    assert.deepEqual(tracker.status(ACCOUNT), {
      state: "approaching",
      utilization: 0.96,
      resetsAt: IN_ONE_HOUR,
    })
  })

  it("ignores responses without unified quota headers", () => {
    const tracker = createUsageLimitTracker(() => NOW)
    tracker.observe(
      ACCOUNT,
      quota({ "grace-5h-utilization": 0.1, "5h-reset": IN_ONE_HOUR }),
    )
    assert.equal(
      tracker.observe(
        ACCOUNT,
        new Headers({
          "anthropic-ratelimit-unified-grace-5h-utilization": "0",
        }),
      ),
      false,
    )
    assert.equal(tracker.status(ACCOUNT).state, "grace")
  })

  it("ignores grace reported for a window that already reset", () => {
    const tracker = createUsageLimitTracker(() => NOW)
    tracker.observe(
      ACCOUNT,
      quota({ "grace-5h-utilization": 0.1, "5h-reset": NOW / 1000 - 5 }),
    )
    assert.deepEqual(tracker.status(ACCOUNT), { state: "ok" })
  })

  it("keeps quota separate per account", () => {
    const tracker = createUsageLimitTracker(() => NOW)
    tracker.observe(
      ACCOUNT,
      quota({ "grace-5h-utilization": 0.1, "5h-reset": IN_ONE_HOUR }),
    )
    assert.equal(tracker.status(ACCOUNT).state, "grace")
    assert.deepEqual(tracker.status("cred_b"), { state: "ok" })
  })

  it("clears once the window resets", () => {
    let now = NOW
    const tracker = createUsageLimitTracker(() => now)
    tracker.observe(
      ACCOUNT,
      quota({ "grace-5h-utilization": 0.1, "5h-reset": IN_ONE_HOUR }),
    )
    now = (IN_ONE_HOUR + 1) * 1000
    assert.deepEqual(tracker.status(ACCOUNT), { state: "ok" })
  })
})

describe("usage limit wrap-up", () => {
  const inGrace = () => {
    const tracker = createUsageLimitTracker(() => NOW)
    tracker.observe(
      ACCOUNT,
      quota({ "grace-5h-utilization": 0.1, "5h-reset": IN_ONE_HOUR }),
    )
    return tracker
  }

  it("leaves the body alone outside grace", () => {
    const tracker = createUsageLimitTracker(() => NOW)
    const body = JSON.stringify({
      messages: [prompt("go"), toolUse("t1"), toolResult("t1")],
    })
    assert.equal(tracker.annotate(ACCOUNT, "ses_a", body), body)
  })

  it("does not nudge the request that carries a fresh prompt", () => {
    const tracker = inGrace()
    const body = JSON.stringify({ messages: [prompt("go")] })
    assert.equal(tracker.annotate(ACCOUNT, "ses_a", body), body)
  })

  it("nudges once per turn and re-sends the note where it was first placed", () => {
    const tracker = inGrace()
    const turn = [prompt("go"), toolUse("t1"), toolResult("t1")]

    assert.deepEqual(notes(annotate(tracker, turn)), [[2, GRACE_WRAP_UP]])

    const later = [...turn, toolUse("t2"), toolResult("t2")]
    assert.deepEqual(notes(annotate(tracker, later)), [[2, GRACE_WRAP_UP]])

    const nextTurn = [
      ...later,
      prompt("continue"),
      toolUse("t3"),
      toolResult("t3"),
    ]
    assert.deepEqual(notes(annotate(tracker, nextTurn)), [
      [2, GRACE_WRAP_UP],
      [7, GRACE_WRAP_UP],
    ])
  })

  it("keeps sessions independent", () => {
    const tracker = inGrace()
    annotate(tracker, [prompt("go"), toolUse("t1"), toolResult("t1")], "ses_a")
    assert.deepEqual(
      notes(
        annotate(
          tracker,
          [prompt("go"), toolUse("x1"), toolResult("x1")],
          "ses_b",
        ),
      ),
      [[2, GRACE_WRAP_UP]],
    )
  })

  it("does not tell the model to stop when extra usage covers grace", () => {
    const tracker = createUsageLimitTracker(() => NOW)
    tracker.observe(
      ACCOUNT,
      quota({
        "grace-5h-utilization": 0.1,
        "5h-reset": IN_ONE_HOUR,
        "overage-in-use": "true",
      }),
    )
    const body = JSON.stringify({
      messages: [prompt("go"), toolUse("t1"), toolResult("t1")],
    })
    assert.equal(tracker.annotate(ACCOUNT, "ses_a", body), body)
  })

  it("sends the near-limit note once per 5-hour window", () => {
    const tracker = createUsageLimitTracker(() => NOW)
    tracker.observe(
      ACCOUNT,
      quota({ "5h-utilization": 0.97, "5h-reset": IN_ONE_HOUR }),
    )

    const turn = [prompt("go"), toolUse("t1"), toolResult("t1")]
    assert.deepEqual(notes(annotate(tracker, turn)), [[2, NEAR_LIMIT_WRAP_UP]])

    const nextTurn = [...turn, prompt("more"), toolUse("t2"), toolResult("t2")]
    assert.deepEqual(notes(annotate(tracker, nextTurn)), [
      [2, NEAR_LIMIT_WRAP_UP],
    ])
  })

  it("escalates to the grace note when grace starts after an approaching note", () => {
    const tracker = createUsageLimitTracker(() => NOW)
    tracker.observe(
      ACCOUNT,
      quota({ "5h-utilization": 0.97, "5h-reset": IN_ONE_HOUR }),
    )
    const turn = [prompt("go"), toolUse("t1"), toolResult("t1")]
    annotate(tracker, turn)

    tracker.observe(
      ACCOUNT,
      quota({ "grace-5h-utilization": 0.1, "5h-reset": IN_ONE_HOUR }),
    )
    const later = [...turn, toolUse("t2"), toolResult("t2")]
    assert.deepEqual(notes(annotate(tracker, later)), [
      [2, NEAR_LIMIT_WRAP_UP],
      [4, GRACE_WRAP_UP],
    ])

    const again = [...later, toolUse("t3"), toolResult("t3")]
    assert.deepEqual(notes(annotate(tracker, again)), [
      [2, NEAR_LIMIT_WRAP_UP],
      [4, GRACE_WRAP_UP],
    ])
  })

  it("uses the quota of the account the request is sent with", () => {
    const tracker = inGrace()
    const body = JSON.stringify({
      messages: [prompt("go"), toolUse("t1"), toolResult("t1")],
    })
    assert.equal(tracker.annotate("cred_b", "ses_a", body), body)
    assert.deepEqual(tracker.status("cred_b"), { state: "ok" })
  })

  it("does not duplicate a note when the same body is annotated twice", () => {
    const tracker = inGrace()
    const once = tracker.annotate(
      ACCOUNT,
      "ses_a",
      JSON.stringify({
        messages: [prompt("go"), toolUse("t1"), toolResult("t1")],
      }),
    )
    const messages = (JSON.parse(once) as { messages: Message[] }).messages
    const stripped = messages.map((message) =>
      Array.isArray(message.content)
        ? {
            role: message.role,
            content: message.content.filter((block) => block.type !== "text"),
          }
        : message,
    )
    assert.deepEqual(notes(annotate(tracker, stripped)), [[2, GRACE_WRAP_UP]])
  })

  it("matches Claude Code's grace text byte for byte", () => {
    assert.equal(
      GRACE_WRAP_UP,
      "[Usage limit reached \u2014 grace window active. Checkpoint now: finish the current step, then list up to 3 short bullets of the most impactful remaining work. Don't start subagents or long-running work.]",
    )
  })
})
