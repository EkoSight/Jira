# TaskFlow's mark

TaskFlow used to show the Soil Doctor mark unchanged, so on a phone, a taskbar
or a browser tab the two apps could not be told apart. TaskFlow now has its own
mark, chosen by the owner on 16 November 2026 (option "B on tile").

## The idea

**Different:** the Soil Doctor mark is a light, round field crossed by a
heartbeat line, "a health check of the soil". TaskFlow's mark is the same soil
layers cut into a **tick**, "work done", on TaskFlow's own **deep green**
tile. A dark tile with a tick cannot be mistaken for the light round field, at
any size.

**The same family:** it is made of the Soil Doctor mark's own parts:

- the soil layers, sky on top, in the same order;
- the thin gaps between them;
- the rounded line.

TaskFlow's deep green is already its main colour, and the colour of Soil
Doctor's dark panels.

## Geometry

SVG, `viewBox 0 0 100 100`. File: `server/src/assets/brand/taskflow-mark.svg`,
with a copy at `client/public/brand/mark.svg`.

| Part | Shape | Colour |
| --- | --- | --- |
| Tile | `rect 100 × 100`, corner radius 22 | Deep green `#073F2A` |
| The tick (a mask) | `polyline 25,53 43,71 76,32`, width 14.5, round joins and caps | shows the layers below |
| Sky | `rect y 0, height 40` | `#9DDCF8` |
| Leaf | `rect y 40, height 16` | `#AED252` |
| Light soil | `rect y 56, height 13` | `#C08A5C` |
| Soil | `rect y 69, height 31` | `#8B5E3B` |
| Gaps | `rect` at y 38.6, 54.6 and 67.6, height 2.6 | Deep green `#073F2A` |

**The one new colour:** Light soil `#C08A5C` is a lighter tint of Soil. The
Soil Doctor mark's fourth layer, Deep soil `#593C28`, almost vanishes on the
deep green, so the tick uses a light and a dark soil instead.

## Animation

The same timings as the Soil Doctor mark (`docs/SOIL_DOCTOR_LOGO_ANIMATION.md`):

| When | What moves |
| --- | --- |
| Intro (the sidebar, once per tab) | The layers slide in from alternating sides: Sky from the left, Leaf from the right, and so on. Each takes 0.9 s, 0.11 s apart, easing `cubic-bezier(.2,.8,.2,1)`. Meanwhile the tick draws itself on, left to right: 0.9 s from 0.15 s, `cubic-bezier(.5,0,.2,1)` |
| Loading screens | The intro, then from 1.5 s a white glint runs along the tick, and the mark beats once (up to 1.07×) every 3.4 s |
| Reduced motion | Still, everywhere |

Drawn by `client/src/components/BrandMark.jsx`.

## Where it is used

| Place | How |
| --- | --- |
| Sidebar, phone top bar, sign-in, loading screens | `BrandMark`, drawn in the page |
| Browser tab | `client/public/brand/mark.svg` and `favicon-48.png` |
| Installed web app (the server's manifest) | made from the mark by the server. The Apple touch and maskable icons are deep green to the edges, so the phone's own rounding is what people see |
| Notifications | `client/public/icons/icon-192.png` |
| Android app | launcher icons (square, round and adaptive, on a deep green background) and splash screens, drawn by `apps/android/scripts/make-icons.mjs` |

**Redrawing everything after a change to the mark:**

- `npm run icons` in `client/` (it also runs before `npm run build`);
- `npm run icons` in `apps/android/`.

The server's own icons get new addresses through the version `tf1` in
`server/src/services/branding.js`: raise it when the bundled mark changes, so
no phone or browser keeps an old copy.

## What still says Soil Doctor, on purpose

What customers see keeps the Soil Doctor brand, unchanged:

- marketing emails;
- public pages and enquiry forms;
- quotations;
- the Soil Doctor wordmark under the sign-in form.

## On the live site

- **If an administrator has uploaded a mark** in Settings → Branding, that
  upload still wins. Choose "Use the bundled one" (remove the upload) to show
  the new mark.
- **The Android app** shows its new icon after the next build of the app is
  installed.
- **Installed web apps** may keep the old icon until the phone refreshes it,
  which Android does on its own schedule. Removing and re-adding the app
  updates it at once.
