# Relay server prep

## Intent

Some people want a secure, remotely hosted jaypost instead of the local daemon: one server that runs one or more bots, which agents, scripts and CI pipelines all reach over the network. Pipelines matter most here, because today a pipeline that wants the same bot as the daemon has to use direct mode, and two processes polling one Telegram bot fight over its updates.

The relay should be a drop-in replacement for the daemon: same HTTP API, same clients, pointed somewhere else with an env var and a token. This change doesn't build the relay. It moves the seams so the relay is mostly new wiring, not a rework.

## What this change does

1. **Clients call a URL, not a local port.** `Caller` takes a `ServiceEndpoint` (a base URL, or an `invalid` one that fails every call with reason `invalidUrl`, like an unusable token does). `http.ts` speaks http or https and puts the URL's path in front of every API path, so a relay can sit behind a reverse proxy at `/team`. `send`, `hook` and `mcp` read `JAYPOST_URL` after `--port` and before `JAYPOST_PORT`; `Client` takes `url`, then `host`/`port`, then `JAYPOST_URL`. `status`, `test`, `init` and pairing still talk to the local install on purpose.
2. **A bot is separate from the HTTP API.** `ApiBot` (src/server/types.ts) is everything the API needs from one bot: its approval service, notifications, status and provider limits. `createApiServer(router)` asks a `BotRouter` for the call's bot from its Authorization header before reading the body, and answers 401 when there's none. The daemon uses `createSingleBotRouter({ ...bot, auth })`. A relay would use a router that maps each token to its bot.
3. **Starting a bot is separate from serving it.** `startBot` (src/daemon/bot.ts) starts one provider runtime with its state, audit log, quiet hours and pairing, and returns an `ApiBot`. `startService` is now `startBot` plus a single-bot API.

The HTTP API and its OpenAPI document don't change.

## What the relay still needs

- **Config for several bots**: one `Config` and data directory per bot, plus the token(s) that reach each one. `startBot` already keeps a bot's files next to its `configPath`.
- **A multi-bot router**: token to bot, compared in constant time like `isAuthorized`. Several tokens per bot (one per pipeline) would let one be revoked without the others.
- **Votes and retries over HTTP**: `-u`, `--require` and `--retry` only exist in direct mode (src/direct/session.ts drives `runVote` and `askWithRetries` in-process). A pipeline that shares a bot through the relay needs them as API routes, and `send` needs to stop requiring `JAYPOST_MODE=direct` for them. The vote logic is already in the approval core, so this is routes plus wire types.
- **TLS and exposure**: the relay should run behind https. Clients don't refuse plain http to a non-loopback host today; whether they should is open.
- **Per-bot logging**: the API's log lines name the provider, not the bot.

## Calls I made

- `--port` beats `JAYPOST_URL`, since a flag is the more explicit choice, and `JAYPOST_URL` beats `JAYPOST_PORT`, since the env files of container installs set `JAYPOST_PORT` for the daemon.
- A bad `JAYPOST_URL` fails each call instead of exiting early, so `hook` and `mcp` report it the same way they report a bad token. The message never repeats the value, which could hold credentials. URLs with credentials, a query or a fragment are rejected.
- Messages name a plain-http root endpoint as `host:port`, as before, and anything else by its full URL.
- `jaypost test` keeps testing the local install, not `JAYPOST_URL`.
- No https test: it would need a certificate the test trusts. http and https share the same code path apart from the `request` function.
