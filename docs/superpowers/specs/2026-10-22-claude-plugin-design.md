# jaypost Claude Code plugin design

## Intent

Wiring jaypost into Claude Code takes two hand edits today: the `PermissionRequest` and `Notification` hooks in `settings.json` (README.md:149-193), and `claude mcp add jaypost -- jaypost mcp` for the MCP server (README.md:109-123). The plugin replaces both. Someone installs the plugin and gets the same hooks and the same MCP server, without touching a config file.

Installing jaypost and running `jaypost init` (service, pairing, API token) stays separate. The plugin assumes the user does that, and tells them once per session when they haven't.

## Goals

- A Claude Code plugin in this repo that declares:
  - the `PermissionRequest` hook running `jaypost hook` with `timeout: 360`, as in the README;
  - the `Notification` hook running `jaypost hook`, with the matcher the README uses (README.md:163-168, which leaves out `permission_prompt` on purpose, README.md:187);
  - the `jaypost mcp` stdio MCP server, registered as `jaypost`;
  - a new `SessionStart` hook that runs the setup check below.
- A setup check at session start. It shows one message when jaypost isn't usable and says nothing when it is.
- `PermissionRequest` and `Notification` stay quiet when jaypost isn't usable: no per-prompt error noise, and the terminal prompt shows as if there were no hook.
- A warning at session start when jaypost hooks are also configured by hand in settings, since both would fire and every prompt would reach the phone twice.
- A README section for the plugin. It leads with the plugin and keeps the manual `settings.json` / `claude mcp add` setup as the alternative for people not using the plugin.

## Non-goals

- Installing jaypost, running `init`, pairing, or starting the service from the plugin.
- Falling back to `npx -y jaypost` when the binary isn't on PATH. The user decided against it: missing binary means a hint to install, not a slower fallback.
- The marketplace. It goes in a separate repo `bithyte/claude-plugins` (marketplace name `bithyte`), which points at this repo. Writing that marketplace entry is out of scope here; this repo only has to be pointable.
- Skills, slash commands or agents in the plugin. Not discussed; hooks and MCP only.
- Windows. Release targets are Linux and macOS only (scripts/build-exe.ts:13-18).

## Anti-goals

- A hook that blocks or denies anything because jaypost is missing or down. Failures must always fall back to the normal terminal prompt.
- A hint on every permission prompt or notification. The user picked session start specifically so it isn't annoying.
- Registering jaypost's MCP server or hooks for contributors who open this repo in Claude Code. The plugin files must not double as project config for the repo itself.

## Behavior

### Setup check (SessionStart)

Runs once per session. Checks in this order and stops at the first failure:

1. `jaypost` on PATH. If not: tell the user to install it (npm, or `install.sh` from the README).
2. The service answers `GET /status` on the resolved port with the resolved token. Map the `Caller.status` failure (src/client/caller.ts:176-222, reasons in src/client/types.ts) to a fix:
   - `unreachable`: service isn't running at `127.0.0.1:<port>`. Run `jaypost init` (or start the service).
   - `unusableToken`, `unauthorized`: token problem. Run `jaypost init`; in a container, set `JAYPOST_TOKEN`.
   - anything else: show the failure's message.
3. `/status` says `paired: false`: not paired yet. Run `jaypost init` to pair.
4. Duplicate config: `jaypost hook` appears in a hook command in `~/.claude/settings.json`, `<project>/.claude/settings.json` or `<project>/.claude/settings.local.json` (project dir from the SessionStart input's `cwd`, or `CLAUDE_PROJECT_DIR`). If so: warn that hooks are set up both in settings and by the plugin, and to remove the settings ones. This check runs even when 1-3 pass.

Note that "never ran `init`" usually shows up as `unreachable`, not as a token error. Without a token file `resolveClientToken` returns `none` (src/auth/token.ts:77-78), not `unusable`, so the request goes out and fails because no service is listening.

All passing: no output. The message must be visible to the user, not only to Claude. I think that's the `systemMessage` field in hook JSON output, but the builder should confirm against current Claude Code docs. Exit code is 0 either way; a failed check isn't a hook error.

### PermissionRequest and Notification when jaypost isn't usable

Today `runHook` exits 1 with a stderr line on any failure (src/hook/runner.ts:14-18, 115-121), and a missing binary exits 127 from the shell. Under the plugin, these become silent fallbacks: no decision, terminal prompt shows. Failures after a passing setup check (the service dies mid-session, a send fails) are silent too. That's my call: the wrapper can't tell them apart from "never set up" without duplicating jaypost's logic, and the terminal prompt still shows, so nothing is lost but the phone message.

Behavior for people using the hooks by hand without the plugin should not regress, and the plugin has to work with older binaries (see "My calls"). So the silencing lives in the plugin's wrapper: it swallows the binary's non-zero exit and stderr and exits 0 with no output, which Claude Code treats as no decision. `jaypost hook` itself stays as it is for manual users.

### MCP server

Declared by the plugin, same command as `claude mcp add jaypost -- jaypost mcp`. It goes through the same wrapper, so a missing binary gives a readable stderr line (visible in `/mcp`) instead of a spawn error. The existing behavior when the service is down stays as it is: the server stays up and tool calls return an error (README.md:145).

## Decided

- Plugin bundles hooks and MCP only; `init` stays separate.
- Missing binary: fail with an install hint. No npx fallback.
- Hint shows once at session start, not per prompt.
- Duplicate hook config gets a session-start warning; README tells people to remove the manual config when using the plugin.
- Marketplace lives in another repo, marketplace name `bithyte`. README install commands: `/plugin marketplace add bithyte/claude-plugins` then `/plugin install jaypost@bithyte`. No marketplace.json in this repo.
- Hook options: the user left it to me, see "My calls".

## My calls (not discussed with the user)

- Plugin lives in a subdirectory, `claude-plugin/`, not the repo root. The marketplace can point at it with a `git-subdir` source (`url`, `path`, `ref`, `sha`), which the official marketplace already uses. That keeps root `.mcp.json` / `hooks/` out of the repo, so contributors opening the repo in Claude Code don't get jaypost registered. It also means the plugin cache copy doesn't include the whole repo.
- A small POSIX `sh` wrapper in the plugin handles "not on PATH", because jaypost's own code can't run in that case. Everything else (token, port, `/status`, pairing, duplicate settings) goes in jaypost itself, since it already knows how to resolve the port (`resolveMcpPort`) and the token (`resolveClientToken`). I'd add `SessionStart` as a third event kind in src/hook/ (parser, types, runner), alongside `PermissionRequest` and `Notification`.
- Plugin `version` in `plugin.json` matches package.json. The `version-packages` script (package.json) bumps it with the rest, and a test asserts they're equal. The marketplace entry can then pin `ref: vX.Y.Z` (releases land on `vX.Y.Z` tags, .github/workflows/publish.yml:112-123).
- No user settings in the plugin. Hooks run with defaults: project is the Claude Code project folder, timeout 300 s. People who need `--project`, `--timeout` or a custom matcher use the manual setup, and the README says so. The wrapper unsets `PORT` before running `jaypost hook` and `jaypost mcp`. In a plugin, `PORT` is almost always the user's own app (the README.md:192 warning). Without it, `resolveMcpPort` falls through to install.json, which records the port `init` used, then 8787. So a non-default port still works with no flag. `JAYPOST_TOKEN` passes through untouched.
- Version skew. The plugin is pinned to a tag, but the binary updates on its own (`jaypost update`, npm, install.sh), so a new plugin will meet an old binary. So the per-prompt silencing lives in the wrapper, not behind a new `jaypost hook` flag that an old binary's commander would reject on every prompt. The wrapper sends SessionStart to `jaypost hook`. If the binary exits with `unsupported hook event` (src/hook/parser.ts:92), the check reports "jaypost is too old for this plugin, run `jaypost update`". That's an extra check between 1 and 2.
- Binary lookup: the wrapper tries PATH, then `~/.local/bin/jaypost`. install.sh puts it there (install.sh:8) without checking PATH, and Claude Code started from a GUI or IDE often lacks that directory. This finds an installed binary, so it's not the rejected npx fallback. The "install jaypost" hint only shows when both miss.
- The duplicate check also covers a jaypost MCP server added by hand (`claude mcp add`, so `~/.claude.json` and the project `.mcp.json`). Same reason as the hooks: the plugin's server runs through the wrapper, so Claude Code won't dedupe it and Claude would see two sets of jaypost tools.
- Plugin name `jaypost`, so the plugin's MCP tools are namespaced `mcp__plugin_jaypost_jaypost__*` rather than `mcp__jaypost__*`. README should note that permission rules written against the old names need updating.
- `SessionStart` matcher: all sources (startup, resume, clear, compact) or just `startup`. I'd go with `startup` and `clear`; resume and compact repeating the message is noise.

## Left to the builder

- Wrapper file name and layout inside `claude-plugin/`, and whether hooks/MCP are inline in `plugin.json` or in `hooks/hooks.json` / `.mcp.json` inside the plugin dir.
- Exact wording of each message. Keep it to one or two lines, with the command to run.
- Timeouts for the SessionStart check. It must not delay session start noticeably when the service is down; a short HTTP timeout on `/status` is fine.
- Tests. Follow test/hook/ for the hook side (real HTTP server on port 0). The wrapper can be tested by spawning it with a PATH that lacks `jaypost`.
- Code style: follow src/hook/ as it is (plain exported functions, zod parsing, `HookDeps` injection).

## Open questions

- Not verified: whether Claude Code shows a non-blocking hook's stderr to the user outside verbose mode. Doesn't change the design, since the plugin doesn't rely on it.
- Not verified: how Claude Code treats a plugin hook and an identical settings hook. If it dedupes identical commands, the duplicate warning is mostly moot. But the plugin's command will be the wrapper path, not `jaypost hook`, so I don't expect a dedupe.
