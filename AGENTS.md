# Live plugin safety

OpenCode loads this plugin from the directory `~/.config/opencode/plugins/opencode-claude-auth/current`, whose entrypoint is `index.js`. Its background service watches the loaded module graph. Editing or rebuilding inside the live plugin directory can reload a partially written module and deadlock every session attached to that service.

## Development workflow

Use `~/Projects_personal/opencode-claude-auth` as the source checkout. Perform every source edit and every development command here, including dependency installation, formatting, tests, lint, TypeScript compilation, interception scripts, and generated-file updates.

Treat `~/.config/opencode/plugins/opencode-claude-auth` as a runtime deployment host. Its `runtime/live` branch is frozen. Never edit files there, run package-manager commands there, delete its `dist` directory, copy individual build artifacts into it, or switch its branch.

Before changing code, verify the physical checkout:

```sh
test "$(pwd -P)" = "$HOME/Projects_personal/opencode-claude-auth"
```

If the command fails, move to the source checkout before doing any work.

## Verification and deployment

Run normal checks in the source checkout while iterating. When the complete change is ready, deploy it once:

```sh
pnpm run deploy:live
```

The deploy script runs the full test, lint, and build sequence out of band. It bundles the V2 entrypoint and its runtime dependencies into an immutable release under `~/.local/share/opencode/plugin-releases/opencode-claude-auth/`, then atomically replaces the live `current` symlink. This atomic replacement is the only allowed write to the loaded plugin path.

Deploy once at the end of a task. Further edits require another complete verification and deployment. After the deploy script reports the activated release, run `opencode2 service restart` as the final deployment command. The current agent tool call will be interrupted when its host service stops; reconnect and verify `/api/health`, the Anthropic integration methods, and one inference request. This single planned restart is expected. Never restart the service while a build is writing files.

Do not commit or push unless the user explicitly requests it.
