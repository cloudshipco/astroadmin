# AstroAdmin

Admin interface for [Astro Content Collections](https://docs.astro.build/en/guides/content-collections/). Auto-generates forms from your Zod schemas.

## Features

- **Schema-driven forms** - Auto-generates fields from `src/content/config.ts`
- **Block editor** - Visual editing for discriminated unions (page builders)
- **Live preview** - See changes in real-time via iframe
- **Image uploads** - Upload and manage images with alt text
- **Git integration** - Commit changes directly from the admin
- **Collection management** - Create and delete entries

## Requirements

Before using AstroAdmin, ensure your project has:

- [ ] **Node.js 18+**
- [ ] **Astro 4.0+** with `astro.config.mjs` or `astro.config.ts`
- [ ] **Content Collections** set up in `src/content/config.ts`

```
your-astro-site/
├── astro.config.mjs       ← Required
├── src/
│   └── content/
│       ├── config.ts      ← Required (collection schemas)
│       └── pages/         ← Your collections
│           └── home.md
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

This automatically starts both AstroAdmin and the Astro dev server. The URLs will be printed when ready. Default credentials: `admin` / `admin`

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

## Configuration (optional)

Create `astroadmin.config.js` in your project root:

```javascript
export default {
  preview: {
    url: 'http://localhost:4321', // Astro dev server
  },
  auth: {
    username: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin',
  },
};
```

## Troubleshooting

### "Invalid Astro project" error

This means AstroAdmin couldn't find the required files:

1. **Run from project root** - Where `astro.config.mjs` is located
2. **Set up Content Collections** - Create `src/content/config.ts`

```bash
# Quick fix
mkdir -p src/content
touch src/content/config.ts
```

See [Requirements](./docs/requirements.md) for details.

### Preview not loading

1. AstroAdmin should auto-start Astro - check for `[astro]` prefixed output
2. If using `--no-astro`, ensure your Astro dev server is running on port 4321
3. Check the preview URL in your config matches the Astro server

## How it works

1. Parses your `src/content/config.ts` using esbuild
2. Converts Zod schemas to JSON Schema via `zod-to-json-schema`
3. Auto-generates form fields from the schema
4. Detects discriminated unions for block-based editing
5. Saves changes to markdown/JSON files in `src/content/`

## License

MIT
