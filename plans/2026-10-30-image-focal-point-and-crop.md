# Image focal point and non-destructive crop (#82)

Status: BUILT on main (2026-10-30), awaiting a review pass and release as
1.12.0. Commits 8f7cc57 (server), a3e2dc2 (doctor and docs), 0efe52a (image
library), a8ad6a8 (CmsImage, site-files, image service), 681e66c (a stored
crop stays visible and clearable with `images.crop` off). Every check was
seen red first or by a mutant (the lanes' notes are in
`ignored-plans/2026-10-30-focal-crop-lanes/`, local only). On the merged
tree: the fast suite, cms-image-packed (49), cms-video-packed (26),
check-linked-styles (6) and image-focal-browser (11) pass.

## The request

Sites show photos in cover-fitted slots (full-height heroes, fixed-ratio
portraits). The browser crops to the centre, which cuts off the subject, and
an editor's only fix today is to crop the file elsewhere and upload it again,
once per slot shape. #82 asks for a focal point an editor sets by clicking,
applied as `object-position`, and (phase 2 in the issue) a non-destructive
crop kept as metadata and applied by the image pipeline.

Decisions taken with James at the start of this session:

- **Key metadata by site path** (`/images/team/x.jpg`), the value the content
  holds, not the bare filename. Reads fall back to the bare filename so
  existing alt text still shows; a write moves the legacy entry to the new
  key and removes the old one.
- **Build both the focal point and the crop now**, not focal point only.

## What is true now

- `PUT /api/images/:filename/metadata` stores whatever JSON it is sent under
  `alt` and `focalPoint` in `public/images/.metadata.json`, keyed by bare
  filename, under `updateMetadata` (a queue plus a checkout hold). The listing
  returns `alt` and `focalPoint`. No UI sets a focal point; nothing on the
  site side reads the file, not even for alt text.
- `DELETE /api/images/:filename` unlinks the file and leaves its metadata, so a
  re-upload of the same name inherits the old alt text.
- The listing dedupes by bare filename across the three folders in order
  (`src/assets/images`, `public/images`, `src/content/assets/images`), so a
  public upload is hidden when a src/assets image shares its name. The admin
  serves `/images` from src/assets/images first, then public/images, so for
  those two the collision is real at the URL too; the image() folder is served
  at `/assets/images` and need not be hidden.
- `components/site-files.js` (#79, done) resolves the site's `public/` from
  Astro's own root with sync fs; `CmsImage.astro` renders `/images/...`
  strings through `<Picture>` from a lazy glob, forwarding every other prop to
  the `<img>`.
- Astro's sharp service (7.3.8) resizes with `fit`/`position` only; it has no
  extract step. A service may add transform keys: `getURL`/`parseURL` carry
  them through the dev `/_image` endpoint, `propertiesToHash` names what the
  build hashes, and `transform(buffer, options, config)` gets the full options.

## Design

### Metadata (server/api/images.js)

- Key: the image's site path as the listing returns it (`url`):
  `/images/<name>` for src/assets and public uploads, `/assets/images/<name>`
  for image() files. `getImageMetadata(metadata, url, filename)` reads the
  site-path key, else the bare filename (legacy). `PUT` writes the site-path
  key and, when a legacy entry exists, moves its other fields in and deletes
  it. Keys stay own-key lookups (`Object.hasOwn`).
- Validation (one `validateMetadataPatch(body)` helper, 400 with fixed text):
  `alt` a string; `focalPoint` `{x, y}` finite numbers 0-100 or `null`;
  `crop` `{x, y, width, height}` finite percentages with `x+width <= 100`,
  `y+height <= 100`, `width > 0`, `height > 0`, or `null`; `null` deletes the
  key; any other key, a non-object body, and prototype keys are refused.
  The PUT reports the entry as written.
- `DELETE` removes the metadata entry (site-path and legacy keys) in the same
  `updateMetadata` step as the unlink, so a re-upload starts clean.
- Listing: dedupe by `url`, not filename (the `assets` folder's image is then
  listed beside a same-named upload); return `crop` beside `focalPoint`.
- The focal point is in the ORIGINAL's coordinates whether or not a crop is
  set; the site side translates it into the crop frame.

### Editor (ui/image-library.js, ui/input.css)

- When the selected image is a public upload (`source === 'uploads'`, kind
  image), the footer shows a preview with the image at a bounded size:
  a click sets the focal point (a marker drawn at the point; a "Reset focal
  point" button clears it); a pointer drag draws the crop rectangle (shaded
  outside, "Clear crop" clears it). Each change is saved at once through the
  existing PUT and the item in `currentImages` is updated, like alt text.
  Percentages come from the click's offset over the rendered image box
  (`getBoundingClientRect`), so the natural size never matters.
- Hidden for `source` (src/assets, not deletable and not ours) and `assets`
  (image() values render through Astro's `<Image>`, which ignores metadata),
  and for videos (CmsVideo is out: `object-position` moves the playing frames).
- The crop control is shown only when `/api/config` says the site enabled the
  crop service (`images.crop`, below): a crop with no service would be stored
  and never rendered, and the publish check cannot tell.

### Site side (components/)

- `site-files.js`: `imageMetadata(sitePath)` reads
  `<publicDir>/images/.metadata.json` with sync fs, parses once per process
  and re-reads when the file's mtime changes (so a point set during
  `astro dev` reaches the preview on the next render); returns the entry at
  the site-path key, else the bare-filename key, else `{}`; a missing or
  unparsable file is `{}`. Only `focalPoint` and `crop` are read, and each is
  validated again (the file is deployed data).
- `CmsImage.astro`:
  - a focal point becomes `object-position: <x>% <y>%` merged into the
    site's `style` prop (`style` string or object, appended after it); a new
    `focalPoint={false}` prop opts a slot out; with no point the HTML is
    byte-identical to today's.
  - a crop is passed to `<Picture>` as `crop` (the service consumes it),
    with `widths`, `width` and `height` computed from the cropped size, and
    the focal point translated into the crop frame (clamped). In a build
    with a crop set and `imageConfig.service.entrypoint` not
    `astroadmin/image-service`, throw an error naming the image and the
    setting (the publish check turns it into a sentence; the raw text goes
    to the log as today). In dev the `dev-original` branch cannot crop:
    render the plain original with the focal point only.
- `components/image-service.js` (exported as `astroadmin/image-service`):
  Astro's sharp service wrapped. `validateOptions` checks `crop`;
  `getURL` appends `crop=x,y,w,h`; `parseURL` reads it; `propertiesToHash`
  is the parent's plus `crop`; `getHTMLAttributes` strips `crop`;
  `transform` pre-crops with sharp (`rotate()` then `extract` in pixels
  rounded from the percentages against the rotated size) and hands the
  cropped buffer to the parent. The site enables it with
  `image: { service: { entrypoint: 'astroadmin/image-service' } }` and
  `images: { crop: true }` in astroadmin.config.js.
- Doctor (`server/doctor/project.js`): warn when `images.crop` is set
  without the service, when the service is set without `images.crop`, and
  when `.metadata.json` holds a crop on a site without the service.

### Docs

`docs/optimised-images.md`: a "Focal point" section after "Cover-fitted
slots" and a "Crop" section with the opt-in; `docs/configuration.md`: the
`images.crop` key. CLAUDE.md: the new tests and the metadata rule.

## Tests, red first

- `tests/image-metadata.test.js` (fast, over HTTP): PUT `{focalPoint:{x:150}}`
  is 400 (200 today); `{crop:{x:60,width:50}}` 400; unknown key 400; `null`
  clears; a write keys by site path and moves a legacy bare-filename entry;
  the listing reads a legacy key; DELETE then re-upload shows no alt
  (shows the old alt today); a same-named `assets` image is listed beside
  the upload (hidden today); `__proto__` refused.
- `tests/image-service.test.js` (fast): `getURL`/`parseURL` round-trip
  `crop`; `validateOptions` refuses bad crops; the hash differs by crop;
  `getHTMLAttributes` emits no `crop`.
- `tests/cms-image-packed.test.js`: with `.metadata.json` holding a point,
  the `<img>` has `object-position: 30% 20%` merged after a site `style`;
  `focalPoint={false}` omits it; without a point the page is byte-identical
  to the pre-change build; with the service and a crop, each emitted AVIF /
  WebP / JPEG is byte-identical to sharp `rotate().extract().resize()` at
  q80 and the fallback width/height follow the crop; the same crop without
  the service fails the build by name; in `astro dev` a point set after
  start reaches the next render.
- `tests/image-focal-browser.test.js` (Chromium, the CLAUDE.md recipe): in
  the real dashboard, select an upload, click the preview at a known point
  and read `.metadata.json`; drag a crop and read it; the control is absent
  for a src/assets image; reset clears.
- `tests/doctor-images.test.js`: the three doctor warnings.

## Lanes

Four writers in worktrees, each briefed with the contract above:

- A server: metadata keys, validation, DELETE cleanup, listing dedupe,
  `images.crop` in config and `/api/config`; `image-metadata.test.js`.
- B editor: the library preview, focal click, crop drag, saves;
  `image-focal-browser.test.js` (against a stub of A's API shape until
  integration).
- C site: `site-files.js` metadata reader, CmsImage, the image service,
  `image-service.test.js`, the packed test additions.
- D doctor and docs.

Integration (parent): run the full fast suite, the packed test and the
browser test on the merged tree; a real-browser save check on a copied site.

## Open points

- The crop UI is a free rectangle; an aspect lock is a later addition.
- `.metadata.json` is deployed at `/images/.metadata.json`; focal points and
  crops are harmless there.
