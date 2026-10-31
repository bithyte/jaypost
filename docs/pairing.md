# Pairing

The first time (and after `pair reset-owner`), the bot only answers whoever proves they own it. `jaypost service install` prints a code like `ABCD-EFGH` and a link. On Discord, see [Discord setup](#discord-setup): DM the bare code to the bot. On Telegram, either send `/start ABCD-EFGH` to your bot, or open `https://t.me/<bot>?start=ABCDEFGH`. Case and the dash don't matter. After 5 wrong codes from one user (Telegram or Discord) that user is blocked until the service restarts.

If you lose the code: `jaypost status` prints it again while unpaired.

To move to another account:

```
jaypost pair reset-owner
```

It asks first, resets the install's contact (the one its key points to) so the old person is forgotten, and waits for a new pairing. The service keeps running, and the keys of that contact keep working once someone pairs again. Their open questions end with their timeout option. It also removes the owner from the install's inputs (`config.json` for systemd and launchd, the `.env` owner line for containers) so a restart can't pair them again; a container whose old service saved the owner into `/data/config.json` keeps it there until you run `owner clear` inside it or edit the file.

On a service with several bots and people, each key points to a contact and a person pairs once per bot. Admins manage them with `jaypost admin bot contact` and `jaypost admin bot key add`; see [Hosting](hosting.md).

## Joining someone else's bot

If someone runs a bot for you, they send an invite, a line starting `jaypost inbox join jpi_`. Run it:

```
jaypost inbox join jpi_...
```

It saves the bot in your inbox (`--as ALIAS` names it; the default is the bot's name), prints the pairing code and link if you haven't paired, and waits. Pair as above. Ctrl-C leaves the bot saved; its key works once you're paired. `jaypost inbox` lists the bots in your inbox and `-b ALIAS` picks one.

## Discord setup

1. In the [Discord developer portal](https://discord.com/developers/applications) create an application, add a bot and copy its token. No intent toggles are needed.
2. Run `jaypost service install`, pick Discord and paste the token.
3. Open the invite link it prints and add the bot to a server you're in. A private server you made just for this works.
4. DM the pairing code to the bot.

If questions don't arrive, allow DMs from members of that server in the server's privacy settings. The owner commands (see [Bot commands](bot.md)) are slash commands in the bot's DM.
