# Configuration

AstroAdmin works out of the box with sensible defaults. This guide covers customization options.

## Configuration File

Create `astroadmin.config.js` in your Astro project root:

```javascript
export default {
  preview: {
    url: 'http://localhost:4321',
  },
  auth: {
    username: process.env.ADMIN_USERNAME || 'admin',
    passwordHash: process.env.ADMIN_PASSWORD_HASH,
  },
};
```

## Options Reference

### Preview

Configure the live preview iframe:

```javascript
export default {
  preview: {
    // Astro dev server URL
    url: 'http://localhost:4321',
  },
};
```

The preview panel loads your Astro site in an iframe. Make sure your Astro dev server is running.

### Public site URL (live-status)

Optionally set your production site's origin. When set, the editor shows a
"View live site" link and, after a Publish, polls the production URL to report
when your change is actually live — handy with build-on-push hosts (Netlify,
Cloudflare Pages) where a deploy lags the push by a short while:

```javascript
export default {
  // Production site origin, e.g. https://example.com
  publicUrl: 'https://example.com',
};
```

Also settable via the `PUBLIC_URL` environment variable. Leave it unset to
disable the live-status check (the editor falls back to a "live shortly"
message). Backed by a server-side `GET /api/publish/live-status` endpoint, so
there's no browser cross-origin issue.

### Authentication

Configure admin login credentials. For anything internet-facing, prefer an
argon2 password **hash** over a plaintext password:

```bash
npx astroadmin hash-password   # prints a hash to set as ADMIN_PASSWORD_HASH
```

```javascript
export default {
  auth: {
    username: process.env.ADMIN_USERNAME || 'admin',
    passwordHash: process.env.ADMIN_PASSWORD_HASH, // preferred
    // password: process.env.ADMIN_PASSWORD,       // plaintext fallback, local/dev only
  },
};
```

Then set in `.env`:

```bash
ADMIN_USERNAME=myuser
ADMIN_PASSWORD_HASH='$argon2id$...'
SESSION_SECRET=a-long-random-string
```

**Security note:** AstroAdmin warns at startup when production runs with the
default credentials, a plaintext-only password, or the default session secret.

## CLI Options

Override settings via command line:

```bash
# Custom port
npx astroadmin dev --port 3030

# Custom host (for network access)
npx astroadmin dev --host 0.0.0.0

# Different project directory
npx astroadmin dev --project ./my-astro-site
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ADMIN_USERNAME` | Login username | `admin` |
| `ADMIN_PASSWORD_HASH` | argon2 hash (via `astroadmin hash-password`) | unset |
| `ADMIN_PASSWORD` | Plaintext password (local/dev fallback) | `admin` |
| `SESSION_SECRET` | Session signing secret | dev-only default |
| `ASTROADMIN_PROJECT_ROOT` | Project path | Current directory |
| `PREVIEW_URL` | Browser-facing preview origin (iframe) | `http://localhost:4321` |
| `PUBLIC_URL` | Production site origin (enables the post-publish live-status check + View-site link) | unset |
| `ASTROADMIN_CONTENT_STORE` | Content store: `files` or `db` | `files` |
| `ASTROADMIN_DB` | SQLite path (db mode only) | `<project>/.astroadmin/content.db` |
| `GIT_ENABLED` | Enable git integration | `true` (`false` to disable) |
| `DEBUG` | Show stack traces | `false` |

## Image Upload Directory

Images are uploaded to `public/images/` by default. Ensure this directory exists:

```bash
mkdir -p public/images
```

## Content store

By default content is stored as **files** in your repo (`src/content/`, or
wherever your `glob()`/`file()` loaders point) — git is the source of truth and
your site reads the files natively. There is nothing to configure.

The shelved SQLite backend can be selected explicitly:

```javascript
export default {
  content: {
    store: 'db', // 'files' (default) | 'db'; env ASTROADMIN_CONTENT_STORE wins
  },
  database: {
    path: process.env.ASTROADMIN_DB, // db mode only; defaults to .astroadmin/content.db
  },
};
```

In db mode, add `.astroadmin/` and `content.db*` to `.gitignore`, and the site
reads the store at build time via the `astroadmin/loader` content-layer loader
— see the README. To migrate a db-mode site back to files, swap the loaders in
`src/content.config.ts` first, then run `npx astroadmin export`.

## Git Integration

In files mode, git **is the publish mechanism**: publishing commits the
configured paths — `src/content/` plus assets — and pushes, and a
build-on-push host (e.g. Netlify) rebuilds the site. A
[deploy adapter](./deploy-adapters.md) is optional for self-hosted setups.

```javascript
export default {
  git: {
    enabled: true,        // or GIT_ENABLED=false to disable
    autoPush: false,
    // Defaults are store-aware: files mode stages src/content/ + assets;
    // db mode stages assets only (src/content may hold stale files).
    paths: ['src/content/', 'src/styles/', 'public/images/'],
    includeDb: false,     // db mode: commit the binary content.db too
  },
};
```

When git is disabled, the admin hides the git "Changes" panel and the
`/api/git/*` routes are not mounted; publishing still works via `/api/publish`
with a deploy adapter. An explicitly-empty `paths: []` means "stage nothing".

## CORS and Preview

If the preview iframe doesn't load, you may have CORS issues. Ensure your Astro dev server allows iframe embedding.

For most setups, this works automatically. If you're using a reverse proxy or custom server, ensure the `X-Frame-Options` header allows embedding.

## Full Example

```javascript
// astroadmin.config.js
export default {
  // Preview configuration
  preview: {
    url: process.env.PREVIEW_URL || 'http://localhost:4321',
  },

  // Authentication
  auth: {
    username: process.env.ADMIN_USERNAME || 'admin',
    passwordHash: process.env.ADMIN_PASSWORD_HASH,
  },
};
```

## Troubleshooting

### Config file not loading

Ensure the file is named exactly `astroadmin.config.js` (not `.ts` or `.mjs`) and is in your Astro project root.

### Environment variables not working

- Check the `.env` file is in your project root
- Restart AstroAdmin after changing `.env`
- Use `process.env.VAR_NAME` syntax in the config

### Preview not updating

- Ensure Astro dev server is running
- Check the preview URL matches your Astro server
- Try clicking the refresh button in the preview panel

## Next Steps

- [Getting Started](./getting-started.md) - Run AstroAdmin
- [Content Collections](./content-collections.md) - Set up schemas
- [Deploy Adapters](./deploy-adapters.md) - Auto-deploy on publish
