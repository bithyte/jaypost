# Contributing

You need Node 24+ and pnpm (any recent version; it switches itself to the one this repo pins).

```
pnpm install
pnpm dev
```

`pnpm dev` runs the service from source and restarts it on every save. It first asks which chat app to use, with your last pick selected. Terminal needs nothing: questions print in that same terminal and you answer by typing an option number or a reply. Telegram or Discord asks for your bot's token once, reuses it after that, and the service prints a pairing code the first time. Use your own bot, not one a running install already uses. Then try it from a second terminal with `pnpm cli test --port 8788`; `pnpm cli` runs any CLI command from source. It keeps clear of a real install: it listens on port 8788 and keeps each chat app's config, state and question log in `.dev/<app>/`.

To skip the questions, `cp .env.example .env` and fill in `JAYPOST_BOT_TOKEN` (and `JAYPOST_PROVIDER=discord` for Discord). If `JAYPOST_CONFIG` is set, `pnpm dev` uses that file as is and never writes to it.

Before a PR, run `pnpm test` and `pnpm check`. If the change matters to users, add a changeset (see [Releasing](#releasing)).

## Releasing

When a change matters to users, run `vp run changeset` on its branch, pick patch, minor or major, write a line or two for the changelog, and commit the generated `.changeset/*.md` file with the change. Internal changes (refactors, tests, docs) don't need one.

After a PR with a changeset is merged into `main`, the `publish` workflow opens or updates a `chore: release` PR that bumps the version, writes `CHANGELOG.md` and regenerates `docs/openapi.yaml`. Merging that PR is the release: the workflow runs the checks and tests, publishes to npm, pushes the `vX.Y.Z` tag and creates the GitHub Release. Nothing needs to be run locally.

The same workflow builds the standalone binaries: Linux on Ubuntu, macOS on a macOS runner (ad-hoc codesigned). One last job gzips them and attaches the four `.gz` files and a `SHA256SUMS` to the GitHub Release.

After the binaries are uploaded, a last job moves the major tag (`v0` while jaypost is 0.x) to the new release, so `uses: bithyte/jaypost@v0` follows it.

The action is listed on the GitHub Marketplace as `jaypost approval` (plain `jaypost` matches an existing user, which the Marketplace rejects). One-time manual setup: accept the Marketplace developer agreement and turn on 2FA for the owning account. Then open the release on GitHub, Edit, tick "Publish this Action to the GitHub Marketplace", pick categories and Update release. I haven't verified that later releases, which `publish.yml` creates through the API, show up as new Marketplace versions (reports differ, see [community discussion 7941](https://github.com/orgs/community/discussions/7941)). After the first release following the listing, check the Marketplace page. If the version is missing, edit that release, untick and re-tick the Marketplace box and save.

The website in `site/` deploys to `https://bithyte.github.io/jaypost/` after each release, as the last job of `publish`. To deploy by hand (the first time, or for a site-only fix), run the `site` workflow from the Actions tab; it builds whichever ref you pick. For local work, `vp install` at the root installs the site too, then run `vp run web:dev`. One-time setup: Settings, Pages, Source: GitHub Actions. To run it from a release tag, add a `v*` tag rule to the `github-pages` environment, which only allows `main` by default.
