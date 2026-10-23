# CI (GitHub Actions)

In CI there's no service to run. Set `JAYPOST_MODE=direct` and `jaypost send` talks to the chat app itself, using the provider, bot token and owner from env vars. `JAYPOST_MODE=service` is the default and uses the HTTP service as described above.

Run `jaypost setup-ci` once on your machine (`--provider NAME` picks the chat app). It prints a pairing code, waits for you to send it to the bot, then prints the env vars to store as GitHub secrets. It writes no files.

```
JAYPOST_MODE=direct
JAYPOST_PROVIDER=telegram
JAYPOST_BOT_TOKEN=...
JAYPOST_OWNER_ID=...
```

After the owner pairs and the env vars print, `setup-ci` asks `Pair an approver?`. Say yes and it shows a fresh code for that person to send to the bot; repeat for each approver. When you're done it prints their ids as `-u ID` flags to pass to `send request` (see [Several approvers](#several-approvers)). `jaypost setup-ci --approvers-only` skips the owner and the env vars, to add approvers later. On Discord, an approver must be in a server the bot is in before they DM the code.

## GitHub Action

`uses: bithyte/jaypost@v0` asks or notifies the owner from a workflow, with no Node needed on the runner. Run `jaypost setup-ci` once to get the values for the three secrets (see above).

```yaml
on: workflow_dispatch
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - id: approval
        uses: bithyte/jaypost@v0
        with:
          text: Publish ${{ github.ref_name }}?
          options: |
            Yes
            No
          default: 'No'
          timeout: 1800
          provider: ${{ secrets.JAYPOST_PROVIDER }}
          bot-token: ${{ secrets.JAYPOST_BOT_TOKEN }}
          owner-id: ${{ secrets.JAYPOST_OWNER_ID }}
      - run: ./publish.sh
      - uses: bithyte/jaypost@v0
        with:
          command: notify
          text: Published ${{ github.ref_name }}
          provider: ${{ secrets.JAYPOST_PROVIDER }}
          bot-token: ${{ secrets.JAYPOST_BOT_TOKEN }}
          owner-id: ${{ secrets.JAYPOST_OWNER_ID }}
```

| Input        | Default         | Meaning                                               |
| ------------ | --------------- | ----------------------------------------------------- |
| `command`    | `request`       | `request` asks and waits, `notify` just sends         |
| `text`       |                 | the question or message (required)                    |
| `options`    |                 | answer buttons, one per line (request)                |
| `default`    |                 | answer on timeout, added as the last button (request) |
| `timeout`    | 300             | seconds to wait, 86400 at most (request)              |
| `allow-text` |                 | `true` also accepts a typed answer (request)          |
| `project`    | repository name | shown above the message                               |
| `format`     | `plain`         | `plain` or `markdown`                                 |
| `provider`   | `telegram`      | `telegram` or `discord`                               |
| `bot-token`  |                 | from a secret (required)                              |
| `owner-id`   |                 | from a secret (required)                              |

The output `answer` is what the owner chose, e.g. `${{ steps.approval.outputs.answer }}`.

A No (the `default`) or a timeout fails the step (exit 3), so later steps don't run. Use `if: failure()` or `continue-on-error` to react to it. The message shows the repository name as the project and ends with a link to the workflow run.

Linux and macOS runners only. The action downloads the release binary for its own version, checked against `SHA256SUMS`. Pin `@v0` to follow releases or `@vX.Y.Z` to stay put. Pull requests from forks don't get secrets, so the step fails there with a message saying which input is empty.

## npx

Workflow example:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24
- run: npx jaypost send request 'Publish v123?' -o Yes -d No
  env:
    JAYPOST_MODE: direct
    JAYPOST_PROVIDER: telegram
    JAYPOST_BOT_TOKEN: ${{ secrets.JAYPOST_BOT_TOKEN }}
    JAYPOST_OWNER_ID: ${{ secrets.JAYPOST_OWNER_ID }}
- run: npx jaypost send notify 'New version published'
  env: # same four
```

In direct mode `send request` exits with:

- 0: any answer other than the `-d` one
- 1: an error
- 2: bad arguments
- 3: the answer was the `-d` value, or the timeout fired

With `--allow-text`, a typed reply counts as the `-d` answer only when it equals the `-d` value exactly, case included.

So `-d No` works as a gate: the step fails unless someone approves. In service mode `send request` still exits 0 for any answer, including the default.

## Several approvers

`-u ID` sends the question to a paired user instead of the owner. Repeat it for each approver, and each one gets their own message. `--require` sets how the votes decide:

- `all` (the default with `-u`): approved when every approver answers the `-o` button, rejected on the first `-d`.
- `majority`: approved when more than half of the listed approvers answer `-o`, rejected once that can't happen. A tie rejects.

```yaml
- run: npx jaypost send request 'Publish v123?' -o Yes -d No -u 111 -u 222 -u 333 --require majority --retry 10
  env: # same four
```

`--retry N` asks again after a timeout, up to N more times (100 at most), and only the approvers who haven't answered. Votes already cast stand. Each round waits `--timeout` seconds. A vote that runs out of rounds is rejected, since a missing vote counts as `-d`. `--retry` alone re-asks a plain question, with no vote. `--require` without `-u` is a vote of one, the owner.

A vote exits 0 when approved, 3 when rejected, 1 on an error or a cancelled run, and 2 on bad arguments. It needs exactly one `-o`, a different `-d`, and no `--allow-text`. If a message can't be sent to one approver, the ones already sent are cancelled and the command exits 1. With `--json` it prints `{"answer","timedOut","approved","require","votes","rounds"}`, where `votes` maps each approver id to their answer, or `null` if they didn't answer.

All of this works in service mode too, through the service's [`POST /vote`](http-api.md#votes) and `retry`, with the same exit codes and output. A service older than this release can't do it, and `send` says so instead of asking once.

Other differences from service mode:

- Notifications have no Dismiss button and aren't deleted automatically.
- The config file isn't read, and `--port` is ignored.
- SIGINT and SIGTERM (a cancelled run) cancel a pending question, edit the message to the cancelled line and exit 1.
- Pairing in `setup-ci` and running a direct session both clear the bot's commands: on Telegram the owner's command menu is set to empty, on Discord the bot's global slash commands are replaced with none. If the same bot backs a running jaypost service, its commands are gone until that service restarts. Use a separate bot for CI.
