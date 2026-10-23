# Claude Code

Two ways in: the plugin, which sets everything up in one install, or the hook and [MCP server](mcp.md) added by hand.

## Plugin

The plugin wires Claude Code to jaypost without editing settings. You need jaypost installed and `jaypost init` done first; the plugin doesn't install or pair anything.

```
/plugin marketplace add bithyte/claude-plugins
/plugin install jaypost@bithyte
```

It adds the hooks from [the manual setup](#hook-manual-setup), including [replies to a finished turn](#reply-with-the-next-prompt), the `jaypost` MCP server, a `jaypost:phone` skill that tells Claude when to ask and how to write questions and notices for the phone, and a check at session start that says what's missing: jaypost not installed, too old (run `jaypost update`), not running, a token problem, or not paired.

When jaypost isn't usable, prompts stay in the terminal quietly. The session-start message is the only notice.

Already set up by hand? Remove the `jaypost hook` entries from your settings and the `jaypost` MCP server (`claude mcp remove jaypost`), or every prompt reaches the phone twice. The session-start check warns about it.

The MCP tools are now named `mcp__plugin_jaypost_jaypost__*`, so update any permission rules written for `mcp__jaypost__*`.

The plugin has no `--port`, `--project` or `--timeout`, and no custom matcher. It ignores `PORT` and uses the installed port. For those, use the manual setup below.

## Hook (manual setup)

If you use the plugin, skip this section.

`jaypost hook` is a Claude Code hook command. It sends permission prompts to your phone and hands your tap back to Claude Code as the decision. It also forwards a few notifications (Claude is idle, needs input) as plain messages, and can [take your reply to a finished turn](#reply-with-the-next-prompt) as the next prompt. Claude Code doesn't need to know about jaypost; it just runs the command.

Add this to `~/.claude/settings.json`, or to a project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [{ "type": "command", "command": "jaypost hook", "timeout": 360 }]
      }
    ],
    "Notification": [
      {
        "matcher": "idle_prompt|elicitation_dialog|agent_needs_input",
        "hooks": [{ "type": "command", "command": "jaypost hook" }]
      }
    ]
  }
}
```

Not verified yet: whether Claude Code shows the terminal dialog while the hook is still running. The supported flow is to answer on the phone, or tap `Ask in terminal` to hand the prompt back to the keyboard. If a terminal answer doesn't stop the hook, the question stays in Telegram until its timeout. `--timeout 120` shortens that.

The buttons:

| Button            | Effect                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Allow`           | Allows this one call.                                                                                                                                                |
| `Always allow`    | Allows it and adds the rule Claude Code suggests, the same as its "don't ask again" choice. Only shown when Claude Code offers one and the rule fits in the message. |
| `Deny`            | Denies the call.                                                                                                                                                     |
| `Ask in terminal` | Makes no decision, so Claude Code shows its normal prompt.                                                                                                           |

A timeout behaves like `Ask in terminal`. Long inputs that don't fit in the message offer only `Deny` and `Ask in terminal`. `AskUserQuestion` always stays in the terminal.

- `PermissionRequest` has no matcher in the snippet, so every prompt goes to the phone. To narrow it, add `"matcher": "Bash|Edit|Write"` to that entry.
- The `Notification` matcher leaves out `permission_prompt` on purpose. That notification fires a few seconds after a prompt appears, and the `PermissionRequest` hook has already asked.
- `timeout: 360` is the default 300 s wait, the 30 s HTTP grace and some slack, so Claude Code doesn't kill the hook before the service answers. If you pass a longer `--timeout`, the Claude Code hook `timeout` must be at least `--timeout` + 60.
- Without the package on `PATH`, use `npx -y jaypost hook` as the command. npx adds startup time to every prompt.
- `--project NAME` sets the `[name]` line. Default is the Claude Code project folder.
- `--timeout S` is how long to wait for a tap on a permission prompt, or for a reply to a finished turn. Default 300 for prompts and 3600 for finished turns, max 86400 (24 h); longer values are capped.
- `--port N` picks the port as for [`mcp`](mcp.md), including `JAYPOST_PORT` and `JAYPOST_URL`.
- It finds the API token the same way `mcp` and `send` do: `JAYPOST_TOKEN`, else `~/.config/jaypost/token`.

It fails open. If the service is down or not paired, the hook does nothing and the terminal prompt works as usual. In `-p` (non-interactive) mode there's no terminal prompt, so no decision means Claude Code denies.

## Reply with the next prompt

When Claude finishes a turn and you don't type anything for a minute, jaypost sends Claude's last message to your phone. Reply with text and Claude picks it up as the next prompt, even though the session already stopped. Tap `Done`, or don't answer within the hour, and nothing happens.

The plugin does this out of the box. By hand, add these entries next to the ones above:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "jaypost hook", "asyncRewake": true, "timeout": 3720 }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [{ "type": "command", "command": "jaypost hook", "async": true }]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{ "type": "command", "command": "jaypost hook" }]
      }
    ]
  }
}
```

Then drop `idle_prompt` from the `Notification` matcher, or the same moment reaches your phone twice. The plugin already leaves it out.

How it works:

- `asyncRewake` runs the `Stop` hook in the background, so the terminal is free as soon as Claude finishes. A reply makes the hook exit 2, which wakes Claude with the reply as the next instruction.
- The one-minute wait means a prompt you type at the desk sends nothing. A prompt typed later, the next turn finishing, or the session ending cancels the question on the phone. The `UserPromptSubmit` and `SessionEnd` entries are what tell the waiting hook; they only remove a small marker file under `~/.config/jaypost/stop/` and don't call the service.
- Each reply needs you to type something, so a reply loop can't run on its own. `stop_hook_active` isn't checked.
- `--timeout S` on the `Stop` entry changes the hour. Keep the Claude Code `timeout` at least `--timeout` + 120 (the minute's wait plus HTTP grace), since Claude Code still kills an `asyncRewake` hook at its `timeout`.
- A long final message is cut at the end to fit one chat message (3000 characters at most).

Not verified yet: how Claude Code frames the woken-up reply in every version. It arrives as Stop hook feedback starting with "The user replied from their phone with the next prompt".
