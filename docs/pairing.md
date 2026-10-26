# Pairing

The first time (and after `reset-owner`), the bot only answers whoever proves they own it. `init` prints a code like `ABCD-EFGH` and a link. On Discord, see [Discord setup](#discord-setup): DM the bare code to the bot. On Telegram, either send `/start ABCD-EFGH` to your bot, or open `https://t.me/<bot>?start=ABCDEFGH`. Case and the dash don't matter. After 5 wrong codes from one user (Telegram or Discord) that user is blocked until the service restarts.

If you lose the code: `jaypost status` prints it again while unpaired.

To move to another account:

```
jaypost reset-owner
```

It asks first, resets the install's pairing (the one its key points to) so the old person is forgotten, and waits for a new pairing. The service keeps running, and the keys of that pairing keep working once someone pairs again. Their open questions end with their timeout option. It also removes the owner from the install's inputs (`config.json` for systemd and launchd, the `.env` owner line for containers) so a restart can't pair them again; a container whose old service saved the owner into `/data/config.json` keeps it there until you run `owner clear` inside it or edit the file.

On a service with several bots and people, each key points to a pairing and a person pairs once per bot. Admins manage them with `jaypost pairing` and `jaypost key create`; see [Hosting](hosting.md).

## Discord setup

1. In the [Discord developer portal](https://discord.com/developers/applications) create an application, add a bot and copy its token. No intent toggles are needed.
2. Run `jaypost init`, pick Discord and paste the token.
3. Open the invite link it prints and add the bot to a server you're in. A private server you made just for this works.
4. DM the pairing code to the bot.

If questions don't arrive, allow DMs from members of that server in the server's privacy settings. The owner commands (see [Bot commands](bot.md)) are slash commands in the bot's DM.
