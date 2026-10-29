# CI (GitHub Actions)

In CI there's usually no service to run. Set `JAYPOST_MODE=direct` and `jaypost send` talks to the chat app itself, using the provider, bot token and owner from env vars. `JAYPOST_MODE=service` is the default and uses the HTTP service as described above.

Run `jaypost setup-ci` once on your machine (`--provider NAME` picks the chat app). It prints a pairing code, waits for you to send it to the bot, then prints the env vars to store as GitHub secrets. It writes no files.

```
JAYPOST_MODE=direct
JAYPOST_PROVIDER=telegram
JAYPOST_BOT_TOKEN=...
JAYPOST_OWNER_ID=...
```

`setup-ci` pairs only the owner. To add approvers, run `jaypost pair approver` (`--provider NAME` as above). It gives one pairing code per person and asks `Pair another?` after each, then prints the ids paired in that run as a comma list. Add them to your own list and to the approvers secret; GitHub can't show a secret's value back, so `pair approver` can't print the full list for you. On Discord, an approver must be in a server the bot is in before they DM the code.

## Through a service by URL

If the runner can reach a jaypost service, it can use that one instead of direct mode, and the service keeps the only connection to the bot. Leave `JAYPOST_MODE` unset and point `send` at the service with an API key from `jaypost admin key create` (see [Hosting](hosting.md#share-a-bot-between-ci-workflows)); the contact book isn't read when these are set:

```
JAYPOST_URL=https://jaypost.example.com
JAYPOST_TOKEN=...
```

`-u`, `--require` and `--retry` go through the service the same way (see [Several approvers](#several-approvers)). A plain `request` exits 0 for any answer in service mode, so gate on its output or use a vote, which exits 3 when rejected. Use https for anything that leaves the machine, since the token goes with every call.

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
| `approvers`  |                 | voter ids from a secret; needs `require` (request)    |
| `require`    |                 | `all` or `majority`; needs `approvers` (request)      |
| `retry`      |                 | retries after a timeout, 0 to 100 (request)           |

For a vote, pass `approvers` and `require` together:

```yaml
- uses: bithyte/jaypost@v0
  with:
    text: Deploy ${{ github.ref_name }} to prod?
    options: 'Yes'
    default: 'No'
    approvers: ${{ secrets.PROD_APPROVERS }}
    require: majority
    retry: 5
    provider: ${{ secrets.JAYPOST_PROVIDER }}
    bot-token: ${{ secrets.JAYPOST_BOT_TOKEN }}
    owner-id: ${{ secrets.JAYPOST_OWNER_ID }}
```

The output `answer` is what the owner chose, e.g. `${{ steps.approval.outputs.answer }}`.

A No (the `default`) or a timeout fails the step (exit 3), so later steps don't run. Use `if: failure()` or `continue-on-error` to react to it. The message shows the repository name as the project and ends with a link to the workflow run.

Linux and macOS runners only. The action downloads the release binary for its own version, checked against `SHA256SUMS`. Pin `@v0` to follow releases or `@vX.Y.Z` to stay put. Pull requests from forks don't get secrets, so the step fails there with a message saying which input is empty.

## npx

Workflow example:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24
- run: npx jaypost request 'Publish v123?' -o Yes -d No
  env:
    JAYPOST_MODE: direct
    JAYPOST_PROVIDER: telegram
    JAYPOST_BOT_TOKEN: ${{ secrets.JAYPOST_BOT_TOKEN }}
    JAYPOST_OWNER_ID: ${{ secrets.JAYPOST_OWNER_ID }}
- run: npx jaypost notify 'New version published'
  env: # same four
```

In direct mode `request` exits with:

- 0: any answer other than the `-d` one
- 1: an error
- 2: bad arguments
- 3: the answer was the `-d` value, or the timeout fired

With `--allow-text`, a typed reply counts as the `-d` answer only when it equals the `-d` value exactly, case included.

So `-d No` works as a gate: the step fails unless someone approves. In service mode `request` still exits 0 for any answer, including the default.

## Several approvers

`-u ID` sends the question to a paired user instead of the owner. Repeat it for each approver, and each one gets their own message. `--require` sets how the votes decide:

- `all` (the default with `-u`): approved when every approver answers the `-o` button, rejected on the first `-d`.
- `majority`: approved when more than half of the listed approvers answer `-o`, rejected once that can't happen. A tie rejects.

```yaml
- run: npx jaypost request 'Publish v123?' -o Yes -d No -u 111 -u 222 -u 333 --require majority --retry 10
  env: # same four
```

`--retry N` asks again after a timeout, up to N more times (100 at most), and only the approvers who haven't answered. Votes already cast stand. Each round waits `--timeout` seconds. A vote that runs out of rounds is rejected, since a missing vote counts as `-d`. `--retry` alone re-asks a plain question, with no vote. `--require` without `-u` is a vote of one, the owner.

A vote exits 0 when approved, 3 when rejected, 1 on an error or a cancelled run, and 2 on bad arguments. It needs exactly one `-o`, a different `-d`, and no `--allow-text`. If a message can't be sent to one approver, the ones already sent are cancelled and the command exits 1. With `--json` it prints `{"answer","timedOut","approved","require","votes","rounds"}`, where `votes` maps each approver id to their answer, or `null` if they didn't answer.

Instead of `-u` flags, `JAYPOST_APPROVERS` can hold the ids, comma or space separated. That keeps them out of the workflow file when it comes from a secret, and a different secret per step gives each step its own approvers:

```yaml
- run: npx jaypost request 'Deploy prod?' -o Yes -d No --require majority
  env:
    JAYPOST_APPROVERS: ${{ secrets.PROD_APPROVERS }}
    # plus JAYPOST_MODE, JAYPOST_PROVIDER, JAYPOST_BOT_TOKEN, JAYPOST_OWNER_ID
```

Setting it means the same as passing those ids with `-u`: the question is a vote and `--require` defaults to `all`. If any `-u` is given, `-u` wins and the variable is ignored, not merged. A variable that is set but empty exits 2, because a misspelled or missing secret expands to an empty string and would otherwise send a plain question to the owner. `notify` ignores it.

On GitHub Actions the voter ids, from `-u` or `JAYPOST_APPROVERS`, are masked in the logs (shown as `***`) in direct mode. GitHub masks the secret as a whole but not the single ids inside a list.

All of this works in service mode too, through the service's [`POST /vote`](http-api.md#votes) and `retry`, with the same exit codes and output. A service older than this release can't do it, and `request` says so instead of asking once. In the Action, `approvers` and `require` go together.

Other differences from service mode:

- Notifications have no Dismiss button and aren't deleted automatically.
- The config file and the contact book aren't read.
- SIGINT and SIGTERM (a cancelled run) cancel a pending question, edit the message to the cancelled line and exit 1.
- Pairing in `setup-ci` and running a direct session both clear the bot's commands: on Telegram the owner's command menu is set to empty, on Discord the bot's global slash commands are replaced with none. If the same bot backs a running jaypost service, its commands are gone until that service restarts. Use a separate bot for CI.
