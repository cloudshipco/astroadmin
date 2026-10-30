# AstroAdmin

A content editor for Astro sites. Its forms come from the Zod schemas in
`src/content.config.ts`, and it saves to the markdown and JSON files your
`glob()` and `file()` loaders read, so removing AstroAdmin leaves a site that
still builds. Publishing is a git commit and push.

[![npm](https://img.shields.io/npm/v/astroadmin)](https://www.npmjs.com/package/astroadmin)
[![license](https://img.shields.io/npm/l/astroadmin)](./LICENSE)

![The AstroAdmin editor: a form for the page's hero block generated from the site's schema on the left; the site rendered live in its own dev server on the right](https://raw.githubusercontent.com/cloudshipco/astroadmin/main/design/astroadmin-editor.jpg)

## Features

- Strings, numbers, booleans, enums, dates, arrays and nested objects each
  get a matching control. Astro's `image()` gets an image picker that saves
  a path the build accepts, and `reference()` gets an entry picker.
- A discriminated union in a schema becomes a block editor: a list of page
  sections that editors can add, reorder and fill in. Markdown entries keep
  their body editor alongside the blocks.
- The preview iframe is your site running under `astro dev`, with your
  styles and components.
- With `data-aa-field` attributes on your templates, a click on text in the
  preview opens its field, and focusing a field outlines its text. Name the
  field as the form does (`title`, `blocks[0].heading`); for a list of
  objects, annotate the list (`blocks[0].items`).
  See [inline editing](./docs/inline-editing.md).
- Edits save automatically; there is no Save button. A save writes the file
  atomically and keeps its key order, comments and formatting. If the entry
  fails its schema, the save still goes through and the editor shows which
  fields are wrong.
- Image uploads with alt text, and an image library.
- Changes to `src/content.config.ts` are picked up without a restart; reload
  the editor tab to see new fields.

## Quick start

AstroAdmin runs on [Bun](https://bun.sh), so Bun must be installed. From your
Astro project root:

```bash
npm install astroadmin
```

```bash
npx astroadmin dev
```

This starts AstroAdmin and your Astro dev server together and prints both
URLs. AstroAdmin listens on port 4000 (or the next free port), and Astro on
the port in `preview.url` (default `http://localhost:4321`, set in
`astroadmin.config.js`).

```bash
# AstroAdmin on another port, or a project elsewhere
npx astroadmin dev --port 3030 --project ./my-astro-site
```

```bash
# You run the Astro dev server yourself, on the preview.url port
npx astroadmin dev --no-astro
```

```bash
# Check the site's setup and click-to-edit coverage
npx astroadmin doctor
```

The default login is `admin` / `admin`. Before the editor is reachable from
the internet, set `NODE_ENV=production`, `ADMIN_USERNAME`,
`ADMIN_PASSWORD_HASH` (from `npx astroadmin hash-password`) and
`SESSION_SECRET`. Production mode turns on secure cookies and login rate
limiting, and in production AstroAdmin prints a warning at startup if it runs
with weak auth settings. Secure cookies need the app to know the connection
is HTTPS: a TLS proxy on the same machine (nginx on `127.0.0.1`) is trusted
by default, and one on another machine or container must be named in
`TRUST_PROXY`, or sign-in fails (see
[trusted proxies](docs/configuration.md#trusted-proxies)). Over plain HTTP
a production server refuses a correct password with a message saying
sign-in needs HTTPS, so test without `NODE_ENV=production` on your own
machine.

## Requirements

- Bun
- Astro 6 or later, with `astro.config.mjs` or `astro.config.ts` (tested on
  Astro 7; `CmsImage` needs Astro 7, see [optimised images](docs/optimised-images.md))
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

Saves change files only; nothing is committed until someone presses Publish
(the startup line "Git: manual commits"). The machine running AstroAdmin needs
a git author (`git config user.name` and `user.email` in the site repository)
and push access to `origin`.

Publish commits the configured paths (`src/content/`, styles and images, set
by `config.git.paths`), brings in anything pushed to the repository since,
and pushes. If someone else changed the same content, nothing is published
and the editor is told to ask for the two to be combined. A host that builds
on push, such as Netlify, Cloudflare Pages or GitHub Pages via Actions, then
rebuilds the site.

Before pushing, AstroAdmin builds that exact commit with the site's own
installed Astro. If the build fails, the commit stays local and the editor is
told why in plain terms: the kind of error and, where it can be confirmed, the
entry and field to fix. Astro's full output goes to the server log. Content
your schema rejects never reaches the host.
See [the pre-push build check](./docs/configuration.md#the-pre-push-build-check).

Images picked for an `image()` field are stored in
`src/content/assets/images`, which the default `config.git.paths` includes.
If you set `git.paths` yourself, keep `src/content/` in it.

Without a build-on-push host, a [deploy adapter](./docs/deploy-adapters.md)
(rsync is the only one so far) builds and deploys from the machine running
AstroAdmin. `GIT_ENABLED=false` turns git off for adapter-only setups.

An `.mdx` body can import modules and run JavaScript during the publish
build, so anyone who can save an MDX entry can run code on the server. Give
MDX editing only to people you would trust with the site's code.

## Astro integration (optional)

The integration does two things in development, and never in a production
build: it injects the click-to-edit script into the preview, and it adds a
`/component-preview/` route for collections that are not pages.

```javascript
// astro.config.mjs
import { defineConfig } from 'astro/config';
import astroadmin from 'astroadmin/integration';

export default defineConfig({
  integrations: [astroadmin()],
});
```

In the preview AstroAdmin runs (`astroadmin dev`, or the hosted preview, both
of which set `ASTROADMIN_PROJECT_ROOT` to the site) it also hides Astro's dev
toolbar. Your own `astro dev` keeps it, and `astroadmin({ devToolbar: true })`
keeps it in the preview too.

A collection such as `team` has no URL of its own. If a block lists its
entries (a `team` block with `teamIds: z.array(z.string())`, or
`z.array(reference('team'))`), editing a team member previews it inside
`src/components/blocks/TeamBlock.astro` (or `Team.astro`), which receives the
block as a `block` prop and its fields as props. Otherwise, point the collection at a page that shows
it:

```javascript
// astroadmin.config.js
export default {
  preview: { routes: { team: '/about' } },
};
```

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
[requirements](./docs/requirements.md), [blocks](./docs/blocks.md),
[optimised images](./docs/optimised-images.md), [videos](./docs/videos.md)
and [doctor](./docs/doctor.md).

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
