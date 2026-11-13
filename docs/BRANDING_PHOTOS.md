# Profile photos, app colours and branding

The plan, and the data model, are in `BRANDING_PHOTOS_PLAN.md`. The API routes
are in `API.md` under "Profile photos" and "Branding". The logo animation spec
is `SOIL_DOCTOR_LOGO_ANIMATION.md`.

## What changed

### Profile photos

- **Where.** Each person adds, changes or deletes their own photo in
  **Settings → My account** or from their own **Team** profile.
- **What it is for.** Recognising colleagues. The notice says so in the editor
  and on the card: "Everyone signed in to TaskFlow can see it. It is not used
  for attendance, pay or performance, and you can delete it at any time."
  Nothing in attendance, check-in, payroll or performance reads it, and there
  is no face recognition or identity matching anywhere.
- **Where it shows.** Wherever a screen already knew whose avatar it was
  drawing (33 places: the sidebar, task cards, the board, discussions, Team,
  CRM owners and followers, goals, attendance, payroll, performance and more).
  Elsewhere, and whenever there is no photo or it fails to load, the initials
  stay. A photo is never matched by name, so a customer who shares a name with
  a colleague never gets their face.
- **Accepted files.** JPEG, PNG and WebP up to 10 MB, chosen from the gallery
  or taken with the camera. The camera's rotation is respected. An iPhone HEIC
  that the browser cannot open gets instructions instead of an error.
- **Stored.** The server re-encodes every picture, so no EXIF, GPS or camera
  data survives. It keeps square WebP files at 64, 128, 256 and 512 px, plus
  the original (at most 2048 px), which only its owner can fetch, for
  re-framing later.
- **Served.** Only to signed-in people. Each photo address carries its
  version, so it can be cached for a year and a new photo still shows at once.
  The offline copy (service worker) never stores photos. A delete removes every
  size and the original.
- **Administrators.**
  - **Removing** someone's photo needs a reason. The files are deleted, the
    action goes in the audit trail, and the person gets a notification and
    sees the reason on their card.
  - **Uploading on someone's behalf** is a *suggestion*. It becomes their photo
    only when they press "Use it", and that acceptance is recorded as their
    agreement. They can decline it, and the administrator can withdraw it.

### The face-focused editor

- **Runs in the browser.** Face detection uses MediaPipe Face Detector
  (BlazeFace short range, Apache-2.0). The engine and the model are served by
  TaskFlow itself, with no third-party CDN, and download (about 3 MB,
  compressed) only the first time someone opens the editor. The photo never
  leaves the device until Save.
- **Framing.** Head and shoulders: the face fills about a third of the square,
  a little above the middle. The picture is straightened by the eye line, but
  only for tilts of 1° or more, and by at most 15°.
- **No face** → a centre crop and a note asking the person to frame it.
  **Several faces** → numbered boxes and "Which one is you?".
- **Gentle fixes**, each with its own switch:
  - light and contrast (on);
  - colour balance (on);
  - slight sharpening (on);
  - soften the background (off).

  There is no smoothing, reshaping or beautification.
  - The light fix changes a well-lit face very little. It only lifts a face
    that is clearly too dark, or calms one that is clearly too bright.
  - The colour fix measures only near-neutral pixels, so a red curtain or a
    green field does not tint the face.
- **Before and after** are shown side by side. The framing moves by drag,
  pinch, mouse wheel or arrow keys, with zoom and straighten sliders. Nothing
  is saved until Save. "Adjust the framing" reopens the kept original with the
  last settings.

### App colours

- **Settings → Branding** (administrators with `settings.manage`) has:
  - the app name and the line under it;
  - the main colour and the accent colour;
  - a live preview in light and in dark mode;
  - Save, "Undo the last change", "Reset to default", and a history of
    changes.
- **Every shade is worked out from the two colours.** That covers hover,
  pressed, links, pale tints, borders, chart series, the dark-mode versions and
  the text on top. Every combination the app paints is checked:
  - at least 4.5:1 for text;
  - at least 3:1 for buttons against the page.

  A colour that fails, or that looks like a status colour (red, amber, green),
  is refused with the reason, and the nearest passing shade is offered as a
  one-click "Use #… instead". Save stays disabled until the colours pass. The
  server checks again.
- **No redeploy.** Open copies of the app pick up a change when they come back
  into view, and otherwise within two minutes.
- **Status colours** (overdue, warning, done) never change.
- **Each person** chooses Light, Dark or Match my device, plus an optional
  accent from six colours checked in advance (Forest, Soil, Deep soil, Ocean,
  Plum, Slate). The choice is saved to their account, so it follows them to
  another phone or computer.

### Logo and branding

- **Uploads.** Administrators upload a mark, a wordmark, and optional dark
  versions of each.
  - An SVG is checked: one with scripts, event handlers, links, external
    references or embedded pages is refused. Accepted SVGs are served with a
    sandboxing security policy.
  - PNG, JPEG and WebP are re-encoded.
  - "Use the bundled one" goes back to the Soil Doctor files.
- **Where the brand appears:**
  - **Sidebar:** the mark, the app name and the line under it.
  - **Phone top bar:** the mark alone.
  - **Sign-in page:** the mark, the name and the wordmark.
  - **Browser tab:** the title and icon.
  - **Browser and phone chrome:** the theme colour.
  - **Installed app:** the name, colour and icons, from a manifest the server
    builds.
  - **Loading screens:** the mark.
- **Icons.** The 32 and 48 favicons, the 180 Apple touch icon, 192, 512 and
  maskable 512 (with the safe-zone padding) are generated from the mark.
- **Fallbacks.** Static copies of the default icons are in
  `client/public/brand/`, for when the server is unreachable. The old generic
  icons were replaced in the HTML and manifest, but no file was deleted.
- **Animation** follows `SOIL_DOCTOR_LOGO_ANIMATION.md` exactly:
  - **Sign-in:** the intro plays once (the bands slide in 0.9 s, 0.11 s
    apart; the pulse draws in 0.8 s from 0.5 s).
  - **Sidebar:** the intro plays once per tab, then the mark is still.
  - **Loading screens:** the mark loops.
  - **Nothing else** loops.
  - **Reduced motion:** the mark is still everywhere.
  - **The wordmark** is never animated or recoloured. In dark mode it sits on
    a light plate.
- **Emails and exports.**
  - TaskFlow sends no staff emails. The marketing emails already carry the
    Soil Doctor lockups, and were not changed.
  - Exports (CSV) have no header area, so no logo was added.

## Defaults used

| Area | Default |
|---|---|
| App name | "TaskFlow", with "by ekosight" under it. The tab title is "TaskFlow by ekosight" |
| Main colour | Deep green `#073F2A`, with white text. In dark mode it becomes `#3E7059`, with links `#6EA288` |
| Accent | Soil `#8B5E3B` |
| Sky `#9DDCF8`, Leaf `#AED252` | Used only inside the mark. They are refused as a main colour, because buttons in them would vanish into a white page |
| The old blue `#2a78d6` | No longer used. It gave 4.42:1 with white text, and is refused if entered |
| Readability | 4.5:1 for text and 3:1 for buttons. A colour within a small distance of a status colour is refused |
| Personal look | Match my device, with the organisation's colours |
| Personal accents | Forest `#145A32`, Soil `#8B5E3B`, Deep soil `#593C28`, Ocean `#1F5E8C`, Plum `#6B3A7D`, Slate `#3D4B5C` |
| Branding refresh | When the app comes back into view, and every 2 minutes |
| Mark | The supplied Soil Doctor mark (SVG), unchanged |
| Wordmark | The supplied raster (WebP, 2000×592), unchanged, on a light plate in dark mode |
| Icons | 32 and 48 favicons. Apple touch 180, on white at 84%. 192 and 512. Maskable 512, on white at 72% |
| Upload | JPEG, PNG or WebP, up to 10 MB. At least 32 px a side. A warning under 256 px |
| Stored sizes | WebP at 64, 128, 256 and 512, plus the original at most 2048 px (WebP, quality 90) |
| Photo caching | Private, a year, immutable, under versioned addresses. The list of who has a photo refreshes every 5 minutes and when the app comes back into view |
| Who sees photos | Everyone signed in |
| Removal reason | 3 to 300 characters |
| Face detection | BlazeFace short range, on the CPU, confidence 0.5, on a copy at most 1024 px |
| Framing | The face fills 36% of the height, its centre at 43% from the top |
| Straightening | Only from 1°, and at most 15° |
| Fixes | Light, colour and sharpen on; background off. The light fix acts only below 38% or above 66% face brightness. Colour gains stay within 0.9–1.12, mixed 60%. Sharpening 0.3 |
| Editor output | A 768 px JPEG sent to the server, which re-encodes it |

## What was tested

**Automated tests** (all passing on this branch):

- **Server:** 587 tests. This includes `tests/photosBranding.test.js` (7),
  which uses generated images only:
  - **P1.** No EXIF or GPS is stored (the stored files' metadata and bytes
    were read back); photos are for signed-in people only; replacing and
    deleting work.
  - **P2.** Rotated, tiny, just under and over 10 MB, HEIC and non-image
    files.
  - **P3.** Administrator removal: the reason, the audit row and the
    notification.
  - **P4.** Suggestions: accept, decline and withdraw.
  - **T1.** The look follows the person.
  - **B1.** Colour checks, save, undo, reset and the manifest.
  - **B2.** SVG safety, icon generation, re-encoded pictures, and clearing a
    logo.
- **Client:** 122 tests. This includes `tests/branding.test.js` (8):
  - the defaults and every personal accent are readable in both modes;
  - refusals offer a passing shade;
  - the dark-mode shade is checked;
  - framing and the eye line;
  - the fixes: a dark photo is lifted, a curtain does not tint, a well-lit
    photo barely changes, and with every fix off nothing changes;
  - photo size choice.
- **Build:** `vite build` succeeds.

**Browser walk-through** (Chromium, desktop and phone sizes, a separate test
database): 45 checks, 45 passed. They cover:

- **Sign-in.**
  - The intro timings, read from the browser's computed styles.
  - The tab title, icon and theme colour.
  - A dark device.
  - The wordmark plate.
  - Reduced motion.
  - The phone layout.
- **The editor.**
  - **Detection:** the face is found and framed.
  - **Fixes:** with every fix off, after equals before.
  - **Dragging:** moves the framing.
  - **Lighting:** a dark photo goes from a face brightness of 28 to 60, and a
    backlit one from 76 to 102.
  - **Faces:** two faces are offered as two choices; with no face, a centre
    crop is used.
  - **Rotation:** a sideways camera photo is read upright.
  - **File messages:** tiny, HEIC and over-10 MB.
  - **Re-framing:** from the kept original.
- **No outside requests.** From opening the editor to saving, all 10 requests
  went to TaskFlow itself, the engine and model included.
- **The look.**
  - Dark applies at once.
  - An accent applies.
  - The look follows the person to a second browser.
  - "Match my device" follows the device.
- **Branding.**
  - The previews.
  - A refused colour, with its offered shade.
  - Save is disabled while a colour fails.
  - A second signed-in person gets the new colours without reloading.
  - Undo and reset.
  - The installed app's name follows the change.
- **Administrator.** Suggest and remove from the Team profile. The person then
  sees initials and the reason.
- **Phone.** The mark is in the top bar, and the editor fits with no sideways
  scrolling.

**Accessibility** (axe-core 4.10.2, WCAG 2 A and AA rules): no violations on
eight screens. They are sign-in (light and dark), the photo editor, My account
(light, dark and phone) and Branding (light and dark).

The fixes made along the way:

- The initials on light avatar colours now use dark text.
- A muted label on the dark logo sample was too faint.
- The light preview inside a dark page used dark status colours.
- The phone "New" button had no name.

**Test pictures.** No staff photos or real colleagues were used.

- The face tests used MediaPipe's public-domain sample portrait, plus dark,
  backlit, two-face, rotated, tiny and no-face pictures made from it, and
  synthetic images. All were kept outside the repository.
- Every face in the shared screenshots is heavily blurred. The people shown
  ("Arun Sample", "Lata Lead") are made up.

## Not verified

- **A real mid-range Android phone.** Detection speed and the camera button
  were tested only in desktop Chromium at phone size. The first open downloads
  about 3 MB.
- **Safari on iPhone.** Not tested at all, including how it hands over HEIC
  photos (it usually converts them to JPEG itself) and the Apple touch icon.
- **Installing to a home screen.** Not tested on a device, so the maskable
  icon's look and the manifest's name and colour after a change are untested
  there. The manifest itself was checked.
- **Visiting every screen.** Not each of the 33 avatar places was visited with
  a photo. The sidebar, My account and Team were.
- **Real staff photos.** Not used, by design.
- **Migration 034 on the live database.** Not run. It is additive and runs on
  the next deploy, as usual.
- **More than one server.** Photos and uploaded logos are stored on the
  server's disk under `UPLOAD_DIR`. If TaskFlow ever runs on more than one
  machine, that folder must be shared.

## Decisions for an administrator

1. **The app name.** Confirm "TaskFlow" with "by ekosight" under it, or change
   it in Settings → Branding.
2. **The wordmark is a raster image** (WebP, 2000×592). Please supply an SVG,
   plus a dark-mode version if one exists. Until then the raster is used, on a
   light plate in dark mode, as it must not be recoloured.
3. **Who can see photos.** It is everyone signed in. Say if it should be
   narrower.
4. **The originals** are kept privately, so people can re-frame their photo,
   and are deleted with the photo. Say if they should not be kept at all.
5. **Backups.** The folder `UPLOAD_DIR/photos` and `UPLOAD_DIR/branding` should
   be part of the server backup.
6. **Who can change branding.** It is whoever holds `settings.manage`, the same
   permission as other system settings. No permission was changed. Review who
   holds it if branding should be narrower.
7. **The notice wording** in the editor. HR may want to review it.
