# Site design notes

How the site looks and why, so later changes stay consistent. The original intent and content rules are in `docs/superpowers/specs/2026-10-21-website-design.md`. This file covers the visual layer added after it, and where the two disagree (that spec listed gradient blobs as an anti-goal), this file wins: the owner asked for the bloom lights.

## Brand colors

The two chat apps jaypost talks to set the palette.

| Token              | Dark             | Light            | Used for                                        |
| ------------------ | ---------------- | ---------------- | ----------------------------------------------- |
| `--telegram`       | `#2aabee`        | `#1a82c4`        | "Telegram" in the hero flip                     |
| `--discord`        | `#5865f2`        | `#4752c4`        | "Discord" in the hero flip                      |
| `--bloom-telegram` | `#2aabee` at 20% | `#2aabee` at 22% | first bloom per section                         |
| `--bloom-discord`  | `#5865f2` at 20% | `#5865f2` at 18% | second bloom per section                        |
| `--accent`         | `#7ee0a1`        | `#15803d`        | buttons, step numbers, `$` prompts, focus rings |

The light text variants are darker so they stay readable on `#fafafa`. The mint accent is older than the brand colors and stays as the UI accent.

All tokens live in `src/styles/global.css` on `:root`.

## Logo

A chat bubble that is also a blue jay: the bubble is the body, its tail is the bird's tail, with a swept-back crest, a beak, and an eye cut out of the shape (a mask, so it works on any background). It's filled with a top-to-bottom gradient from `#2aabee` to `#5865f2`.

Source of truth is `public/favicon.svg`. `src/components/Header.astro` inlines the same paths; change both together. Geometry on a 48x48 grid:

- crest: `M17 15 3 7l16 4L8 1l15 9-4-10 9 13z`
- body and tail: `M25 12a15 14 0 1 1-9 26L4 44l5-11a15 14 0 0 1 16-21z`
- beak: `m38 22 9 3-9 3z`
- eye (cut out): circle at `31,22`, radius `2.4`

Picked over nine other directions (jay head, crested bubble, jay on a post, check bubble, crested J, crested envelope, ask/answer bubbles, tapped button, `jp` monogram) and then over variations of the bubble bird (chunky, minimal, outline, check wing, mirrored, two-tone flat, forked tail, open beak, soft corners, app tile, chest band, notification dot). The swept crest and the vertical gradient came from that second round. The eye has no glint.

The header wordmark reads "JayPost" in the monospace font. The page `<title>` and footer still say "jaypost".

## Dark and light mode

- Follows the system by default (`color-scheme: light dark`; every color token is a `light-dark()` pair).
- The sun/moon button at the end of the header nav overrides it by setting `data-theme="light"` or `"dark"` on `<html>`, saved in `localStorage` under `theme`. The icon shows the theme a click switches to. Nothing in the UI clears the override.
- An inline script in `src/layouts/Base.astro` applies the saved choice before first paint, so there's no flash.
- The demo terminal and phone in `RoundTrip.astro` are dark in both themes (`color-scheme: dark` on them).
- Without JavaScript the toggle is hidden and the system setting applies.

## Bloom lights

Two soft glows per section (hero included), drawn as `::before`/`::after` radial gradients behind the content (`isolation: isolate`, `z-index: -1`, `overflow: clip` on the section).

- Blue glow at the top edge, blurple at the bottom edge, on opposite sides.
- Sides swap every section (`main > :nth-child(even)`).
- 560px circles, mostly off-canvas. Keep them faint; they're background, not decoration you notice first.

Placement was picked over "both behind the heading" and "big corner wash". Colors were picked over mint + sky, emerald + indigo, and amber + coral.

## Hero flip

"You tap a button in **Telegram**, and they carry on." The word rolls up to **Discord** and back, 3s each (6s CSS loop, no JavaScript), each word in its brand color.

- The slot is sized to "Telegram" so the sentence doesn't reflow; "Discord" sits centered with a small gap on each side.
- Screen readers get "Telegram or Discord" from a visually hidden span; the animated words are `aria-hidden`.
- With reduced motion, only "Telegram" shows.
- Picked over a card flip, a split-flap board, and a blur crossfade.

## Social preview

`public/og.png` is a 1200x630 screenshot of the top of the built page: dark theme, reduced motion (so the round-trip shows its finished state and the flip shows "Telegram"). Regenerate it when the header or hero changes:

1. `vp run web:build`, then `vp run web:preview` and note the port it prints.
2. Screenshot `http://localhost:<port>/jaypost/` with Playwright at a 1200x630 viewport, `colorScheme: 'dark'`, `reducedMotion: 'reduce'`, into `site/public/og.png`.
3. Build again so `dist` picks it up.

## Deploying

Releases deploy the site automatically. For a site-only fix between releases, use GitHub Actions, workflow "site", "Run workflow", and pick the branch or tag to build (default `main`).
