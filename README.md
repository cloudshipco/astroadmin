# AstroAdmin

Admin interface for Astro Content Collections. Auto-generates forms from your Zod schemas.

## Features

- **Auto-detects schemas** from `src/content/config.ts`
- **Block editor** for discriminated unions
- **Live preview** via iframe (Astro dev server)
- **Git integration** for commits
- **Image uploads**

## Installation

```bash
npm install astroadmin
```

## Usage

```bash
# Start admin server (from your Astro project root)
npx astroadmin dev

# Or with options
npx astroadmin dev --port 3030 --project ./my-astro-site
```

Then visit http://localhost:3030

## Requirements

- Astro 4.0+
- Content Collections with Zod schemas in `src/content/config.ts`

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

## How it works

1. Parses your `src/content/config.ts` using esbuild
2. Converts Zod schemas to JSON Schema via `zod-to-json-schema`
3. Auto-generates form fields from the schema
4. Detects discriminated unions for block-based editing
5. Saves changes to markdown/JSON files in `src/content/`

## License

MIT
