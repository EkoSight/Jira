# Soil Doctor — Logo Animation Prompt

Use this to recreate the animated Soil Doctor mark on any page, video or app. Paste it as-is; the geometry, colors and timings are exact.

---

## What the mark is
A circle split into **four horizontal soil-strata bands** separated by thin white gaps, with a **white heartbeat (ECG) pulse line** crossing the middle. It reads as "a health check of the soil".

Band colors, top to bottom (never reorder):
1. Sky `#9DDCF8`
2. Leaf `#AED252`
3. Soil `#8B5E3B`: its top edge follows the pulse line's shape
4. Deep Soil `#593C28`

The circle background and the gaps are white `#FFFFFF`. The pulse line is white.

## Geometry (SVG, viewBox `0 0 100 100`, everything clipped to a circle r=50)
- Sky band: `rect x=0 y=0 w=100 h=21.6`
- Leaf band: `rect x=0 y=24.9 w=100 h=42`
- Soil band: `path M0 49.5 L42.9 49.5 L48.8 37 L58.7 64.7 L65.6 49.9 L100 49.9 L100 75 L0 75 Z`
- Deep Soil band: `rect x=0 y=78.4 w=100 h=21.6`
- Pulse line: `polyline points="-3,49.5 42.9,49.5 48.8,37 58.7,64.7 65.6,49.9 103,49.9"`, stroke white, width 3.3, round joins and caps, `pathLength=100`.
  Shape: flat → small peak up → deep dip down → back to flat, slightly right of center.

## Animation, in three parts

### 1. Intro: the strata slide in (once, on load)
- Each band slides horizontally into place from outside the circle, **alternating sides**: Sky from the left, Leaf from the right, Soil from the left, Deep Soil from the right.
- Keyframes: `translateX(-104%) → 0` (left) and `translateX(104%) → 0` (right).
- Duration **0.9s** each, easing `cubic-bezier(.2,.8,.2,1)` (fast start, soft settle), `fill-mode: both`.
- Stagger **0.11s**: delays 0s, 0.11s, 0.22s, 0.33s.

### 2. Intro: the pulse draws on
- The white pulse line draws left to right, like a heart monitor tracing.
- Technique: `stroke-dasharray: 100; stroke-dashoffset: 100 → 0`.
- Duration **0.8s**, easing `cubic-bezier(.5,0,.2,1)`, delay **0.5s** (it starts while the bands are still settling).

### 3. Loop: heartbeat spark (infinite, starts at 1.5s)
- **Spark**: a short, thicker bright white dash travels along the pulse line from left to right.
  - Second polyline on the same points, stroke white, width **6.5**, `stroke-dasharray: 9 220`.
  - `stroke-dashoffset: 12 → -104` from 0% to 55% of the cycle, then holds (rests) to 100%.
  - Cycle **3.4s**, `linear`, infinite, delay 1.5s.
- **Heartbeat**: the whole mark gives one gentle pulse as the spark crosses the peak.
  - `scale(1)` at 0–22% → `scale(1.07)` at 29% → `scale(1)` from 38% to 100%.
  - Same **3.4s** cycle, `ease-in-out`, infinite, delay 1.5s, `transform-origin: center`.
- Overall rhythm: trace → beat → rest. It should feel calm and alive, like a steady heart rate, never busy.

## Modes
- **Loop** (default): intro, then the heartbeat spark forever. Use on the header logo and hero/CTA marks.
- **Intro only**: bands and pulse animate once, then hold still. Use in the footer and on secondary marks.
- **Off**: static mark.
- Always switch to **Off** when the user has `prefers-reduced-motion: reduce` set.

## Placement used on the landing page
- Header: 44px mark in **Loop** mode, beside the "Soil Doctor / by ekosight" wordmark (wordmark ~29px tall, 10px gap).
- Footer: 48px mark in **Intro only** mode.
- Final CTA (deep green `#073F2A` panel): a 380px mark at **20% opacity** bleeding off the bottom-right corner (Loop, 0.2s extra delay), plus a 220px mark at **12% opacity**, rotated 180°, off the top-left corner (Intro only).
- Hero map: the mark is the "Soil Intelligence Hub" node, inside a deep-green ring with a soft expanding halo.

## Reference keyframes (CSS)
```css
@keyframes sdBandL { from { transform: translateX(-104%) } to { transform: translateX(0) } }
@keyframes sdBandR { from { transform: translateX(104%) }  to { transform: translateX(0) } }
@keyframes sdDraw  { from { stroke-dashoffset: 100 } to { stroke-dashoffset: 0 } }
@keyframes sdSpark { 0% { stroke-dashoffset: 12 } 55% { stroke-dashoffset: -104 } 100% { stroke-dashoffset: -104 } }
@keyframes sdBeat  { 0%, 22% { transform: scale(1) } 29% { transform: scale(1.07) } 38%, 100% { transform: scale(1) } }
```

## Reference SVG
```html
<svg viewBox="0 0 100 100" width="44" height="44" role="img" aria-label="Soil Doctor"
     style="overflow:visible;transform-origin:50% 50%;animation:sdBeat 3.4s ease-in-out 1.5s infinite">
  <defs><clipPath id="sd-clip"><circle cx="50" cy="50" r="50"/></clipPath></defs>
  <g clip-path="url(#sd-clip)">
    <circle cx="50" cy="50" r="50" fill="#FFFFFF"/>
    <rect x="0" y="0"    width="100" height="21.6" fill="#9DDCF8" style="animation:sdBandL .9s cubic-bezier(.2,.8,.2,1) 0s both"/>
    <rect x="0" y="24.9" width="100" height="42"   fill="#AED252" style="animation:sdBandR .9s cubic-bezier(.2,.8,.2,1) .11s both"/>
    <path d="M0 49.5 L42.9 49.5 L48.8 37 L58.7 64.7 L65.6 49.9 L100 49.9 L100 75 L0 75Z" fill="#8B5E3B"
          style="animation:sdBandL .9s cubic-bezier(.2,.8,.2,1) .22s both"/>
    <rect x="0" y="78.4" width="100" height="21.6" fill="#593C28" style="animation:sdBandR .9s cubic-bezier(.2,.8,.2,1) .33s both"/>
    <polyline points="-3,49.5 42.9,49.5 48.8,37 58.7,64.7 65.6,49.9 103,49.9" pathLength="100"
              fill="none" stroke="#FFFFFF" stroke-width="3.3" stroke-linejoin="round" stroke-linecap="round"
              style="stroke-dasharray:100;animation:sdDraw .8s cubic-bezier(.5,0,.2,1) .5s both"/>
    <polyline points="-3,49.5 42.9,49.5 48.8,37 58.7,64.7 65.6,49.9 103,49.9" pathLength="100"
              fill="none" stroke="#FFFFFF" stroke-width="6.5" stroke-linejoin="round" stroke-linecap="round"
              style="stroke-dasharray:9 220;stroke-dashoffset:12;animation:sdSpark 3.4s linear 1.5s infinite"/>
  </g>
</svg>
```

## Don'ts
- Don't change band order, colors, or the pulse line's shape.
- Don't spin, bounce, or flip the mark; motion is only horizontal slides, a line trace and a gentle beat.
- Don't exceed a 1.07× scale or shorten the 3.4s cycle; faster reads as alarm, not health.
- Don't animate the wordmark; only the mark moves.

## Adapting to other media
- **Video / motion graphics (After Effects, Lottie, etc.)**: same sequence. Bands slide 0–1.2s with a 0.11s stagger, pulse traces 0.5–1.3s, then a spark + beat every 3.4s. Ease-out on slides, ease-in-out on the trace.
- **App splash**: run the intro once (about 1.3s total) and end on the static mark.
- **Loader**: run only the loop (spark + beat) on the static mark.
