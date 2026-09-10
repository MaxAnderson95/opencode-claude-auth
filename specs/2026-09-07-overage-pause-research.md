# Anthropic overage pause feasibility

Research date: 2026-09-07. OpenCode session: `ses_f819bd979ffeGjtZH7SyXWr9XS`.

## Finding

A server-side overage gate with a native session form is feasible. OpenCode can create the same pending-input UI used by its question tool without manufacturing an assistant tool call. Creating a form does not suspend model execution: the plugin must separately block outbound requests until the user decides.

This is a source-backed design proposal, not an implemented or end-to-end verified pause feature.

## Evidence and versions

- The installed CLI reports `opencode2 v0.0.0-beta-19242`.
- The live server's `GET /openapi.json` advertises session form create, list, get, state, reply, and cancel routes.
- OpenCode source inspected at `cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b` in `~/.btca/agent/sandbox/opencode-beta`. Fetched `origin/beta` is `11e2e0a59ff08367c6ea2e21fb08be020ee2c815`. Comparison found package renames but no change to the relevant form lifetime, plugin context omission, or HTTP hook ordering. The inspected commit is not claimed to be the installed binary's exact build commit.
- Earlier in this session, one Haiku streaming request returned HTTP 200 with `anthropic-ratelimit-unified-overage-in-use: true`, five-hour utilization `1.0`, and weekly utilization `0.16`. It consumed 27 input and 4 output tokens. This follow-up research made no additional Anthropic requests.

## Native questions without model tool calls

The built-in question tool calls `Form.Service.ask`. It supplies session ownership, fields, and metadata identifying the originating tool. The form implementation itself does not require a tool call. Its create operation validates fields, stores a pending entry, and publishes `form.created`.

https://github.com/anomalyco/opencode/blob/cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b/packages/core/src/tool/plugin/question.ts#L62-L106

https://github.com/anomalyco/opencode/blob/cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b/packages/core/src/form.ts#L118-L155

The public route is `POST /api/session/{sessionID}/form`. Its payload has title, fields, optional metadata, and optional ID. The handler creates the form without calling a model or modifying assistant tool-call history. Replies and cancellation are separate routes. The full client exposes `form.create`, `form.state`, `form.reply`, and `form.cancel`.

https://github.com/anomalyco/opencode/blob/cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b/packages/protocol/src/groups/form.ts#L15-L20

https://github.com/anomalyco/opencode/blob/cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b/packages/server/src/handlers/form.ts#L53-L73

https://github.com/anomalyco/opencode/blob/cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b/packages/client/src/effect/api/api.ts#L1464-L1500

The native TUI adds `form.created` to pending forms without requiring a preceding tool-call event.

https://github.com/anomalyco/opencode/blob/cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b/packages/tui/src/mini/stream-v2.transport.ts#L1287-L1295

The current Promise plugin context does not expose the full client's `form` domain. Implementation therefore needs authenticated access to the existing server API, or an OpenCode plugin-context addition exposing forms. Do not assume `ctx.form.ask` exists. Creating a form via HTTP also does not provide the internal blocking `ask` operation: subscribe to reply/cancel events and reconcile state to avoid a create/subscribe race.

https://github.com/anomalyco/opencode/blob/cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b/packages/plugin/src/promise/plugin.ts#L25-L52

No synthetic assistant `tool_use` or matching `tool_result` needs to be inserted into the provider conversation. A model-facing explanation, if desired, is separate from the control form.

## Request gating and session trees

OpenCode awaits session hook callbacks. Its HTTP middleware awaits `http.request` before sending and runs `http.response` after the upstream response arrives, before converting it back for consumption. The plugin already uses both hooks in `src/v2-setup.ts`.

https://github.com/anomalyco/opencode/blob/cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b/packages/core/src/plugin/hooks.ts#L88-L99

https://github.com/anomalyco/opencode/blob/cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b/packages/core/src/session/model-request.ts#L242-L269

Recommended behavior:

1. On an overage response, close a shared gate for the root session and its descendants immediately, and create one form owned by the root.
2. Consume already-started responses normally. Holding an upstream SSE stream for hours does not pause Anthropic generation and risks stale sockets.
3. Hold subsequent model requests at a pre-request hook. Gate before resolving credentials so an hours-long wait does not preserve an expired access token. Include compaction, title, transient generation, and retry paths rather than guarding only the ordinary agent loop.
4. All descendants consult the same gate. A child question alone does not pause other children. Resolve ancestry through `parentID`; coordinate across location-specific plugin instances if sessions move to different working directories.
5. If the desired behavior includes stopping tool dispatch, gate new tool executions too. Already-running shell commands and already-started inference will not be frozen by a model-request gate.
6. On resume, release existing waits rather than submit a new prompt, preserving the suspended execution's continuation while the process remains alive.

The model-request hook includes primary, compaction, title, and generate request kinds. The Promise adapter waits on callback promises, but does not pass a hook cancellation signal into the callback. Cancellation and cleanup of outstanding plugin promises therefore require deliberate handling and tests.

https://github.com/anomalyco/opencode/blob/cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b/packages/plugin/src/promise/session.ts#L33-L83

https://github.com/anomalyco/opencode/blob/cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b/packages/plugin/src/promise/adapter.ts#L563-L567

Foreground subagent waits have interruption cleanup that interrupts the child. Background subagents return immediately and run through job ownership. `session.interrupt` targets one session; it is not a documented recursive stop. A Stop-all choice must explicitly handle descendants and background jobs, rather than rely on interrupting only the parent.

https://github.com/anomalyco/opencode/blob/cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b/packages/core/src/tool/plugin/subagent.ts#L151-L205

https://github.com/anomalyco/opencode/blob/cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b/packages/core/src/session/subagent-job.ts#L36-L59

https://github.com/anomalyco/opencode/blob/cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b/packages/core/src/session/session.ts#L324-L327

## Choices and resuming after reset

A proposed root form can say: "Anthropic extra usage detected. New requests for this session and its subagents are paused. Leave this unanswered to keep waiting."

- **Resume after reset:** permit one waiting Anthropic request to confirm its response is back within subscription usage; keep sibling requests parked until confirmation. If it still reports overage, pause again. This avoids releasing all subagents on an assumption about reset time.
- **Allow extra usage:** explicitly allow the group to continue for a defined scope, such as the current reset window. This scope needs a decision before implementation.
- **Stop session and subagents:** interrupt the group and use the existing manual continuation workflow later.

Leaving the form pending is the wait action. A "Wrap up" choice would require more model calls and is distinct from an immediate stop.

Manual resume plus a single controlled inference request can avoid continuous usage polling. A usage-endpoint check on resume is another option, but it is separate from the zero-extra-call response-header path. Missing overage headers must be treated as unknown rather than proof that spending has returned to the subscription.

## Lifetime and recovery

Pending forms have infinite cache TTL. The ten-minute retention applies only after settlement. Forms and their deferred waiters are in-memory; location teardown cancels pending forms. Therefore phone disconnection and a server restart are different cases. A long-lived live server can retain the question; a restart cannot preserve the original JavaScript continuation.

https://github.com/anomalyco/opencode/blob/cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b/packages/core/src/form.ts#L99-L109

https://github.com/anomalyco/opencode/blob/cd9d06c1ca0d5098178c0d4b929aa8a7fde8c69b/packages/core/src/form.ts#L192-L221

A restart-safe implementation should persist the closed gate and recover conservatively before allowing model requests. It may recreate the form and require continuation rather than claim to restore an exact suspended turn. Reconnect, plugin reload, account changes, new descendants, duplicate replies, and cancellation are acceptance criteria for implementation.

## T3 Code compatibility

Max's local T3 fork at `/Users/max/Projects/tries/2026-08-12-t3-code-fixes/fork` has the required native form path. Its working tree contains uncommitted OpenCode2 support, so commit-only links would not describe these findings accurately. The configured development service points to this checkout's built server; correspondence between every source edit and the deployed phone experience remains unverified.

Directly inspected:

- `apps/server/src/provider/Layers/OpenCodeAdapter.ts:1044-1067` accepts forms with `metadata.kind: "question"` and string/multiselect fields. It does not require tool metadata or a transcript tool call.
- `OpenCodeAdapter.ts:3277-3320` turns form creation into `user-input.requested`, and reply/cancellation into `user-input.resolved`.
- `OpenCodeAdapter.test.ts:4672-4716` contains a recovery fixture with question metadata and no tool reference.

The companion T3 investigation traced web/native rendering and reply routing. Use one root-owned form because pending-form recovery lists root forms and the v2 descendant event route does not recursively adopt arbitrary grandchildren. Make option labels equal their values because the adapter replies using labels. Validate decisions server-side; the adapter normalization does not preserve the restriction against custom answers. Its orphan cleanup and incomplete terminal-event reconciliation make phone disconnect/reconnect an important end-to-end test.

Source-backed expectation: the native question card can work without changing T3 or adding a TUI plugin. This was not exercised on the deployed phone UI.

## Verification performed

- Read current plugin implementation and OpenCode form, hook, execution, subagent, HTTP handler, client, and TUI sources.
- Confirmed form routes in the running server's OpenAPI.
- Attempted the narrow existing Form test entrypoint, but the BTCA checkout has no dependencies installed, so tests did not execute. No dependencies were installed.
- No pause feature was installed, no service restarted, and no additional Anthropic inference requests were made during this follow-up.
- T3 Code-specific adapter findings are recorded separately in `/Users/max/scratch/anthropic-overage-t3-question-research.md`.
