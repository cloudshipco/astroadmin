# AstroAdmin Development Guidelines

## Architecture Principles

### Site Agnosticism

**AstroAdmin must be completely site-agnostic.** This means:

1. **Never add site-specific styles to AstroAdmin** - The admin UI has its own styles (in `ui/input.css`), but when rendering site content (like component previews), we must use the site's own styles, not bundle our own.

2. **Component preview uses site styles** - The `integration/preview-route.astro` imports styles from the site (e.g., `/src/styles/global.css`) so that previewed components look exactly as they will on the live site.

3. **No assumptions about site structure** - Use conventions and auto-discovery (like `import.meta.glob`) rather than hardcoding paths or component names.

4. **Configuration over convention where needed** - Allow sites to override auto-detected behavior via `astroadmin.config.js`.

### Two Distinct Style Domains

- **AstroAdmin UI** (`ui/*.css`) - Styles for the admin dashboard, modals, forms, etc.
- **Site Content Preview** - Must use the site's own CSS, loaded dynamically via the Astro integration

## Testing

Tests are standalone scripts under `tests/`, run individually (there is no test
runner aggregating them). Most run server-less and need env vars:

- `bun tests/content-files.test.js` — files store. Needs `ASTROADMIN_PROJECT_ROOT=<tmp>`.
- `bun tests/content-store.test.js` — SQLite store. Self-pins `ASTROADMIN_CONTENT_STORE=db`;
  pass `ASTROADMIN_DB=<tmp.db> ASTROADMIN_PROJECT_ROOT=<tmp>`.
- `bun tests/export-files.test.js`, `tests/import-files.test.js`, `tests/schema-parser-db.test.js` —
  build their own throwaway project (symlink `node_modules` for zod); just `bun tests/<x>.test.js`.
- `bun tests/loader.test.js` — DB loader; self-pins db mode; pass `ASTROADMIN_DB` + `ASTROADMIN_PROJECT_ROOT`.
- `bun tests/auth.test.js` — auth helpers (needs Bun for `Bun.password`).

**Storage modes:** the content store is selected by `config.content.store`
(`files` default | `db`), env `ASTROADMIN_CONTENT_STORE`. Tests that exercise the
DB store **must pin db mode** (a `process.env.ASTROADMIN_CONTENT_STORE = 'db'` line
before imports), since `files` is now the default.

**Caveat:** `npm test` / the `test` script only runs `tests/api.test.js`, which
needs a **running server** and is currently red (tracked as issue #2). Don't read
that single red as the suite being broken — run the server-less tests above.
