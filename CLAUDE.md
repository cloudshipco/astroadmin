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
