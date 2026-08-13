import { Plugin } from "@opencode-ai/plugin"
import { setup } from "./v2-setup.ts"

export {
  ensureSystemIdentity,
  setup,
  toOAuthCredential,
  INTEGRATION_ID,
  METHOD_ID,
  METHOD_LABEL,
} from "./v2-setup.ts"

export default Plugin.define({ id: "opencode-claude-auth", setup })
