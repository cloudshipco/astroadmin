# Videos

AstroAdmin can hold short, muted videos for a page background or a hero,
stored in the site's repo next to its images. Use them for a loop behind a
heading. They are not for a talk or a film with sound: put that on a video
host and embed it.

## The field

A `z.string()` field whose name ends with `video`, or that sets
`format: 'video'`, gets a video picker:

```ts
// src/content.config.ts
const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({
    title: z.string(),
    heroVideo: z.string().optional(),
    heroVideoImage: z.string().optional(),
  }),
});
```

`heroVideoImage` ends with `image`, so it gets the image picker. A
`.url()` field ending in `video` stays a URL box, and an `image()` field
stays an image picker whatever its name. The video picker's value is in an
ordinary text box under its buttons, so a field that holds a YouTube link or
id instead of a library file can still be typed into; only a library video is
previewed.

## Files the editor can upload

- **MP4 or WebM**, checked by their contents as well as their names.
  QuickTime `.mov` files are refused: browsers other than Safari do not play
  them reliably. Export an MP4 instead (H.264, which every browser plays).
- **At most 20MB.** About 20 seconds at 720p fits. The editor checks the
  size before uploading.
- Uploads go to `public/images/` and are committed and pushed on Publish
  like images. Every video an editor replaces stays in the repo's history.
  GitHub warns at 50MB per file and refuses files over 100MB.

The image library and the video library are one folder. Each picker offers
only its own kind, so a video cannot be put in an image field. An Astro
`image()` field never takes a video.

## `CmsVideo`

```astro
---
import CmsVideo from 'astroadmin/components/CmsVideo.astro';
const { heroVideo, heroVideoImage } = entry.data;
---
<section class="relative">
  <CmsVideo
    src={heroVideo}
    poster={heroVideoImage}
    wrapperClass="absolute inset-0"
    class="h-full w-full object-cover"
    data-aa-field="heroVideo"
  />
  <h1 class="relative">{entry.data.title}</h1>
</section>
```

It renders a `<video muted loop playsinline preload="metadata">` and starts
it from a small script:

- **Reduced motion.** Under `prefers-reduced-motion: reduce` the video does
  not start; the poster shows, and the visitor can press Play.
- **A pause button.** Motion longer than five seconds must be pausable (WCAG
  2.2.2), so every video has a pause/play button in its bottom-right corner.
  Its styles have zero specificity, so a rule on `.cms-video-toggle` in the
  site's CSS replaces them.
- **The poster** is shown before the video plays. A `/images/...` raster
  poster is resized to `posterWidth` (default 1920) and encoded as WebP.
- **Missing files fail the build**, naming the content value, as
  `CmsImage` does. In `astro dev` a file uploaded after the server started is
  used as it is.
- A local path is served under the site's `base`: `/images/loop.mp4` is
  requested as `/blog/images/loop.mp4` with `base: '/blog'`.
- `class`, `id` and other attributes go on the `<video>`; `wrapperClass` goes
  on the element around it, which positions the button.
- An empty `src` renders nothing. A value that is not a path or URL of an
  `.mp4` or `.webm` file (a bare file name, a YouTube page) fails the build
  with an error naming it.

| Prop | Default | |
|---|---|---|
| `src` | | The stored `/images/...` path |
| `poster` | | A still, shown first and under reduced motion |
| `posterWidth` | `1920` | Largest width the poster is generated at |
| `label` | `'background video'` | Read out on the button: "Pause background video" |
| `wrapperClass` | | Class on the wrapping element |

## Content Security Policy

A site that sends a `Content-Security-Policy` needs `media-src 'self'`, or
the origin its videos are served from. Without it the browser blocks the
video and shows only the poster.
