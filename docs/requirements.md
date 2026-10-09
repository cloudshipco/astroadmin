# Requirements

## Software

| | Version | Why |
|---|---|---|
| Bun | 1.0 or later | The `astroadmin` command runs under Bun. |
| Astro | 6 or later | Content collections with loaders, in `src/content.config.ts`. |
| Zod | the one Astro ships | Import it as `z` from `astro/zod`. |

Astro must be installed in the site itself: AstroAdmin runs the `astro` in
the site's `node_modules` (or in a `node_modules` above it, up to the
repository root) for the preview, the publish check and `doctor`. With none
installed it refuses rather than download one.

## Project layout

```text
your-astro-site/
├── astro.config.mjs        (or astro.config.ts)
├── astroadmin.config.js    (optional)
├── public/
│   └── images/             (image uploads; created on first upload)
└── src/
    ├── content.config.ts   (or .mts, .js, .mjs)
    └── content/
        ├── pages/          (a glob() collection: one .md file per entry)
        │   ├── home.md
        │   └── about.md
        └── team.json       (a file() collection: one JSON array)
```

The collection folders and files can live anywhere; AstroAdmin reads and
writes wherever each loader points. A `glob()` loader without a `base` is
read from `src/content/<collection>/`.

## Content files

| Kind | Files | Notes |
|---|---|---|
| `glob()` collection | `.md`, `.mdx` or `.json`, one per entry | The slug is the path under `base`, without the extension. New entries get `.md`, or `.mdx` when the loader pattern matches only `.mdx`. |
| `file()` collection | One `.json` file | Must be an array of objects; entries are matched by `id`. |

YAML and TOML data files are not supported.

## Startup errors

`npx astroadmin dev` checks the project before starting and stops with
"Invalid Astro project" if a file is missing.

"Not an Astro project (no astro.config.mjs or astro.config.ts found)": run
the command from the site's root, or pass `--project <path>`. A config named
`astro.config.js` is not recognised.

"Missing src/content.config.ts (Content Collections not set up)": create the
file and export `collections` from it. [Getting started](./getting-started.md)
has a minimal one. The older `src/content/config.ts` location is not read.

"Not starting the Astro dev server: astro is not installed in this site"
does not stop the editor, but it starts without a preview. Install the site's
dependencies (`npm install`), or run your own dev server and start AstroAdmin
with `--no-astro`.
