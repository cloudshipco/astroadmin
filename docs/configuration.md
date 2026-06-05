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
    username: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin',
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

### Authentication

Configure admin login credentials:

```javascript
export default {
  auth: {
    username: 'admin',
    password: 'admin',
  },
};
```

**Security note:** Change the default credentials in production!

### Using Environment Variables

```javascript
export default {
  auth: {
    username: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin',
  },
};
```

Then set in `.env`:

```bash
ADMIN_USER=myuser
ADMIN_PASSWORD=securepassword
```

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
| `ADMIN_USER` | Login username | `admin` |
| `ADMIN_PASSWORD` | Login password | `admin` |
| `ASTROADMIN_PROJECT_ROOT` | Project path | Current directory |
| `ASTROADMIN_DB` | Content store (SQLite) path | `<project>/.astroadmin/content.db` |
| `GIT_ENABLED` | Enable git integration | `true` (`false` to disable) |
| `DEBUG` | Show stack traces | `false` |

## Image Upload Directory

Images are uploaded to `public/images/` by default. Ensure this directory exists:

```bash
mkdir -p public/images
```

## Database (content store)

Content is stored in a SQLite database, not in `src/content` files. By default
it lives at `<project>/.astroadmin/content.db` (created automatically). Override
the location with the `ASTROADMIN_DB` environment variable or config:

```javascript
export default {
  database: {
    path: process.env.ASTROADMIN_DB, // defaults to .astroadmin/content.db
  },
};
```

Add `.astroadmin/` and `content.db*` to `.gitignore` (the default project
template already does). Your site reads this store at build time via the
`astroadmin/loader` content-layer loader — see the README.

## Git Integration

Git is **optional** — content lives in the database, so publishing does not
require it. Publishing is build + deploy (via a [deploy adapter](./deploy-adapters.md)),
with git as an optional pre-step.

```javascript
export default {
  git: {
    enabled: true,                          // or GIT_ENABLED=false to disable
    autoPush: false,
    paths: ['src/styles/', 'public/images/'], // staged on publish (never src/content)
    includeDb: false,                       // commit the binary content.db too
  },
};
```

When git is disabled, the admin hides the git "Changes" panel and the
`/api/git/*` routes are not mounted; publishing still works via `/api/publish`.
When enabled, publishing commits the configured `paths` (never `src/content`,
and never the binary DB unless `includeDb` is true).

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
    username: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin',
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
