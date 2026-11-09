import { createHash } from "node:crypto"
import type { Credential } from "@opencode/plugin"
import type { Rpc } from "@opencode/plugin/rpc"

export const LOGIN_OPTIONS = [
  {
    value: "auto",
    label: "Automatic",
    description: "Use paste-code login on SSH or headless Linux hosts",
  },
  {
    value: "manual",
    label: "Paste code",
    description: "Authorize in a browser on another machine",
  },
  {
    value: "local",
    label: "Local callback",
    description: "Browser can reach this server's localhost",
  },
] as const

export interface ReloginInput {
  credentialID: string
  fingerprint: string
  expires: number
  loginMode: "auto" | "manual" | "local"
}

export interface ReloginAttempt {
  id: string
  mode: "auto" | "code"
  url: string
  instructions: string
}

export function credentialFingerprint(
  credential: Pick<Credential.OAuth, "access" | "refresh" | "expires"> & {
    methodID: string
  },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        credential.methodID,
        credential.access,
        credential.refresh,
        credential.expires,
      ]),
    )
    .digest("hex")
}

const ID = { type: "string", minLength: 1 } as const
const EMPTY = { type: "object", additionalProperties: false } as const
const ERRORS = { failed: EMPTY } as const
const ATTEMPT_INPUT = {
  type: "object",
  properties: { id: ID },
  required: ["id"],
  additionalProperties: false,
} as const

export const ReloginRpc = {
  id: "opencode-claude-auth.relogin",
  methods: {
    begin: {
      input: {
        type: "object",
        properties: {
          credentialID: ID,
          fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
          expires: { type: "integer", minimum: 0 },
          loginMode: { enum: ["auto", "manual", "local"] },
        },
        required: ["credentialID", "fingerprint", "expires", "loginMode"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          id: ID,
          mode: { enum: ["auto", "code"] },
          url: ID,
          instructions: { type: "string" },
        },
        required: ["id", "mode", "url", "instructions"],
        additionalProperties: false,
      },
      errors: ERRORS,
    },
    complete: {
      input: {
        ...ATTEMPT_INPUT,
        properties: { id: ID, code: { type: "string" } },
      },
      output: EMPTY,
      errors: ERRORS,
    },
    commit: { input: ATTEMPT_INPUT, output: EMPTY, errors: ERRORS },
    cancel: { input: ATTEMPT_INPUT, output: EMPTY, errors: ERRORS },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition
