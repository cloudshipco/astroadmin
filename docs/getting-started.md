# Getting Started

This guide walks you through setting up AstroAdmin for your Astro project.

## Prerequisites

Before installing AstroAdmin, ensure you have:

- [ ] **Node.js 18+** - Check with `node --version`
- [ ] **An Astro project** - With `astro.config.mjs` or `astro.config.ts`
- [ ] **Content Collections** - Set up in `src/content/config.ts`

If you don't have Content Collections yet, see [Setting Up Content Collections](./content-collections.md).

## Installation

```bash
npm install astroadmin
```

Or use it directly with npx (no install needed):

```bash
npx astroadmin dev
```

## Running AstroAdmin

From your Astro project root:

```bash
npx astroadmin dev
```

The server will start and print the URL:

```
📁 Project root: /path/to/your-astro-site

🔧 AstroAdmin Configuration:
==================================================
   Preview URL: http://localhost:4321
   Auth: Enabled (admin/admin)
==================================================

🚀 AstroAdmin running at http://localhost:54321
```

## Logging In

Open the URL in your browser. The default credentials are:

- **Username:** `admin`
- **Password:** `admin`

See [Configuration](./configuration.md) to change the credentials.

## Using the Admin Interface

1. **Select a page** from the dropdown in the top bar
2. **Edit fields** in the left panel - changes auto-save
3. **Preview changes** in the right panel (requires Astro dev server running)
4. **Commit changes** using the Git button (if enabled)

## Running with Astro Dev Server

For live preview, run the Astro dev server alongside AstroAdmin:

```bash
# Terminal 1 - Astro dev server
npm run dev

# Terminal 2 - AstroAdmin
npx astroadmin dev
```

The preview iframe will load your Astro site at `http://localhost:4321` by default.

## CLI Options

```bash
npx astroadmin dev [options]

Options:
  -p, --port <port>     Port to run on (default: auto-select)
  -H, --host <host>     Host to bind to (default: localhost)
  --project <path>      Astro project path (default: current directory)
```

## Troubleshooting

### "Invalid Astro project" error

This means AstroAdmin couldn't find the required project structure. Check:

1. You're running from your Astro project root (where `astro.config.mjs` is)
2. You have a `src/content/` directory
3. You have a `src/content/config.ts` file

### Preview not loading

1. Make sure your Astro dev server is running (`npm run dev`)
2. Check the preview URL in [Configuration](./configuration.md)
3. Look for CORS or iframe errors in the browser console

### Changes not saving

1. Check the browser console for errors
2. Ensure the content files are writable
3. Try refreshing the page

## Next Steps

- [Requirements](./requirements.md) - Full list of requirements
- [Content Collections](./content-collections.md) - Schema setup guide
- [Configuration](./configuration.md) - Customize AstroAdmin
