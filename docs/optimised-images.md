# Optimised images

A plain `z.string()` image field stores a path such as `/images/team.jpg`,
and the upload sits in `public/images/`. Astro never optimises files in
`public/`, so a template that prints the path serves the original upload,
often a multi-megabyte photo, to every visitor at every screen size.

`CmsImage` renders that same string through Astro's image pipeline. The
uploads stay where they are. Visitors get AVIF and WebP variants at several
widths through `srcset` and `sizes`, with a capped JPEG fallback. `image()`
fields are not affected: Astro already optimises those.

## Prerequisites

- **Astro 7 or later.** The component matches file extensions in any case
  (`.JPG` uploads) with a Vite 8 glob option, which Astro 6 does not have.
- **`sharp` 0.35.4 or later in the site's own `dependencies`.** Every editor
  upload is now decoded by Sharp, at build time and in `astro dev`. Earlier
  Sharp versions are open to the AVIF decoder advisory GHSA-26w7-cxv4-gfx2.
  `astro build` loads the **site's** `sharp`, not the one nested inside
  Astro: Astro bundles its image service into the build output and resolves
  `sharp` from the site root. A site that declares `sharp` ^0.33 builds with
  0.33 even when Astro itself depends on a patched version. Removing the
  site's `sharp` fails the build (`MissingSharp`), so bump it instead:

  ```bash
  npm install sharp@^0.35.5
  ```

To confirm which Sharp a build loads, clear Astro's image cache first. A warm
cache (`node_modules/.astro`) never loads Sharp, so a check against it proves
nothing:

```bash
rm -rf node_modules/.astro && npx astro build
```

### The public folder

The site must keep Astro's default `publicDir`, `./public`. `CmsImage` and
`CmsVideo` find `/images/...` values with a glob fixed at
`/public/images/**` (a glob cannot take a value from the config), and the
editor uploads into `public/images/`. With `publicDir: './static'` every local
image or video fails the build as missing. `astroadmin doctor` warns when
`publicDir` is set to anything else, or to a value it cannot read without
running the config (an environment variable, a helper's result).

### Astro 7 and vendor prefixes

Astro 7 builds with Vite's `build.target: 'esnext'`. Vite 8 derives the CSS
target from it, so its CSS minifier has no browser list and strips vendor
prefixes it judges redundant, such as `-webkit-backdrop-filter`. This is not
specific to images, but every site moving to Astro 7 for them meets it. Set
the CSS target to Vite's own default list:

```js
// astro.config.mjs
export default defineConfig({
  vite: {
    build: {
      cssTarget: ['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4'],
    },
  },
});
```

## Setup

Replace the `<img>` that prints a CMS image string with `CmsImage`:

```astro
---
import CmsImage from 'astroadmin/components/CmsImage.astro';
const { data } = Astro.props.entry;
---
<CmsImage
  src={data.heroImage}
  alt={data.heroImageAlt}
  sizes="(min-width: 1024px) 480px, 100vw"
  class="w-full rounded"
  data-aa-field="heroImage"
/>
```

Props:

| Prop | Default | Meaning |
|---|---|---|
| `src` | `''` | The stored string. Empty renders nothing. |
| `alt` | `''` | Alt text. |
| `sizes` | required | The slot's rendered width (see below). |
| `widths` | `[400, 640, 800, 1024, 1280, 1600, 2048, 2560]` | Candidate widths. Those at or above the original's width are dropped. The original's width is added when it is no wider than the largest candidate, so a 6000px upload stops at 2560. |
| `fallbackFormat` | `'jpg'` | Format of the `<img>` fallback (`'jpg'`, `'webp'` or `'png'`). |
| `fallbackMaxWidth` | `1600` | Widest the fallback is generated. |
| `quality` | `80` | Encoder quality for every variant (AVIF, WebP and the fallback): `1`-`100`, or Astro's presets `'low'` (25), `'mid'` (50), `'high'` (80), `'max'` (100). See below for when no default is applied. |

AVIF needs an explicit quality. Astro's Sharp service passes none when
`<Picture>` is given none, and Sharp then encodes AVIF at 50 while WebP and
JPEG get 80. On a real photograph, AVIF at 50 visibly smoothed fabric and
sand texture; at 80 it did not, for roughly two and a half times the bytes
(still well under the JPEG). So CmsImage passes 80 to every format. It
passes nothing, leaving Sharp's defaults as before, in two cases: when the
site sets a `quality` for any format in `image.service.config` in
`astro.config.mjs` (the site's setting wins), and when `fallbackFormat` is
`'png'`, because a PNG quality below 100 makes Sharp reduce the fallback to
a 256-colour palette. Pass `quality` yourself in either case if you want it.

Every other attribute (`class`, `loading`, `fetchpriority`, Astro's
`priority`, `data-aa-field`...) is passed to the `<img>`, which is the
element a click lands on, so [click-to-edit](./inline-editing.md) keeps
working. `<Picture>` wraps that `<img>` in a `<picture>` element, so a CSS
rule that targets the image by a parent's child selector (`.card > img`) may
need adjusting, and in a grid or flex container the `<picture>`, not the
`<img>`, becomes the item. To keep the `<img>` as the item, pass
`pictureAttributes={{ class: '...' }}` with `display: contents` on the
`<picture>` **and** `display: none` on its `<source>` elements (in Tailwind,
`contents [&>source]:hidden`). With `display: contents` alone, the empty
`<source>` elements become grid or flex items too and can push the image
into another row. Hiding a `<source>` does not change which one the browser
chooses.

What it renders:

- `/images/<path>` naming a JPEG, PNG, WebP or AVIF file in
  `public/images/`: a `<picture>` with AVIF and WebP sources and a JPEG
  fallback. Paths are matched exactly, including case; only the extension
  matches in any case. They are also matched literally, so a URL-encoded
  value (`/images/my%20photo.jpg` for `my photo.jpg`) does not match.
  AstroAdmin's uploads never store one.
- An external URL, an SVG or a GIF: a plain `<img>` with the original `src`.
- A `/images/` raster path with no file: **the build fails**, naming the
  content value, so a broken path cannot reach production. A path that
  differs only in case also fails, even on a case-insensitive disk.

Images are lazy-loaded by default. For the largest image in the first
screen (a hero), pass `loading="eager"` and `fetchpriority="high"`, or
Astro's `priority`.

## Choosing `sizes`

`sizes` tells the browser how wide the image will be painted, before it has
laid out the page, so it can pick a variant from `srcset`. It is required
because only the site knows the slot. Write it from the layout, from the
widest breakpoint down:

- A full-width band: `100vw`.
- A column that is half the content width above `md` (768px), inside a
  `max-w-6xl` (1152px) container with 2rem padding:
  `(min-width: 1216px) 560px, (min-width: 768px) calc(50vw - 48px), calc(100vw - 32px)`.
- A fixed-size avatar: `96px`.

The browser multiplies by the device pixel ratio itself, so a `480px` slot
on a 2x screen fetches the 1024 variant. Don't double the values.

**Cover-fitted slots need more.** A slot that crops its image with
`object-fit: cover` paints the image at whatever width fills the slot's
height, which can be far wider than the slot. A hero that is the full
viewport height on a 375 × 812 phone, over a 2:1 landscape photo, paints the
photo about 1600 CSS pixels wide, of which the phone shows 375. Width-based
`sizes="100vw"` asks for 375 (750 at 2x) and the photo is upscaled and
blurred. Work out the painted width at each breakpoint
(slot height × image aspect ratio, when that exceeds the slot width) and
write `sizes` from that. For a slot the size of the viewport over a 2:1
photo, the photo fills the width when the viewport is wider than 2:1 and is
painted twice the viewport height wide otherwise. `srcset` stops at the
original's width, so a large `sizes` value cannot fetch more than the
original:

```astro
<CmsImage
  src={data.heroImage}
  alt=""
  class="absolute inset-0 h-full w-full object-cover"
  sizes="(min-aspect-ratio: 2/1) 100vw, 200vh"
  loading="eager"
  fetchpriority="high"
/>
```

Check the result in a browser: the image's `currentSrc` width should be at
least the painted width times the device pixel ratio, unless the original is
smaller.

## Focal point

A cover-fitted slot shows the middle of the photo and cuts off the rest,
which is the wrong part of it as often as not. In the image library an
editor selects an upload from `public/images/` and clicks the preview where
the subject is. The point is saved at once, as percentages of the
original's width and height, in `public/images/.metadata.json`, the file
that holds the alt text. Entries are keyed by the image's site path, the
value the content holds:

```json
{
  "/images/team/photo.jpg": {
    "alt": "The team outside the workshop",
    "focalPoint": { "x": 30, "y": 20 }
  }
}
```

"Reset focal point" removes it. Entries written by earlier versions are
keyed by the bare file name (`"photo.jpg"`); they are still read, and the
next change to such an image moves its entry to the site path.

`CmsImage` reads the file when it renders, in a build and in `astro dev`
(where it re-reads a changed file, so a point set in the editor reaches the
preview on the next render), and adds `object-position: 30% 20%` to the
`<img>`'s `style`. A `style` the site passes is kept, with the declaration
appended after it. With no point the HTML is byte-identical to what it was.
`object-position` only takes effect in a slot that crops the image,
`object-fit: cover` (or `contain`), which is the slot the focal point is
for. An inline style outranks a class, so a site's `object-top` (or any
`object-position` in a stylesheet) is overridden on an image that has a
point. To keep a slot's own alignment, opt that slot out:

```astro
<CmsImage src={data.heroImage} alt="" class="object-cover object-top" focalPoint={false} />
```

The focal point applies to `/images/` uploads rendered through `CmsImage`
and nothing else. `image()` fields render through Astro's own `<Image>`,
which reads no metadata, so the library shows no focal point control for
them, nor for the files in `src/assets/images/`. `CmsVideo` has none
either: `object-position` would move the playing frames.

The metadata file is under the default `git.paths`, so it is committed and
deployed with the site, at `/images/.metadata.json`. It holds only alt
text, focal points and crops.

## Crop

A focal point moves the image within its slot; a crop changes which part of
the image is used at all. An editor drags a rectangle over the preview in
the image library, and the crop is stored beside the focal point, as
percentages of the original:

```json
{
  "/images/team/photo.jpg": {
    "focalPoint": { "x": 30, "y": 20 },
    "crop": { "x": 10, "y": 5, "width": 60, "height": 80 }
  }
}
```

The original file is not changed, and uploading it once per slot shape is
no longer needed. `CmsImage` cuts every AVIF, WebP and JPEG variant from the
crop: the candidate `widths` stop at the crop's width rather than the
original's, the fallback's `width` and `height` attributes are the crop's,
and the focal point, which is still set on the original, is translated into
the crop frame. "Clear crop" removes it, and the next build renders the
whole image again.

Astro's image service resizes but has no crop step, so cropping needs the
site to opt in twice:

1. The image service, in the Astro config. `astroadmin/image-service` wraps
   Astro's sharp service: it extracts the crop and hands the result to that
   service for resizing and encoding. An image without a crop goes through
   unchanged.

   ```js
   // astro.config.mjs
   import { defineConfig } from 'astro/config';

   export default defineConfig({
     image: {
       service: { entrypoint: 'astroadmin/image-service' },
     },
   });
   ```

2. The editor's crop control, in `astroadmin.config.js`. Without it the
   image library shows no crop control, so no crop can be stored on a site
   that cannot apply one.

   ```js
   // astroadmin.config.js
   export default {
     images: { crop: true },
   };
   ```

Nothing is dropped quietly. A build that renders an image with a stored
crop on a site whose service is not `astroadmin/image-service` fails,
naming the image, and the publish check refuses the commit with that
reason: add the service, or clear the crop in the image library. The
component checks the service Astro loaded, so naming it another way (a
local file re-exporting it, or an absolute path) is the same service.
`astroadmin doctor` reports the three mismatches before a build does
(`images.crop` without the service, the service without `images.crop`, and
a stored crop on a site without the service); see
[image-crop-service](./doctor.md#image-crop-service).

In `astro dev`, a file uploaded after the server started renders as the
plain original (see below) with its focal point only; the crop shows after
a restart of the dev server, and in every build. In `astro dev` on a site
without the service, a stored crop is skipped rather than refused, so the
preview still renders: the `<img>` carries `data-cms-image="crop-skipped"`
and the dev server logs the same message the build would fail with. The crop applies to the
same images the focal point does: `/images/` uploads rendered through
`CmsImage`, not `image()` fields or `CmsVideo`.

## In `astro dev` and the editor

Vite reads the list of files in `public/images/` when the dev server starts,
and again on file events. With `vite.server.hmr: false` (which a proxied
hosted preview needs) it does not see a file that an editor has just
uploaded. So in `astro dev` only, a path that is not in that list but does
exist in `public/` renders as a plain `<img>` of the original, marked
`data-cms-image="dev-original"`. The preview shows the new photo at once.
The next build, or the next dev server restart, optimises it. A path that
exists nowhere is an error in dev too.

In `astro dev` the `<picture>` has WebP sources only, no AVIF: the dev
server encodes every variant on request with no cache, and an AVIF variant
of a large upload took about 20 s against well under a second for WebP. The
build still emits AVIF and WebP.

Both dev-only behaviours follow the command, not `NODE_ENV`: the component
checks `import.meta.env.MODE === 'development'`, which only `astro dev`
sets. Astro derives `import.meta.env.DEV` from `NODE_ENV`, so a build run
with `NODE_ENV=test` or `development` (CI, `bun test`) has `DEV` true, and
`astro dev` with `NODE_ENV=production` has it false. Gated on `DEV`, such a
build would drop AVIF and skip the strict missing-file error.

Publish runs a build first, and the build has no such fallback, so a path
that only resolves on a case-insensitive disk is caught there.

## Build output

Each image is encoded once per width and format, so the first build of a
site with many large uploads takes longer. Astro caches the variants in
`node_modules/.astro`; keep that directory between builds on your host if
it allows.

Rollup also copies each original that a page renders into `/_astro/`,
alongside `/images/`. Nothing links to that copy, so visitors never download
it, but it adds the originals' size to the deploy a second time. Only
originals that pages actually render are copied.
