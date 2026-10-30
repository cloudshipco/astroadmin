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
that URL's port. A URL on another host, or one with no port, starts Astro on
4321 with a warning; for those, start Astro yourself and pass `--no-astro`.
A path on the URL is treated as the site's `base`.

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
The limit is per 15 minutes: 100 requests per address for anyone not signed
in and for every login attempt, 10 failed logins per address (a successful
login does not count), and 3,000 per signed-in session, which continuous
autosaving stays well under. "Per address" means per IPv4 address, and per
IPv6 /56 network: one IPv6 client is usually given at least a /64, and could
otherwise move to a fresh address for every ten guesses. (An IPv4-mapped
address such as `::ffff:203.0.113.9` counts as `203.0.113.9`.) A refused
request gets a JSON 429 with `Retry-After`, and the editor says when to try
again. Each login starts a new
session, so a session ID from before the login is never the signed-in one.

Every failed login writes one line to standard output, in this fixed form:

```text
[2026-10-29T14:03:07.412+00:00] auth.failed ip=203.0.113.9
```

The time is local with its UTC offset. The address is the one Express sees:
the connecting address, or, when the connection comes from a trusted proxy
(below), the address that proxy put in `X-Forwarded-For`. It is the client's
own address, IPv6 included, not the /56 the rate limit counts it in, since
fail2ban bans single addresses; an IPv4-mapped address is written in its
IPv4 form. An address that does not parse is written as `ip=invalid`.
Nothing else the client sent, such as the username, is in the line, so a
request cannot forge a second line. The line is written after
the same-origin check, so another site cannot make a visitor's browser produce
it. A fail2ban filter for it (anchored at the end of the line, not the start,
because a journal or syslog prefix comes before the message):

```ini
[Definition]
failregex = \] auth\.failed ip=<ADDR>$
```

### Trusted proxies

The rate limits and the `auth.failed` line take the client's address from
`X-Forwarded-For` only when the connection comes from a trusted proxy;
otherwise any client could name its own address in that header, get a fresh
budget per request and point fail2ban at someone else. In production the
default trusts `loopback` only: a proxy on the same machine (nginx on
`127.0.0.1` or `::1`), which is the usual layout. A client that reaches the
editor's port directly is counted, and logged, by its own address. In
development nothing is trusted.

It also decides whether a request came over HTTPS (`X-Forwarded-Proto`):
production session cookies are HTTPS-only, so behind a TLS proxy on another
machine or container, sign-in fails until that proxy is listed in
`TRUST_PROXY`. AstroAdmin then answers a correct password with a message
saying so, and logs a warning naming `TRUST_PROXY` (at most once an hour).
Any other request that does not count as HTTPS (a production server reached
directly over plain HTTP, or a trusted proxy that forwards
`X-Forwarded-Proto: http`) gets a correct password answered with a message
saying sign-in needs HTTPS, instead of a sign-in whose cookie the browser
never receives. A wrong password is a 401 either way.

Set `TRUST_PROXY` (or `trustProxy` in `astroadmin.config.js`; the
environment wins) when the proxy is elsewhere. It takes Express's
[`trust proxy`](https://expressjs.com/en/guide/behind-proxies.html) forms:
a comma-separated list of addresses, CIDR ranges and the names `loopback`,
`linklocal` and `uniquelocal` (`TRUST_PROXY=10.0.0.5` for a proxy on another
machine); a number of hops (`1`), which believes whatever the nearest peer
says and so suits only an app no client can reach except through that
proxy; `true` (believe every peer and take the first address in the
header, which the client wrote unless the proxy replaces the header rather
than appending to it: safe only behind a proxy that overwrites
`X-Forwarded-For`); or `false`.

With a CDN such as Cloudflare in front of nginx, nginx's peer is the CDN's
edge, so every visitor arrives from a handful of edge addresses and shares
their budgets, and fail2ban would ban the edge. Have nginx restore the
visitor's address first (its `real_ip` module: `set_real_ip_from` for each
of the CDN's published ranges and `real_ip_header CF-Connecting-IP`), so the
`X-Forwarded-For` nginx passes on names the visitor, and leave `TRUST_PROXY`
at `loopback`.

Every request that changes something (saves, uploads, git actions, publish,
login, logout) must come from the editor's own origin; others get a 403.
Behind a proxy that does not pass the original `Host` header, list the public
editor address in `ALLOWED_ORIGINS`.

## Git and publishing

Publish runs these steps, in order:

1. stage and commit the paths in `git.paths`;
2. fetch the branch's upstream and rebase the commit onto what has been
   pushed to the site repo since (skipped when the branch has no upstream;
   a fetch that fails is logged, and a push onto a remote that moved on is
   then refused and reported). The rebase runs in a throwaway worktree, and
   the checkout is then moved to the result with `git reset --keep`, so
   changes someone made on the server outside the editor, in files the
   incoming commits do not touch, neither stop the publish nor are lost. If
   someone else changed the same content, the rebase is undone and the
   editor is told the changes were committed but not published; someone
   with access to the checkout combines the two. If an incoming change
   touches a file that has uncommitted changes on the server, or an
   untracked file is in its way, nothing in the checkout moves and the
   publish is refused (409) with the commit kept local: someone with access
   to the checkout sorts those files out, then publishes again. When the
   upstream has moved on, a file someone staged (`git add`) and then
   changed again, wherever it is, refuses the publish like an uncommitted
   change in the way (409, the commit kept local), since moving the
   checkout would drop the staged version. If the
   checkout is already in the middle of a rebase or merge (someone left one
   unfinished on the server), publishing is refused before anything is
   committed, and the editor's saves stay as they are. A commit someone
   force-pushed away upstream is not brought back. A repository where any
   file, anywhere, goes through a git filter (Git LFS or another) is
   refused, even outside the site's folder (for example a Git LFS folder
   elsewhere in a monorepo). The refusal comes before
   anything is committed: AstroAdmin runs git with every filter switched
   off, so it would commit those files' raw bytes;
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

`git.allowLocalRemote` (default false) allows fetching from and pushing to a
remote that is a local path or a `file://` URL. It is off because git runs such
a repository's own hooks on this host; turn it on only for a remote you
control. A repository whose index holds a submodule is refused.

`git.paths` defaults to the three paths shown. Changes outside them are never
committed by AstroAdmin, so a content collection kept elsewhere needs its
folder added here. Images for `image()` fields are stored in
`src/content/assets/images/`, so a custom list needs `src/content/` or that
folder. `paths: []` stages nothing. `git.enabled: false` (or
`GIT_ENABLED=false`) hides the editor's changes panel and leaves Publish to
the deploy adapter alone. `git.autoPush` (or `GIT_AUTO_PUSH=true`) makes a
commit from the changes panel push too; Publish always pushes.

### Push credentials

AstroAdmin runs git with the repository's hooks, filters, merge drivers,
credential helpers and `core.sshCommand` switched off, because the site's own
code (its build, its integrations) can write `.git/config`. So the push takes
its credentials only from the environment the admin is started with:

- an SSH remote uses `ssh` from the admin's `PATH`, with the admin user's
  `~/.ssh/config` and ssh agent, or `GIT_SSH_COMMAND` when it is set (for
  example `ssh -i /path/to/deploy-key -o IdentitiesOnly=yes -o
  BatchMode=yes`). `GIT_SSH` is not used;
- an HTTPS remote takes its credentials from `GIT_ASKPASS` (a program that
  prints the token) or from the remote URL itself. A credential helper in
  git's config (osxkeychain, the GitHub CLI's helper) is not used.

git itself never prompts (`GIT_TERMINAL_PROMPT=0`), so an HTTPS push with no
credentials fails at once instead of waiting. That does not stop `ssh`
asking for a passphrase or a host key on a terminal when the admin runs in
one: add `-o BatchMode=yes` to `GIT_SSH_COMMAND` so it fails instead.

`GIT_AUTHOR_NAME`/`EMAIL` and `GIT_COMMITTER_NAME`/`EMAIL`, when set, name the
commits; otherwise the repository's `user.name` and `user.email` do.

### The pre-push build check

Before pushing, Publish builds exactly the commit it is about to push, in a
temporary git worktree. If the build fails, nothing is pushed: the commit
stays local. The editor is told the kind of error in a plain sentence (an
entry that does not match its schema, a missing image file, invalid YAML or
MDX), and for each entry that can be confirmed from the commit, which fields
are wrong and what values are accepted. Astro's own output, which can name
server paths, goes to the server log only. This stops content the schema
rejects from reaching the host.

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
uploads `dist/`, so `build.production` must write there. A build or a local
deploy must not change committed files in the site (only ignored output such
as `dist/`, and a deploy destination outside the site's folder): AstroAdmin
does not stop it running while a publish is committing. The check's
worktree gets the site's `node_modules` linked in (without Astro's and Vite's
caches) and the site's gitignored `.env*` files copied in. AstroAdmin's own
variables (`ASTROADMIN_*`, `ADMIN_*`, `SESSION_SECRET`) are removed from its
environment, and from the production build's before a deploy. That build
times out after `build.productionTimeoutMs` (default 300000, five minutes);
on a timeout its whole process group is stopped and nothing is deployed. Sites that use git submodules, or workspace packages linked back
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
| `TRUST_PROXY` | Peers whose `X-Forwarded-For` is believed (see [trusted proxies](#trusted-proxies)) | `loopback` in production, none in development |
| `PREVIEW_URL` | `preview.url` | `http://localhost:4321` |
| `PUBLIC_URL` | `publicUrl` | unset |
| `GIT_ENABLED` | `false` turns git off | `true` |
| `GIT_AUTO_PUSH` | `true` pushes after a commit from the changes panel | `false` |
| `DEBUG` | Print stack traces on CLI errors | unset |

`--project` sets `ASTROADMIN_PROJECT_ROOT` for you.
