# AstroAdmin

A content editor for Astro sites. Its forms come from the Zod schemas in
`src/content.config.ts`, and it saves to the markdown and JSON files your
`glob()` and `file()` loaders read, so removing AstroAdmin leaves a site that
still builds. Publishing is a git commit and push.

[![npm](https://img.shields.io/npm/v/astroadmin)](https://www.npmjs.com/package/astroadmin)
[![license](https://img.shields.io/npm/l/astroadmin)](./LICENSE)

![The AstroAdmin editor: a form for the page's hero block generated from the site's schema on the left; the site rendered live in its own dev server on the right](https://raw.githubusercontent.com/cloudshipco/astroadmin/main/design/astroadmin-editor.jpg)

## Features

- Strings, numbers, booleans, enums, dates, images, arrays, nested objects
  and `{collection}Ids` references each get a matching control.
- A discriminated union in a schema becomes a block editor: a list of page
  sections that editors can add, reorder and fill in.
- The preview iframe is your site running under `astro dev`, with your
  styles and components.
- With `data-aa-field` attributes on your templates, a click on text in the
  preview opens its field, and focusing a field outlines its text.
  See [inline editing](./docs/inline-editing.md).
- A save writes the file atomically. If the entry fails its schema, the save
  still goes through and the editor shows which fields are wrong.
- Image uploads with alt text, and an image library.
- Login uses an argon2 password hash and is rate limited.

## Quick start

AstroAdmin runs on [Bun](https://bun.sh), so Bun must be installed. From your
Astro project root:

```bash
npx astroadmin dev
```

This starts AstroAdmin and your Astro dev server together and prints both
URLs.

```bash
# Another port, or a project elsewhere
npx astroadmin dev --port 3030 --project ./my-astro-site
```

```bash
# You run the Astro dev server yourself
npx astroadmin dev --no-astro
```

```bash
# Check the site's setup and click-to-edit coverage
npx astroadmin doctor
```

The default login is `admin` / `admin`. Before the editor is reachable from
the internet, set `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` (from
`npx astroadmin hash-password`) and `SESSION_SECRET`. AstroAdmin prints a
warning at startup if production runs with weak auth settings.

## Requirements

- Bun
- Astro 6 or later, with `astro.config.mjs` or `astro.config.ts`
- Content collection schemas in `src/content.config.ts`

```text
your-astro-site/
├── astro.config.mjs        (required)
└── src/
    ├── content.config.ts   (required: collection schemas)
    └── content/
        ├── pages/          (example glob() collection)
        │   ├── home.md
        │   └── about.md
        └── team.json       (example file() collection)
```

Markdown with frontmatter is used for `glob()` collections and JSON for
`file()` collections, at the paths your loaders declare. No content
collections yet? See the [setup guide](./docs/content-collections.md).

## Publishing

Publish commits the configured paths (`src/content/`, styles and images, set
by `config.git.paths`) and pushes. A host that builds on push, such as Netlify,
Cloudflare Pages or GitHub Pages via Actions, then rebuilds the site.

Before pushing, AstroAdmin builds that exact commit with the site's own
installed Astro. If the build fails, the commit stays local and the editor
sees Astro's error, so content your schema rejects never reaches the host.
See [the pre-push build check](./docs/configuration.md#the-pre-push-build-check).

Without a build-on-push host, a [deploy adapter](./docs/deploy-adapters.md)
(rsync is the only one so far) builds and deploys from the machine running
AstroAdmin. `GIT_ENABLED=false` turns git off for adapter-only setups.

An `.mdx` body can import modules and run JavaScript during the publish
build, so anyone who can save an MDX entry can run code on the server. Give
MDX editing only to people you would trust with the site's code.

## Astro integration (optional)

Collections that are not pages, such as testimonials or team members, have no
URL to preview. The integration adds a `/component-preview/` route in
development that renders the item being edited inside its block component:

```javascript
// astro.config.mjs
import { defineConfig } from 'astro/config';
import astroadmin from 'astroadmin/integration';

export default defineConfig({
  integrations: [astroadmin()],
});
```

It looks for block components at `src/components/blocks/{BlockType}Block.astro`
(for example `TestimonialsBlock.astro`). Without the integration, those
collections show a 404 in the preview. The integration also injects the
click-to-edit script into the preview (never into a production build).

## Configuration (optional)

`astroadmin.config.js` in the project root:

```javascript
export default {
  preview: {
    url: 'http://localhost:4321', // Astro dev server
  },
  auth: {
    username: process.env.ADMIN_USERNAME || 'admin',
    passwordHash: process.env.ADMIN_PASSWORD_HASH, // npx astroadmin hash-password
  },
};
```

The [configuration reference](./docs/configuration.md) covers the rest. Also
in `docs/`: [getting started](./docs/getting-started.md),
[requirements](./docs/requirements.md), [blocks](./docs/blocks.md) and
[doctor](./docs/doctor.md).

## Troubleshooting

**"Invalid Astro project".** Run AstroAdmin from the directory containing
`astro.config.mjs`, and check that `src/content.config.ts` exists. See
[requirements](./docs/requirements.md).

**The preview does not load.** AstroAdmin starts Astro itself; look for
`[astro]` lines in its output. With `--no-astro`, your dev server must be
running at the URL in `preview.url` (port 4321 by default).

**A click in the preview does nothing, or the first publish on a new host
fails.** Run `npx astroadmin doctor`.

## Hosted version

We are building a hosted AstroAdmin: connect a repo, invite editors, and we
run the editor, previews and builds. To hear when it is ready, give a 👍 or
describe your use case on the
[waitlist issue](https://github.com/cloudshipco/astroadmin/issues/25), or
email [james@cloudship.co.uk](mailto:james@cloudship.co.uk?subject=AstroAdmin%20hosted%20waitlist).

## SQLite content store (not recommended)

An older storage mode keeps content in `.astroadmin/content.db`, read at build
time by the `astroadmin/loader` loader. It is off unless
`content.store = 'db'` (env `ASTROADMIN_CONTENT_STORE=db`) and is not under
active development. To move a site back to files, switch
`src/content.config.ts` to `glob()`/`file()` loaders first, then run
`npx astroadmin export`.

## License

MIT
