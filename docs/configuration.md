# Configuration

AstroAdmin needs no configuration to run locally. To change its behaviour,
create `astroadmin.config.js` in the project root with a default export.
Only that file name is read (not `.mjs` or `.ts`), and a file that fails to
load stops AstroAdmin rather than falling back to defaults. Environment
variables are listed [at the end](#environment-variables); where both are
set, the config file wins unless noted.

```javascript
// astroadmin.config.js
export default {
  preview: {
    url: 'http://localhost:4321',
    routes: { team: '/' },
  },
  publicUrl: 'https://example.com',
  collectionOrder: ['home', 'pages'],
  auth: {
    username: process.env.ADMIN_USERNAME,
    passwordHash: process.env.ADMIN_PASSWORD_HASH,
  },
};
```

The config is plain JavaScript, so it can read `process.env`. Bun loads a
`.env` file from the directory you run the command in.

## Preview

`preview.url` is the address the editor's preview frame loads: the site's
Astro dev server as the browser reaches it. It defaults to
`http://localhost:4321` (`http://localhost:4322` when `NODE_ENV=production`)
and can also be set with `PREVIEW_URL`. `astroadmin dev` starts Astro on
that URL's port; set the port with `PREVIEW_URL`, or start Astro yourself and
pass `--no-astro`. A path on the URL is treated as the site's `base`.

Each entry is previewed at a page of the site:

- a `pages` entry at `/<slug>`, and `pages/home` at `/`;
- an entry of a collection with a route in `preview.routes`, where `{slug}`
  is replaced by the entry's slug;
- otherwise at a route detected from a dynamic page such as
  `src/pages/blog/[slug].astro` (matched to a collection by the folder or
  parameter name, singular or plural);
- otherwise, for a collection that a block refers to, in that block's
  [component preview](./blocks.md#previewing-a-collection-that-blocks-use).

```javascript
export default {
  preview: {
    routes: {
      site: '/',
      services: '/',
      posts: '/blog/{slug}',
    },
  },
};
```

A collection with none of these shows a message in the preview panel
explaining what to set.

## Live site link

`publicUrl` (env `PUBLIC_URL`) is the production site's address. When it is
set, the editor header has a "View live site" link to the page being edited,
and after a publish the editor polls that page until its HTML changes, to
report when the change is live. A path on `publicUrl` is treated as the
site's base path. The link never points outside `publicUrl`'s origin.

## Entry picker order

`collectionOrder` lists collections to show first in the entry picker; the
rest follow in their natural order. The default is `['pages']`. When two
collections preview at the same page, the one listed first is selected when
an editor navigates to that page in the preview.

## Authentication

The default login is `admin` / `admin`. For anything reachable by others,
set a username, an argon2 password hash and a session secret:

```bash
npx astroadmin hash-password
```

asks for a password (or reads one piped in) and prints its hash. Then, for
example in
`.env`:

```bash
ADMIN_USERNAME=editor
ADMIN_PASSWORD_HASH='$argon2id$...'
SESSION_SECRET=a-long-random-string
```

`ADMIN_PASSWORD` sets a plain-text password and is meant for local use only.
At startup in production AstroAdmin warns about default credentials, a
plain-text-only password or the default session secret.

Run a public instance with `NODE_ENV=production`. That turns on secure
(HTTPS-only) session cookies, sessions stored in SQLite at
`SESSION_DB_PATH` (default `/data/sessions.db`) and rate limiting on the API.
In development, sessions are kept in memory and there is no rate limit.

Every request that changes something (saves, uploads, git actions, publish,
login, logout) must come from the editor's own origin; others get a 403.
Behind a proxy that does not pass the original `Host` header, list the public
editor address in `ALLOWED_ORIGINS`.

## Git and publishing

Publish runs these steps, in order:

1. `git pull --rebase` (skipped quietly if it fails, for example with no
   remote);
2. stage and commit the paths in `git.paths`;
3. build the resulting commit with the site's Astro (the pre-push check,
   below);
4. push that commit to the current branch's upstream;
5. if a [deploy adapter](./deploy-adapters.md) is configured, build the site
   and deploy it.

```javascript
export default {
  git: {
    enabled: true,
    paths: ['src/content/', 'src/styles/', 'public/images/'],
    autoPush: false,
  },
};
```

`git.paths` defaults to the three paths shown. Changes outside them are never
committed by AstroAdmin, so a content collection kept elsewhere needs its
folder added here. `paths: []` stages nothing. `git.enabled: false` (or
`GIT_ENABLED=false`) hides the editor's changes panel and leaves Publish to
the deploy adapter alone. `git.autoPush` (or `GIT_AUTO_PUSH=true`) makes a
commit from the changes panel push too; Publish always pushes.

### The pre-push build check

Before pushing, Publish builds exactly the commit it is about to push, in a
temporary git worktree. If the build fails, nothing is pushed: the commit
stays local and the editor shows Astro's error. This stops content the
schema rejects from reaching the host.

The check runs `build.check` if set, else `build.production`, else the site's
own installed Astro (`astro build`, under Bun with automatic installs turned
off). It times out after `build.checkTimeoutMs` (default 300000, five
minutes).

```javascript
export default {
  build: {
    production: 'bun --no-install --bun node_modules/.bin/astro build --outDir dist',
    checkTimeoutMs: 300000,
  },
};
```

Commands are `/bin/sh` command lines run in the site's directory (the check
runs in its worktree). Keep `--no-install`: without it Bun may fetch an Astro
from the registry instead of using the installed one. The deploy adapter
uploads `dist/`, so `build.production` must write there. The check's
worktree gets the site's `node_modules` linked in (without Astro's and Vite's
caches) and the site's gitignored `.env*` files copied in. AstroAdmin's own
variables (`ASTROADMIN_*`, `ADMIN_*`, `SESSION_SECRET`) are removed from its
environment. Sites that use git submodules, or workspace packages linked back
into the same repository, are refused, because the worktree cannot reproduce
them; `npx astroadmin doctor` reports both.

An `.mdx` body can import modules and run code during this build, so anyone
who can save an MDX entry can run code on the machine running AstroAdmin.

## Doctor in the editor

After each publish whose check passes, the editor scans the check's build for
click-to-edit problems and shows a notice if it finds any (see
[doctor](./doctor.md#in-the-editor)). Turn this off with:

```javascript
export default {
  doctor: { enabled: false },
};
```

## Translations

```javascript
export default {
  i18n: {
    enabled: true,
    defaultLocale: 'en',
    locales: ['en', 'fr'],
  },
};
```

With `i18n.enabled`, a file whose name ends in a locale (`about.fr.md`) is
the translation of the entry `about`, and the editor offers a locale switch.

## Content store

Content is stored as files by default (`content.store: 'files'`), which is
what this documentation describes. The older SQLite store
(`content.store: 'db'`, env `ASTROADMIN_CONTENT_STORE=db`) is not under
active development; see the README.

## Environment variables

| Variable | Sets | Default |
|---|---|---|
| `ASTROADMIN_PORT`, `PORT` | Editor port (`--port` wins) | `4000`, or the next free port |
| `ASTROADMIN_HOST`, `HOST` | Address to bind (`--host` wins) | `localhost` |
| `NODE_ENV` | `production` for a public instance (see [authentication](#authentication)) | `development` |
| `ADMIN_USERNAME` | Login name | `admin` |
| `ADMIN_PASSWORD_HASH` | argon2 hash from `hash-password` | unset |
| `ADMIN_PASSWORD` | Plain-text password, local use only | `admin` |
| `SESSION_SECRET` | Session signing secret | a development value |
| `SESSION_DB_PATH` | Session database in production | `/data/sessions.db` |
| `ALLOWED_ORIGINS` | Extra origins allowed to make changes, comma separated | unset |
| `PREVIEW_URL` | `preview.url` | `http://localhost:4321` |
| `PUBLIC_URL` | `publicUrl` | unset |
| `GIT_ENABLED` | `false` turns git off | `true` |
| `GIT_AUTO_PUSH` | `true` pushes after a commit from the changes panel | `false` |
| `DEBUG` | Print stack traces on CLI errors | unset |

`--project` sets `ASTROADMIN_PROJECT_ROOT` for you.
