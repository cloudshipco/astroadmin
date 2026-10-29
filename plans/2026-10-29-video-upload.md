# Video upload: a video field, a picker and a CmsVideo component

Status: BUILT on main (2026-10-29), unreleased; next: a minor release.

Proxy check (2026-10-29): there is no standing test instance on the hosted
box, so the upload was driven through a local nginx 1.27 in Docker with the
editor vhost's `client_max_body_size 25m` and default request buffering, in
front of a throwaway admin. 19MB and exactly 20MB installed; 20MB+1 and 24MB
got our "Videos must be under 20MB" refusal; 26MB got nginx's own 413 page,
which the editor never reaches because it refuses files over 20MB before
sending. Not yet repeated on the box itself.

Three review rounds (9, 10, 10 findings). Deferred: CmsVideo copies
CmsImage's dev-only `existsInPublic` (with its `process.cwd()` root) instead
of sharing it; a library video opened directly in a tab is blocked by the
`/images` CSP (no `media-src`); CmsImage itself ignores `base` for the files
it leaves unoptimised (SVG, external, dev original).

## The request

A client site wants a short looping video behind the homepage title instead of
the hero photo, and the editor wants to change it herself. Today the only video
a site can show is a YouTube block (a pasted link, played click-to-load), which
is the wrong tool for a background: an autoplaying YouTube iframe contacts
Google before the visitor does anything, and its branding, pause overlay and
end screen leak through. What the site needs is a muted, looping, self-hosted
file, and AstroAdmin has no way to upload one.

## What is true now (main at 39c40ec)

- Uploads go through `server/api/images.js`: multer stages the body outside the
  checkout, then `installUpload` moves a complete file in under a checkout
  hold. `ALLOWED_EXTENSIONS` (line 124) is images only; `MAX_FILE_SIZE` is
  10MB (line 125); the filter and the `:filename` param check both key off the
  extension list.
- Metadata (alt text etc.) lives in `public/images/.metadata.json`, written
  through `updateMetadata`'s queue.
- The editor chooses a widget by field name or schema hint: `isImageField`
  (`ui/form-generator.js:911`) matches names ending in `image`, `logo`,
  `background`, `photo` and so on, or `format`/`widget: 'image'`. There is no
  video equivalent. All three surfaces (main form, block bodies, array item
  modal) render through `generateField`; a video field must work in all three
  by fixing `generateField`, never by a second renderer (see CLAUDE.md).
- On the hosted box nginx allows `client_max_body_size 25m`
  (`nixos/astroadmin-instance.nix:490`). Anything above that never reaches
  multer and the editor sees nginx's 413 page, not our error.
- Uploads are committed to the site repo and pushed on publish. Every video an
  editor swaps in stays in that repo's history permanently, and GitHub warns
  at 50MB and refuses files over 100MB.
- `components/CmsImage.astro` is the site-side renderer for image strings; there
  is no counterpart for video.

## Proposal

### 1. Accept video files

- Allow `.mp4` and `.webm` (not `.mov`: browsers other than Safari will not
  reliably play QuickTime-wrapped files). Give videos their own size cap,
  separate from images: 20MB, which fits under nginx's 25m with room for the
  multipart envelope. Refuse over the cap with our own message ("Videos must be
  under 20MB; export at 720p, about 20 seconds") before nginx has a chance to.
  The browser can check `file.size` before sending, so the editor never uploads
  a file only to be refused.
- Check content, not just the extension: sniff the first bytes (`ftyp` box for
  MP4, the EBML header for WebM) so a renamed file is refused.
- Decide where the files live. Recommendation: the same `public/images`
  directory and metadata file, so the library, delete, rename and reference
  checks all work unchanged. A separate `public/videos` would be tidier but
  doubles every directory-walking path in `images.js`. Write the decision here
  before building.
- Keep the shared filename/param guard: extend the allowed list rather than
  adding a second guard.

**Decision (2026-10-29): videos live in `public/images` beside uploaded
images**, with the same metadata file. Library listing, delete, rename and the
`:filename` guard work unchanged; each listed file carries `kind: 'image' |
'video'` and each picker filters on it. Videos are public files only: an
`image()` upload (`?for=image-field`), the `entry-value` route and the
`entry-file` preview refuse them, since Astro's `image()` cannot import a
video. A QuickTime file renamed `.mp4` (`ftyp` brand `qt  `) is refused by the
sniff.

### 2. A video field in the editor

- `isVideoField(name, schema)`: names ending in `video`, or
  `format`/`widget: 'video'`. Check it BEFORE `isImageField` in
  `generateField`, and add a test that `backgroundVideo` and `heroVideo` get the
  video widget, not the image one, because `background` is on the image name
  list.
- The picker reuses the image picker's modal and library, filtered to videos
  (and the image picker filtered to images, so a video can't be put into an
  image field). The thumbnail is a muted `<video preload="metadata">`, not an
  `<img>`.
- Bind it like every other control (`bindOriginalValues`), so an untouched
  video field saves its stored value unchanged.

### 3. `components/CmsVideo.astro`

A site-side component for a stored video path, the counterpart to `CmsImage`:

- `<video muted loop playsinline autoplay preload="metadata" poster={poster}>`
  with the file as its source. `muted` and `playsinline` are both required for
  autoplay on iOS.
- A `poster` prop, rendered through `CmsImage`'s pipeline, so the first paint
  is an optimised still.
- Reduced motion: under `prefers-reduced-motion: reduce` it does not autoplay
  and shows the poster alone.
- A visible pause/play button (WCAG 2.2.2: motion longer than five seconds must
  be pausable). Ship it as part of the component so sites can't forget it, and
  keep its styling minimal and overridable (site agnosticism).
- Forwards every other attribute (`data-aa-field`, `class`) like `CmsImage`.
- Missing file: the same build/dev behaviour as `CmsImage` (an error at build,
  the original in dev).
- Document the site's CSP: `media-src 'self'` if the site sets a CSP.

### 4. Later, not now

- Server-side transcoding (ffmpeg on the NixOS box) to a fixed 720p H.264 MP4
  plus WebM, which would make the size cap easy to live with. ffmpeg is easy to
  add via the module, but it is a CPU job on a shared box and needs a queue.
  Revisit if editors keep hitting the cap.
- Git LFS or object storage for media, if repo growth becomes a problem.

## Tests

- Upload: an MP4 and a WebM install and list; a `.mov`, a renamed `.txt` with
  an `.mp4` name, and a file over the cap are refused with our message (watch
  each go RED against the current extension list).
- Field detection: `heroVideo`, `backgroundVideo`, `format: 'video'` → video
  widget, in the main form, a block body and the array item modal.
- Round trip: an untouched video field saves byte-identical content.
- CmsVideo: rendered markup has `muted`, `playsinline` and `loop`, plus the
  poster and the pause control. Drive it in a real browser (Playwright, already in
  the repo) for autoplay, pause and reduced motion; markup alone does not prove
  the video plays.
- Hosted path: upload a 19MB file through nginx on a test instance, not a
  client's.

## Rollout

Release a minor version (new feature). The client site then adds a
`heroVideo` field and a poster to its home schema, renders it with
`CmsVideo`, bumps its astroadmin dependency and redeploys its editor. That
site-side work is tracked in the site's own repo.
