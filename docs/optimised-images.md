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
`publicDir` is set to anything else, or to a value it cannot read (a `URL`).

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
