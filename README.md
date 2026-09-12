# opencode-claude-auth

An OpenCode 2 plugin that authorizes Claude Pro and Max subscriptions directly with Anthropic OAuth. It does not read Claude Code credentials, require the Claude CLI, or synchronize tokens through Claude Code's Keychain and credential files.

This fork targets the V2 entrypoint at `src/v2.ts`. The repository still contains the upstream V1 implementation, but that implementation is not the runtime described here.

> [!WARNING]
> Anthropic does not document or support third-party use of the Claude Code subscription OAuth client. This plugin uses that client contract and can stop working if Anthropic changes or blocks it. OpenCode stores the resulting access and refresh tokens unencrypted in `~/.local/share/opencode/opencode.db`.

## Requirements

- OpenCode 2
- A Claude Pro or Max subscription
- A browser for Anthropic authorization
- Bun, Node.js, pnpm, and Git for building this fork

Claude Code is not required.

## Install

Install the V2 package from this fork on GitHub:

```sh
opencode2 plugin add 'github:MaxAnderson95/opencode-claude-auth#main'
```

The package's root and server exports resolve to `src/v2.ts`. The equivalent configuration is:

```jsonc
{
  "plugin": ["github:MaxAnderson95/opencode-claude-auth#main"],
}
```

To deploy a change, edit the source checkout, run checks, commit and push to this fork, then update the installed GitHub package:

```sh
opencode2 plugin update 'github:MaxAnderson95/opencode-claude-auth#main'
```

Verify the installed revision and an Anthropic request. OpenCode owns the package cache; source edits alone do not deploy it. If a restart is needed, account for attached clients before restarting the service.

## Connect an account

1. Open the OpenCode TUI.
2. Run `/connect`.
3. Select Anthropic.
4. Select `Claude Pro/Max subscription`.
5. Choose `Automatic`, `Paste code`, or `Local callback`.
6. Complete authorization in the browser. For paste-code login, copy the full `code#state` value from Anthropic's page into OpenCode.

`Automatic` selects paste-code login when the OpenCode server has `SSH_CONNECTION`, `SSH_CLIENT`, or `SSH_TTY` set, or runs on Linux without `DISPLAY` or `WAYLAND_DISPLAY`. Otherwise, it opens an ephemeral callback listener on `http://localhost:<port>/callback`. If it cannot create the listener, it falls back to paste-code login.

Paste-code login redirects to `https://platform.claude.com/oauth/code/callback`, so you can open the authorization URL on your own machine while OpenCode runs on a headless host. The plugin validates the state suffix before exchanging the code and uses the same PKCE verifier and redirect URI throughout the attempt.

Detection uses the server's environment. OpenCode opens the browser in its client and does not report browser-launch failures to the plugin. Choose `Paste code` explicitly when connecting to a remote server that detection misses; choose `Local callback` when the browser can reach the server's localhost, including through an SSH tunnel.

To connect another subscription, repeat `/connect`. OpenCode stores each account as a separate native Anthropic credential. Account activation, labels, and removal are handled by OpenCode rather than by a plugin-specific switcher or file.

## Credential storage and refresh

The plugin exchanges authorization codes and refresh tokens at:

```text
https://platform.claude.com/v1/oauth/token
```

OpenCode stores each returned OAuth credential in its SQLite database:

```text
~/.local/share/opencode/opencode.db
```

The database contains the access token, refresh token, expiry, credential label, and integration association. These values are not encrypted at rest. Protect the database with the same care as an API key or browser session.

OpenCode invokes the plugin's refresh callback before an OAuth credential expires. Refresh happens directly over HTTPS using `node:https`; it does not run `curl`, call the Claude CLI, or write tokens to Claude Code storage.

## Request behavior

The plugin rewrites Anthropic requests only while the active Anthropic connection is an OAuth credential. An API-key credential or `ANTHROPIC_API_KEY` connection keeps OpenCode's native Anthropic request path.

For subscription OAuth requests, the plugin:

- Sends the OAuth access token as `Authorization: Bearer`.
- Reproduces the Claude Code request URL, user agent, billing identity, beta headers, and model-specific request shape.
- Adds the Claude Code system identity and repairs tool-use adjacency when compaction leaves orphaned tool calls.
- Translates MCP tool names for Anthropic and reverses the translation in streamed responses.
- Derives a deterministic `X-Claude-Code-Session-Id` from the OpenCode session and active credential. Different accounts and sessions do not share one process-wide identity.
- Marks Anthropic model cost as zero in OpenCode while subscription OAuth is active.
- Retries long-context beta failures after removing the rejected beta.

The plugin applies these transforms to Anthropic models supplied by OpenCode's catalog. It does not maintain a separate supported-model list.

Pausing a session when Anthropic starts billing extra usage is handled by the separate `overage-guard` plugin, which reads the `anthropic-ratelimit-unified-*` headers on responses this plugin passes through. Load that plugin before this one so the Claude access token is resolved after any pause, not before it.

## Multiple accounts

Each login creates an independent OpenCode credential with its own access token, refresh token, expiry, and label. Switching the active connection takes effect without restarting OpenCode. Request identity also includes the credential ID, so switching accounts changes the Claude session identity for later requests.

No account state is stored in `auth.json`, macOS Keychain, `~/.claude/.credentials.json`, or `claude-account-source.txt` by the V2 entrypoint.

## Long context

The request transformer uses the beta set captured from the matching Claude Code request format. If Anthropic rejects a long-context beta with a recognized 400 or 429 response, the plugin excludes that beta for the model and retries the request. A plan-level message requiring extra usage still surfaces to the user.

## Configuration

The V2 entrypoint reads these environment variables:

| Variable                            | Purpose                                                                                     | Default                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `ANTHROPIC_CLI_VERSION`             | Claude Code version used in request identity headers.                                       | `config.ccVersion` in `src/model-config.ts` |
| `ANTHROPIC_USER_AGENT`              | Complete user-agent override.                                                               | `claude-cli/{version} (external, sdk-cli)`  |
| `ANTHROPIC_BETA_FLAGS`              | Comma-separated beta-header override.                                                       | `config.baseBetas` in `src/model-config.ts` |
| `CLAUDE_AUTH_DEBUG`                 | Enables structured diagnostic logging. Use `1` for the default path or provide a file path. | Disabled                                    |
| `OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS` | Maximum accepted delay from a 429 or 529 `retry-after` header during plugin retries.        | `30000`                                     |
| `OPENCODE_CLAUDE_AUTH_TOOL_REPAIR`  | Orphaned tool-use strategy: `placeholder` or `drop`.                                        | `placeholder`                               |

Legacy credential-source, refresh-lock, and Claude CLI environment variables belong to the V1 entrypoint and do not control V2 OAuth.

## Diagnostics

Enable append-only structured logging at the default path:

```sh
export CLAUDE_AUTH_DEBUG=1
```

The default log is:

```text
~/.local/share/opencode/claude-auth-debug.log
```

Set `CLAUDE_AUTH_DEBUG` to an absolute file path to write elsewhere. The logger redacts access tokens, refresh tokens, API keys, and JWT-shaped values. Review logs before sharing them because provider error messages can still contain account or request details.

Disable logging when finished:

```sh
unset CLAUDE_AUTH_DEBUG
```

## Verify

Check that OpenCode registered the OAuth method and stored connections:

```sh
opencode2 api get /api/integration/anthropic | jq '.data | {methods, connections}'
```

The methods list should include:

```json
{
  "id": "claude-subscription",
  "type": "oauth",
  "label": "Claude Pro/Max subscription"
}
```

Run the repository checks from the source checkout:

```sh
pnpm test
pnpm run lint
pnpm run compile
```

Use `pnpm run deploy:live` for the final verified deployment rather than copying individual files into the live plugin directory.

## Troubleshooting

| Symptom                                                  | Action                                                                                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Claude Pro/Max subscription` is missing from `/connect` | Confirm OpenCode loads the `current` plugin directory, deploy again from the source checkout, then restart the service once.                              |
| Browser authorization does not complete                  | Confirm the browser can reach the localhost callback and retry `/connect`.                                                                                |
| `Claude subscription credentials are unavailable`        | Connect or activate an Anthropic subscription credential through `/connect`.                                                                              |
| OAuth refresh fails                                      | Reconnect that account. Do not run Claude Code; it is not the credential source.                                                                          |
| A quota reset returns 429                                | Wait for the subscription limit to reset or activate another connected account. Long `retry-after` values surface instead of blocking OpenCode for hours. |
| Source changes do not appear                             | Run `pnpm run deploy:live`, wait for activation to finish, then run `opencode2 service restart`.                                                          |
| OpenCode sessions freeze during plugin work              | Stop editing or building in the live plugin directory. Work only in `~/Projects_personal/opencode-claude-auth` and deploy atomically.                     |

## Development workflow

Read [`AGENTS.md`](AGENTS.md) before changing this repository. All edits, installs, tests, lint, and builds happen in `~/Projects_personal/opencode-claude-auth`. The directory under `~/.config/opencode/plugins/opencode-claude-auth` is runtime state and must not be used as a development checkout.

The final deployment sequence is:

```sh
pnpm run deploy:live
opencode2 service restart
```

After reconnecting, verify service health, the Anthropic OAuth method, saved connections, and one inference request.

## License

MIT
