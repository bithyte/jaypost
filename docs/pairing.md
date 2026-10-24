# Pairing

The first time (and after `reset-owner`), the bot only answers whoever proves they own it. `init` prints a code like `ABCD-EFGH` and a link. On Discord, see [Discord setup](#discord-setup): DM the bare code to the bot. On Slack, see [Slack setup](#slack-setup): send the bare code in the app's Messages tab. On Telegram, either send `/start ABCD-EFGH` to your bot, or open `https://t.me/<bot>?start=ABCDEFGH`. Case and the dash don't matter. After 5 wrong codes from one user that user is blocked until the service restarts.

If you lose the code: `jaypost status` prints it again while unpaired.

To move to another account:

```
jaypost reset-owner
```

It asks first, clears the owner, restarts the service and waits for a new pairing.

## Discord setup

1. In the [Discord developer portal](https://discord.com/developers/applications) create an application, add a bot and copy its token. No intent toggles are needed.
2. Run `jaypost init`, pick Discord and paste the token.
3. Open the invite link it prints and add the bot to a server you're in. A private server you made just for this works.
4. DM the pairing code to the bot.

If questions don't arrive, allow DMs from members of that server in the server's privacy settings. The owner commands (see [Bot commands](bot.md)) are slash commands in the bot's DM.

## Slack setup

Slack needs an app of your own in a workspace you're in, with two tokens. The service connects out over Socket Mode, so it doesn't need a public URL.

1. [Create the app from the jaypost manifest](https://api.slack.com/apps?new_app=1&manifest_json=%7B%22display_information%22%3A%7B%22name%22%3A%22jaypost%22%2C%22description%22%3A%22Questions%20and%20notifications%20from%20your%20agents%20and%20scripts%22%7D%2C%22features%22%3A%7B%22app_home%22%3A%7B%22home_tab_enabled%22%3Afalse%2C%22messages_tab_enabled%22%3Atrue%2C%22messages_tab_read_only_enabled%22%3Afalse%7D%2C%22bot_user%22%3A%7B%22display_name%22%3A%22jaypost%22%2C%22always_online%22%3Atrue%7D%2C%22slash_commands%22%3A%5B%7B%22command%22%3A%22%2Fjaypost%22%2C%22description%22%3A%22Open%20requests%2C%20history%2C%20mute%20and%20quiet%20hours%22%2C%22usage_hint%22%3A%22pending%20%7C%20cancel%20%7C%20history%20%5Bcount%5D%20%7C%20mute%20%5Bduration%5D%20%7C%20unmute%20%7C%20quiet%20%5Bhours%5D%22%2C%22should_escape%22%3Afalse%7D%5D%7D%2C%22oauth_config%22%3A%7B%22scopes%22%3A%7B%22bot%22%3A%5B%22chat%3Awrite%22%2C%22commands%22%2C%22files%3Awrite%22%2C%22im%3Ahistory%22%2C%22im%3Awrite%22%2C%22users%3Aread%22%5D%7D%7D%2C%22settings%22%3A%7B%22event_subscriptions%22%3A%7B%22bot_events%22%3A%5B%22message.im%22%5D%7D%2C%22interactivity%22%3A%7B%22is_enabled%22%3Atrue%7D%2C%22org_deploy_enabled%22%3Afalse%2C%22socket_mode_enabled%22%3Atrue%2C%22token_rotation_enabled%22%3Afalse%7D%7D), pick the workspace and click Create. The link fills in [`slack-app-manifest.json`](slack-app-manifest.json); you can also choose Create New App, From a manifest, and paste that file.
2. Install to Workspace, then copy the Bot User OAuth Token (`xoxb-...`) from OAuth & Permissions.
3. Under Basic Information, App-Level Tokens, generate a token with the `connections:write` scope and copy it (`xapp-...`).
4. Run `jaypost init`, pick Slack and paste both tokens.
5. Open the link it prints (or find the app under Apps in Slack) and send the pairing code in the app's Messages tab.

Answer with the buttons, or type an answer as a reply in the question's thread. The owner commands are one slash command in the app's DM: `/jaypost pending`, `/jaypost history 5`, `/jaypost mute 2h` and so on (see [Bot commands](bot.md)). Slack has a built-in `/mute`, so the commands can't have their own names there.

If `init` keeps rejecting the tokens, check that both are from the same app and that the app has every scope in the manifest; add a missing one under OAuth & Permissions and reinstall the app. Many company workspaces only allow apps an admin approved, so installing may need a request to your admin. A personal workspace works too.

Slack can't send a message without a notification, so on Slack [quiet hours](bot.md#quiet-hours) and `/jaypost mute` still delay deleting the notifications sent meanwhile, but don't silence them. Use Slack's own notification schedule for quiet nights.
