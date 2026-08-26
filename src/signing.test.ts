import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildBillingHeaderValue } from "./signing.ts"

describe("signing", () => {
  it("matches Claude Code 2.1.234 billing identity", () => {
    assert.equal(
      buildBillingHeaderValue("2.1.234", "1a0", "sdk-cli"),
      "x-anthropic-billing-header: cc_version=2.1.234.1a0; cc_entrypoint=sdk-cli;",
    )
  })

  it("uses explicit version components and entrypoint", () => {
    assert.equal(
      buildBillingHeaderValue("9.9.9", "abc", "custom"),
      "x-anthropic-billing-header: cc_version=9.9.9.abc; cc_entrypoint=custom;",
    )
  })
})
