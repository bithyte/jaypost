# jaypost website design

## Intent

jaypost needs a public landing page. The README is complete but long. A dev who hears about jaypost needs one page that tells them in ~30 seconds what it does ("your agent asks, your phone buzzes, you tap, the agent continues") and hands them an install command to copy.

Audience: developers who run AI agents (Claude Code and other MCP clients) and scripts or automation flows (shell, n8n). They're comfortable in a terminal.

Success: a visitor gets the idea from the hero alone, copies `npx jaypost init` (or the standalone binary command), and knows where the full docs are.

## Goals

- One landing page that looks sleek: dark, minimal, professional. The reference the owner gave is opencode.ai.
- Free hosting with no domain: GitHub Pages at `https://bithyte.github.io/jaypost/`.
- Built with a frontend framework, with a hot-reload dev server and a build step.
- Deployed automatically when a new jaypost release goes out.

## Non-goals

- Not a docs site. The README stays the docs; the page links into its sections (`https://github.com/bithyte/jaypost#<anchor>`).
- No blog, no changelog page, no multiple pages beyond what the framework needs (a 404 page is fine).
- No analytics, cookies, trackers, or third-party embeds.
- No custom domain and nothing that costs money.

## Anti-goals

- Looking like a generic template (gradient blobs, stock illustrations, emoji feature lists).
- Claims the README doesn't back up. Every feature, command and flag on the page must match the README as it is today.
- Anything that goes stale between releases: no hardcoded version number, no "latest version" badge baked into HTML.
- Site dependencies leaking into the published npm package or into jaypost's own `dependencies`/`devDependencies`.

## Decided by the owner

- **Hero direction "C", animated round-trip.** Centered headline, a short looping animation of an agent terminal and a phone side by side: the agent runs something risky (e.g. `git push --force`), shows "waiting for approval", the phone shows the Telegram question with buttons (e.g. `[claude-code] Force-push main?` with Approve/Decline), a tap happens, the terminal shows "approved" and continues. Install command below it.
- **Install command tabs in the hero:** `npx` (`npx jaypost init`), `linux` and `macos` (the standalone binary `curl ... | gunzip ...` one-liners from the README's "Standalone binary" section, using the `releases/latest/download/` URLs). Each has a copy button.
- **Page sections, in order** (owner reviewed a mockup and approved all of them):
  1. Hero (above).
  2. Setup in three steps: install (`npx jaypost init`, paste the BotFather token), pair (send `/start ABCD-EFGH` to the bot), connect your agent (`claude mcp add jaypost -- jaypost mcp`).
  3. "Works from anything": one tabbed code block showing the same kind of question asked from MCP (Claude Code), the shell (`jaypost send`), curl (HTTP API), Node (`Client`) and the Claude Code hook (`settings.json` snippet). Snippets come from the README, not invented. Note: the brainstorm mockup used `jaypost send "..." --option Yes`, which is wrong; the real syntax is `jaypost send request 'Deploy?' -o Approve -d Decline`.
  4. Features grid: buttons or text replies, background questions, notifications, attachments (see the diff or log before approving), quiet hours, question log.
  5. Trust: runs on your machine, listens on 127.0.0.1 only, single owner proven by a pairing code, API token for callers, no cloud service or account.
  6. Install options: npx (Node 24+), standalone binary (Linux, macOS, no Node), Podman Quadlet / Docker Compose, systemd / launchd. Each links to its README section.
  7. Footer: GitHub, npm, full docs (README), Apache-2.0 license.
- **Framework with a dev server and a build.** Owner asked for a frontend framework (React or a suggestion). Astro was suggested and not objected to (see "Builder calls" if that needs revisiting).
- **Scripts at the repo root:** `npm run web:dev` starts the hot-reload dev server; `npm run web:build` builds the static site.
- **Deploy on release.** The site goes live whenever a new jaypost release is published, not on every push to `main`.

## Decided by me (owner can override)

- **Astro**, current stable major. Static output, near-zero JS, components; interactive bits (tabs, copy buttons, hero animation) as small client scripts or islands. React is not required; use it only if an island clearly needs it.
- **Site lives in `site/`** with its own `site/package.json` and `site/package-lock.json`. Root `package.json` gets `web:dev` and `web:build` (and `web:preview` if useful) that forward into it, e.g. `npm --prefix site run dev`. The root `files` field already limits the npm package to `dist` and `CHANGELOG.md`, so `site/` isn't published; keep it that way.
- **Build output at `site/dist`**, gitignored.
- **Astro config:** `site: 'https://bithyte.github.io'`, `base: '/jaypost'`. All internal links and assets must work under that base path, both in dev and in the built output.
- **Deploy uses GitHub Pages "GitHub Actions" source** (`actions/upload-pages-artifact` + `actions/deploy-pages`), not a `gh-pages` branch. The owner said "saves into the gh pages"; I read that as "ends up on GitHub Pages". One manual step for the owner: repo Settings → Pages → Source: GitHub Actions.
- **Wiring the deploy to releases:** add a job to `.github/workflows/publish.yml` that runs after `release-assets` (so the binaries the page links to already exist). Don't trigger on the `release` event: the GitHub Release is created with `GITHUB_TOKEN`, and events from `GITHUB_TOKEN` don't start other workflows. Keep the build/deploy steps in a separate reusable workflow (e.g. `.github/workflows/site.yml` with `workflow_call` and `workflow_dispatch`) so it can also be run by hand, for the first deploy and for site-only fixes between releases. Don't rename `publish.yml` or change its trigger (the npm trusted publisher is tied to the file name). Give the new job only the permissions Pages needs (`pages: write`, `id-token: write`, `contents: read`).
- **Which ref gets built:** the release job builds the release commit (the one the workflow run is on, which the `vX.Y.Z` tag points at). A manual run builds whatever ref is picked in the Actions "Run workflow" dropdown (default `main`); no extra ref input. Pick the latest tag when `main` has README changes for features not on npm yet.
- **Keeping snippets in sync with the README:** snippets are hand-copied into the site source, and `web:build` runs a small check that fails the build if any page snippet (install one-liners, `jaypost send`, curl, `Client`, hook `settings.json`, `claude mcp add`) doesn't appear verbatim in the root `README.md`. No README parsing or extraction at build time. Whitespace normalization in the check is fine.
- **Consequence the owner should know:** site changes merged to `main` go live at the next release, or when someone runs the site workflow by hand.
- **Telegram and terminal visuals are drawn in HTML/CSS**, not screenshots, so they stay sharp and the animation can drive them. Telegram's dark theme colors are a fine reference. The existing `docs/screenshot.png` may appear lower on the page as the real thing; the builder decides.
- **Respect `prefers-reduced-motion`:** with it set, the hero shows the final state of the round-trip without animating.
- **Basics:** responsive down to phone width, favicon, page title and description, Open Graph / Twitter card meta with a preview image (a static image of the hero is fine), a 404 page that links home.
- **Version on the page:** none hardcoded. If the builder wants to show one, it must be read at build time from the root `package.json`.

## Constraints

- Free: GitHub Pages + GitHub Actions on a public repo. No paid services, no domain.
- Node 24, matching the repo's CI.
- The repo's root lint/format (`npm run check`, vite-plus) must keep passing. Either make it ignore `site/` or make `site/` pass it; don't break the existing `pack`/`publish` jobs.
- The owner's TypeScript style rules (class-per-module, etc.) are written for the library. For Astro components, follow Astro idioms; for any plain `.ts` in `site/`, follow the repo's formatting (no semicolons, single quotes, width 100) and strict TS.
- No em-dashes in any copy on the page.

## Left to the builder

- Exact visual design within "dark, minimal, professional, opencode.ai-like": type choices (a good sans plus a monospace; self-hosted or Google Fonts), spacing, accent color, logo/wordmark treatment.
- Copywriting for headlines and blurbs, kept in the README's plain, concrete voice.
- How the hero animation is built (CSS keyframes, small script, or an island) and its exact timing.
- Which question appears in each "works from anything" tab, as long as it's a real, working snippet from the README.
- Whether the build runs in CI on PRs too (nice to have, not required).
