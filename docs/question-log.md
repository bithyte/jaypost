# Question log

The service keeps a log of every question and how it ended: answered, timed out, cancelled, or still open. Notifications aren't logged. `jaypost log` prints it, oldest first, newest at the bottom:

```
2026-10-19 00:41  deploy  Approve              Force-push main to origin?
2026-10-19 01:12  nas     Decline (timed out)  Delete 14 old snapshots?
2026-10-19 02:03          cancelled            Run migrations on prod?
2026-10-19 03:30  ci      interrupted          Merge #212?
```

The columns are the time asked (local), the project, the result and the first line of the question.

- `--since WHEN` shows questions asked at or after WHEN: a duration (`30m`, `12h`, `7d`), a local date (`2026-10-18`, meaning local midnight) or an ISO date-time.
- `--project NAME` matches the project name exactly.
- `-n N` (or `--limit N`) shows the last N. Without `--since` the default is 20; with `--since` you get all of them. An explicit `-n` always wins.
- `--json` prints one JSON object per line with the full text, the answer and both timestamps. For example, `jaypost log --since 7d --json | jq -r 'select(.status == "timedOut") | .text'`.

Statuses are `answered`, `rejected` (shown as `<answer> (rejected)`), `timedOut`, `cancelled`, `pending` (still waiting), `interrupted` (the service stopped before the question ended) and `expired` where the service recorded one. An outcome this version doesn't know is shown as is.

Where the log lives:

| Install                     | File                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| systemd, launchd            | `audit.jsonl` next to the config file, normally `~/.config/jaypost/` |
| Quadlet                     | `/data/audit.jsonl` in the `jaypost-data` volume                     |
| Compose                     | `/data/audit.jsonl` in the compose project's `data` volume           |
| no install, `start` by hand | next to `$JAYPOST_CONFIG` or the default config path                 |

At 10 MiB the file rotates to `audit.jsonl.1`, and the old `.1` is dropped, so about two files' worth of history is kept. `log` reads both. To delete the log by hand:

```
rm -f ~/.config/jaypost/audit.jsonl*
podman exec jaypost rm -f /data/audit.jsonl /data/audit.jsonl.1
docker compose -f ~/.config/jaypost/compose/compose.yaml exec bot rm -f /data/audit.jsonl /data/audit.jsonl.1
```

`uninstall` removes the log only when you also purge the credentials. Installs from 0.4.0 or earlier don't keep a log; run `jaypost init` to upgrade, then `log` works.
