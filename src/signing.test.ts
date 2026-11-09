import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildBillingHeaderValue } from "./signing.ts"

describe("signing", () => {
  it("matches Claude Code 2.1.321 billing identity", () => {
    assert.equal(
      buildBillingHeaderValue("2.1.321", "cf7", "cli"),
      "x-anthropic-billing-header: cc_version=2.1.321.cf7; cc_entrypoint=cli;",
    )
  })

  it("uses explicit version components and entrypoint", () => {
    assert.equal(
      buildBillingHeaderValue("9.9.9", "abc", "custom"),
      "x-anthropic-billing-header: cc_version=9.9.9.abc; cc_entrypoint=custom;",
    )
  })
})
