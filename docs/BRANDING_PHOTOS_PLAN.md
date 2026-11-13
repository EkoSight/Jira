# Profile photos, app colours and branding: plan

The results and test record are in `BRANDING_PHOTOS.md`.

## What exists, and is kept

- **Avatar.** One `Avatar` component draws initials on each person's colour.
  It is used in 73 places, and most pass only a name and a colour. A photo is
  shown only where a screen also passes the person's account id. Matching by
  name could put a colleague's face on a customer with the same name.
- **Theme.** Light and dark themes come from CSS variables
  (`:root` and `[data-theme='dark']`).
  - The choice lives only in the browser.
  - There is no "match my device".
  - The brand blue `#2a78d6` is used for buttons, links and the first chart
    series.
- **Branding and icons.** The app is called "TaskFlow — EkoSight". It has
  generic PWA icons, and a static manifest and theme colour.
- **Marketing already has Soil Doctor branding.**
  - `server/src/lib/brand.js` holds the colours and Manrope.
  - `server/src/assets/brand/*.png` holds the logo images every marketing
    email and public page already uses, served at `/m/brand/…`.
  - TaskFlow sends no staff emails. The only emails are marketing ones, and
    they are already branded.
- **Uploads** go to `UPLOAD_DIR` through multer.
- **Offline copies.** The service worker keeps a copy of every API reply for
  offline use. Photos must be kept out of it.

## What changes

**Profile photos**

- **Upload.** People upload their own photo in My account, or from their own
  Team profile.
  - The browser frames the face, straightens it and applies gentle fixes, all
    on the device.
  - The server re-encodes everything with `sharp`. Re-encoding drops all
    hidden data, GPS included.
  - It stores square WebP files at 64, 128, 256 and 512 px, plus an original
    (at most 2048 px) that only its owner can see.
- **Display.** Photos are fetched with the signed-in person's token, so only
  signed-in users get them. The address changes with each new version, so
  caches never show an old photo.
- **Removal.**
  - **By the person:** a delete removes every file.
  - **By an administrator:** a removal needs a reason; the files are
    deleted, the action goes in the audit trail, and the person is told.
- **On someone else's behalf.** An administrator can only *suggest* a photo
  for someone. It becomes their photo only when they accept it, and that
  acceptance is the recorded agreement.

**Face detection**

- MediaPipe Face Detector (Apache-2.0) runs in the browser.
- The model and engine are served from TaskFlow itself, pre-compressed
  (2.9 MB, downloaded once and kept). It loads only when someone opens the
  photo editor.

**Colours**

- **One set of colour rules** (`shared/brandTheme.js`), used by both the
  server and the browser, works out every shade from one colour: hover,
  pressed, wash, border, the dark-mode version and the text on top. It checks
  every combination the app uses, and offers the nearest shade that passes.
- **The organisation theme** is set in Settings → Branding, with a live preview
  and Save, Reset and Undo.
  - It is public, so the sign-in page can use it.
  - Open copies of the app check for changes when they come back into view and
    every two minutes, so no redeploy is needed.
- **Personal choice.** Light, dark or match my device, and an optional accent
  from colours checked in advance. It is saved to the person's account.

**Branding**

- An administrator can upload a mark, a wordmark and dark versions of each,
  and set the app name. SVGs are cleaned of scripts and served with a strict
  security policy, and pictures are re-encoded.
- The icons are generated from the mark: favicon, 180, 192, 512 and maskable
  512. The manifest is served by the server, with the current name and colour.
- The animated mark follows the attached animation prompt.
  - **Sign-in page:** the intro plays once.
  - **Sidebar:** still, after one intro per session.
  - **Loading screen:** loops.
  - **Reduced motion:** always still.

## Data model (migration 034, additive)

| Table or column | What it holds |
|---|---|
| `users.photo_version` | The current photo's version, or null when there is none |
| `users.theme_mode`, `users.theme_accent` | The person's own choice |
| `user_photos` | One row per person: version, files, the editor settings for re-cropping, who uploaded it, when the person agreed, and the removal reason |
| `user_photo_proposals` | Photos an administrator suggested, waiting for the person: pending, accepted, declined or withdrawn |
| `branding_history` | Every saved branding value, for Undo and the record |

**Rollback:** deploy the previous version. It ignores the new columns and
tables, and nothing is lost. The organisation theme sits under its own
settings key.

## Decisions for an administrator

1. **App name.** The default is "TaskFlow", with "by ekosight" underneath and
   the Soil Doctor mark.
2. **Colours.**
   - Primary: Deep green `#073F2A`.
   - Accent: Soil `#8B5E3B`.
3. **The wordmark you sent is a raster image** (2000×592 WebP), not an SVG. It
   is used until an SVG is supplied. In dark mode it sits on a light plate,
   because recolouring it is not allowed.
4. **Who can see photos:** everyone signed in to TaskFlow.
