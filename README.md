# AstroAdmin

Admin interface for [Astro Content Collections](https://docs.astro.build/en/guides/content-collections/). Auto-generates forms from your Zod schemas.

![AstroAdmin Screenshot](design/astroadmin-example.png)

## Features

- **Schema-driven forms** - Auto-generates fields from `src/content.config.ts`
- **Files + git as the source of truth** - Content lives in your repo as markdown/JSON; your site reads it through Astro's native `glob()`/`file()` loaders
- **Block editor** - Visual editing for discriminated unions (page builders)
- **Live preview** - See changes in real-time via iframe
- **Image uploads** - Upload and manage images with alt text
- **Publish = commit + push** - Pair with a build-on-push host (Netlify, Cloudflare Pages) and publishing is a git push; optional deploy adapters (rsync) for self-hosting
- **Collection management** - Create and delete entries

## Requirements

Before using AstroAdmin, ensure your project has:

- **Bun** - AstroAdmin runs on Bun
- **Astro** with `astro.config.mjs` or `astro.config.ts`
- **Content Collections** schemas in `src/content.config.ts`

Content is stored as files in your repo — markdown with frontmatter for
`content` collections, JSON for `data`/`file()` collections — exactly where
your Astro loaders read them:

```
your-astro-site/
├── astro.config.mjs        ← Required
└── src/
    ├── content.config.ts   ← Required (collection schemas)
    └── content/
        ├── pages/          ← Example glob() collection
        │   ├── home.md
        │   └── about.md
        └── team.json       ← Example file() collection
```

**Don't have Content Collections?** See the [setup guide](./docs/content-collections.md).

## Usage

```bash
# Start admin server (from your Astro project root)
npx astroadmin dev

# With options
npx astroadmin dev --port 3030 --project ./my-astro-site

# If you manage Astro dev server separately
npx astroadmin dev --no-astro
```

This automatically starts both AstroAdmin and the Astro dev server. The URLs will be printed when ready.

Default credentials are `admin` / `admin` — for anything internet-facing, set
`ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` (generate the argon2 hash with
`npx astroadmin hash-password`) plus a real `SESSION_SECRET`. AstroAdmin warns
at startup if production runs with weak auth config.

## Documentation

- [Getting Started](./docs/getting-started.md) - Full setup guide
- [Requirements](./docs/requirements.md) - Detailed requirements
- [Content Collections](./docs/content-collections.md) - Schema setup guide
- [Configuration](./docs/configuration.md) - Customization options

## Astro Integration (optional)

For collections that aren't pages (e.g., testimonials, team members), AstroAdmin can preview them rendered inside their block components. Add the integration to your Astro config:

```javascript
// astro.config.mjs
import { defineConfig } from 'astro/config';
import astroadmin from 'astroadmin/integration';

export default defineConfig({
  integrations: [astroadmin()],
});
```

This injects a `/component-preview/` route during development that renders your block components with the item being edited. Without this integration, non-page collections will show a 404 in the preview iframe.

**Requirements:**
- Block components in `src/components/blocks/` following the naming convention `{BlockType}Block.astro` (e.g., `TestimonialsBlock.astro`)
- Fields referencing collections should use the naming convention `{collection}Ids` (e.g., `testimonialIds`)

## Publishing

In the default files mode, content edits are ordinary file changes in your
repo. Publishing commits the configured paths (`src/content/`, styles, images
— `config.git.paths`) and pushes; a build-on-push host (Netlify, Cloudflare
Pages, GitHub Pages via Actions) rebuilds the site from git. The host is your
build sandbox, CDN, and rollback story.

No build-on-push host? Configure a [deploy adapter](./docs/deploy-adapters.md)
(rsync today) and publishing becomes commit → build → deploy from the machine
running AstroAdmin. Git can be disabled entirely (`GIT_ENABLED=false`) for
deploy-adapter-only setups.

## SQLite content store (optional, shelved)

AstroAdmin also ships an alternative storage backend where content lives in a
SQLite database (`.astroadmin/content.db`) and the site reads it at build time
via the `astroadmin/loader` content-layer loader (Astro 6+, build under Bun).
It is **not the default and not the current direction** — it is preserved
behind `content.store = 'db'` (env `ASTROADMIN_CONTENT_STORE=db`) for a future
hosted/multi-tenant phase.

Migrating a db-mode site back to files: switch `src/content.config.ts` from
`astroadminLoader` to the target `glob()`/`file()` loaders **first**, then run
`npx astroadmin export` — it reads the parsed loaders to write every DB entry
to the right path (and the right extension), preserving frontmatter/body,
locales, and `file()` array order.

## Configuration (optional)

Create `astroadmin.config.js` in your project root:

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

See [Configuration](./docs/configuration.md) for the full reference.

## Troubleshooting

### "Invalid Astro project" error

This means AstroAdmin couldn't find the required files:

1. **Run from project root** - Where `astro.config.mjs` is located
2. **Set up Content Collections** - Create `src/content.config.ts`

See [Requirements](./docs/requirements.md) for details.

### Preview not loading

1. AstroAdmin should auto-start Astro - check for `[astro]` prefixed output
2. If using `--no-astro`, ensure your Astro dev server is running on port 4321
3. Check the preview URL in your config matches the Astro server

## How it works

1. Parses your `src/content.config.ts` using esbuild
2. Converts Zod schemas to JSON Schema via `zod-to-json-schema`
3. Auto-generates form fields from the schema
4. Detects discriminated unions for block-based editing
5. Saves changes to the content files in `src/content/` (or the loader's
   declared `base`/`file()` path), atomically
6. Your site reads those files natively via its `glob()`/`file()` loaders;
   publishing commits + pushes them

## License

MIT
