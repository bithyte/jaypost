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

A perched blue jay in profile: round head with one thick crest swept back low (both its edges are tangent to the head, so it flows into the head with no step), a short beak, and a body and tail drawn as one chat bubble. The bubble's back is one straight line that runs on into the top edge of the short tail, so the bubble looks cut along the tail; the tail's underside meets the belly at a small notch. Two tones: the head (with crest and beak) is solid `#2aabee` and sits in front of the body; the body and tail use a top-to-bottom gradient from `#2aabee` to `#5865f2` (`userSpaceOnUse`, y 2 to 44). A 0.8-unit gap separates them: the body is masked by the head shapes stroked 1.6 wide, so the gap is see-through and works on any background. The eye is cut out of the head the same way.

Source of truth is `public/favicon.svg`. `src/components/Header.astro` inlines the same shapes; change both together. Geometry on a 48x48 grid; the `viewBox` (`10 4.6 35 35`) crops it to the shapes so the logo fills its square, so recompute it if a shape grows or moves:

- crest: `M20.3 6.7 33.43 9.66 32 16 26.15 18.82Z` (tip, front tangent point, head center, rear tangent point; if the tip moves, recompute the tangent points)
- head: circle at `32,16`, radius `6.5`
- beak: `m37.5 13.2 7.5 2.8-7.5 2.8Z`
- body and tail: `M26 13.5C35 15 39 26 31.5 32C27.9 34.7 23.6 35.1 20.2 33.9L10 37.5Z` (the closing `Z` is the back line; keep the tail tip on it)
- eye (cut out): circle at `33.5,15`, radius `2`
- gap: head, crest and beak stroked `1.6` wide (round joins), cut out of the body

Replaced the earlier chat-bubble jay (the bubble was the body, its tail the bird's tail, with a three-spike crest). Its three-spike crest read as too thin. Single-spike crests, no crest with a longer or bigger beak, and the bubble adapted to this pose were all tried; the owner preferred this plain silhouette. Its first version had a separate long thin tail at a different angle from the back; that tail was shortened and lined up with the back. Shorter, longer, curved-underside, wide-base and thin tails were tried; the owner picked the short one with a straight underside. The crest then went from a steep spike to a lower swept-back one; upright, two-spike, curved, flat and stub crests, several lengths and several thicknesses were tried. Thick crests whose edges missed the head outline left a step on top of the head, hence the tangent edges. Then the bubble got its own color, split from the head by the gap; head-behind-body, no gap, a dozen color pairs, and solid white or black-with-glint eyes were tried. The eye has no glint.

Runner-up, kept in case the owner wants to switch: `design/logo-alt-short-crest.svg`. Same logo with a shorter crest, `M21.6 7.4 33.22 9.62 32 16 25.95 14.6Z`; only its front edge is tangent to the head, so the notch between crest and back stays. `design/logo-alt-one-gradient.svg` is the one-gradient version from just before the two tones. Neither is published or used anywhere.

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
