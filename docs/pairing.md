# Pairing

The first time (and after `reset-owner`), the bot only answers whoever proves they own it. `init` prints a code like `ABCD-EFGH` and a link. On Discord, see [Discord setup](#discord-setup): DM the bare code to the bot. On Telegram, either send `/start ABCD-EFGH` to your bot, or open `https://t.me/<bot>?start=ABCDEFGH`. Case and the dash don't matter. After 5 wrong codes from one user (Telegram or Discord) that user is blocked until the service restarts.

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
