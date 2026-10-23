# Shell and Node

## From the shell

`jaypost send` wraps `/request` and `/notify` so scripts don't need curl:

```
answer=$(jaypost send request 'Deploy?' -o Approve -d Decline --timeout 60)
jaypost send notify 'backup finished' --project nas
jaypost send request $'Force-push `main`?' -o Yes -d No --format markdown
git diff | jaypost send request 'Ship it?' -o Yes -d Stop --attach - --attach-name changes.diff
```

`send request` prints the answer on stdout (the `-d` default on timeout) and exits 0. `--json` prints `{"answer":"...","timedOut":false}` instead, if you need to tell a timeout from a tap. `-o` repeats once per button; `-d` adds the default as the last button unless an `-o` already names it. `--allow-text` also lets you answer by replying with text; then `-o` is optional and `-d` can be any short answer, not added as a button. `send notify` prints nothing and exits 0 once sent. `--format markdown` on either one reads the text as [markdown](formatting.md). Errors go to stderr with exit 1, and bad arguments exit 2. Ctrl-C cancels a pending question, which edits the Telegram message to a "cancelled" line. `--attach FILE` sends a file along with the message (10 MiB at most; the service's limit applies); `--attach -` reads stdin, named `attachment.txt` unless `--attach-name NAME` says otherwise. `--attach-name` without `--attach` exits 2. The port is picked the same way as for [`mcp`](mcp.md).

In [direct mode](ci.md), `-u ID` sends the question to an approver instead of the owner (repeat it for each one; `JAYPOST_APPROVERS` is the env alternative, ids separated by commas or spaces), `--require all|majority` decides the vote, and `--retry N` (0 to 100) asks again after a timeout; see [Several approvers](ci.md#several-approvers) for the exit codes and `--json` output. In service mode those three exit 2.

## From Node

`npm i jaypost` and use the `Client`, which wraps the same two endpoints:

```ts
import { Client } from 'jaypost'

const client = new Client({ project: 'deploy' })
const { answer, timedOut } = await client.request({
  text: 'Deploy?',
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
  timeout: 60,
})
await client.notify({ text: 'backup finished' })
```

`new Client()` takes optional `host` (default `127.0.0.1`), `port` (default 8787), `token` and `project`, which every call sends unless it passes its own. Without `token`, each call looks one up: `JAYPOST_TOKEN` if set, else the token file, else none is sent. An invalid `token` throws a `RangeError`. `request` takes the [`/request` fields](http-api.md#ask-a-question) plus an optional `signal`, and `request` and `notify` take `format: 'markdown'` (see [Formatting](formatting.md)). When you put untrusted text into a markdown message, `escapeMarkdown(text)` makes it show as typed and `formatCodeBlock(code, language?)` wraps code in a fence that can't be closed from inside. Both are exported from the package; aborting it cancels the question and rejects with the signal's reason. Failures (service down, a 400, a send error) throw a `JaypostError` with the same message the CLI prints. A timeout isn't a failure: it resolves with `timeoutOption` and `timedOut: true`.

`request` and `notify` also take an `attachment`, one file sent along with the message (see the HTTP `attachment` field for limits):

```ts
type AttachmentInput =
  | { path: string; name?: string } // read from disk; name defaults to the basename
  | { name: string; text: string }
  | { name: string; data: Uint8Array }
```

The file is read and checked against the service's limit before anything is sent, so a missing file, an oversize file or a provider without attachment support fails with a `JaypostError` up front. Attachments need a service at least as new as this client; an older one fails with a message telling you to run `jaypost init`.
