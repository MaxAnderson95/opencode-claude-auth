# Claude authentication plugin

The source checkout is `~/Projects_personal/opencode-claude-auth`. OpenCode v2 installs the package from `github:MaxAnderson95/opencode-claude-auth#main`; the package's root/server export is `src/v2.ts`.

## Development and verification

Edit and run checks in this checkout. Run `pnpm test`, `pnpm run lint`, and `pnpm run compile` before publishing a code change. Compilation is a development check; the installed V2 package loads TypeScript directly and needs no Git preparation/build lifecycle. Commit and push to Max's fork when authorized, then run `opencode2 plugin update 'github:MaxAnderson95/opencode-claude-auth#main'` and verify the installed revision, integration registration and an Anthropic request.

GitHub is the runtime source of truth. Local source edits do not deploy the plugin. OpenCode owns its installed package cache; do not edit that cache or maintain a separate live deployment host. Plan any required server restart after publication and account for active sessions.

Commit and push only when explicitly authorized by Max.
