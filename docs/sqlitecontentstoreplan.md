# AstroAdmin: SQLite content store + Astro 6 loader + deploy adapters

## Context

AstroAdmin (`/home/user/repo`, an Express+Bun headless CMS for Astro sites) currently stores
content as Markdown/JSON **files** in the site's `src/content/`, and "publishes" by
`git commit`-ing those files and running `astro build`. The user is building a real client
site on **Astro 6** and wants:

1. **Content stored in a database** (SQLite), not files — for a secure, hosted, transactional store.
2. The Astro site to read content **directly from the DB** via a custom **content-layer loader**
   that AstroAdmin ships (no file materialization). Astro **6-only** is acceptable (drop 4/5).
3. **Deploy** finished as a **pluggable adapter** (rsync first; Netlify/Cloudflare later), with
   **git made optional**.

Target architecture: a **NixOS host with one MicroVM per site**. AstroAdmin + `content.db` +
the Astro build are **co-located in each site's VM** (minimizes blast radius if AstroAdmin is
compromised). "Deploy" is primarily a **local rsync** of `dist/` into the VM's nginx web root
(no SSH); remote rsync / Netlify / Cloudflare are future adapters.

The storage seam is clean and contained: `server/utils/content.js` + the entry-listing in
`server/utils/collections.js` are the only places that touch content files. `bun:sqlite` is
already used (`server/session-store.js`), so no new dependency. The deploy hook is already
wired — `server/api/git.js` imports `deploy()`/`validateDeployConfig()` from a
`server/utils/deploy.js` that doesn't exist yet, and `config.deploy.rsync` already exists.

The single biggest risk: the loader runs in the **site's** Astro process and uses `bun:sqlite`,
so the **site build must run under Bun**. We control the build command, so we set it to run
under Bun (see Phase 6). Other Astro-6 API details to confirm during impl are listed at the end.

---

## Phase 0 — DB layer (`server/utils/db.js`, new)

Singleton wrapper mirroring `server/session-store.js` (`new Database(path,{create:true})`,
`PRAGMA journal_mode=WAL`). WAL matters: the site loader reads the file concurrently with
server writes. Creates `.astroadmin/` (recursive mkdir) on open. Separate file/instance from
sessions.db.

DDL:
```sql
CREATE TABLE IF NOT EXISTS entries (
  collection TEXT NOT NULL,
  slug       TEXT NOT NULL,              -- base slug, NO locale suffix
  locale     TEXT NOT NULL DEFAULT '',   -- '' = locale-less; NOT NULL so it can sit in the PK
  type       TEXT NOT NULL,              -- 'content' | 'data'
  data       TEXT NOT NULL,              -- JSON.stringify of frontmatter/data
  body       TEXT,                       -- markdown body; NULL for data entries
  position   INTEGER,                    -- preserves file()-loader array order; NULL for glob
  digest     TEXT,                       -- write-time hash; lets loader skip unchanged rows
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection, slug, locale)
);
CREATE INDEX IF NOT EXISTS idx_entries_collection ON entries(collection);
CREATE TABLE IF NOT EXISTS astroadmin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```
Map `null ⇄ ''` for locale at the db.js boundary so callers keep passing `null`.
Prepared statements: `get`, `upsert` (`ON CONFLICT(collection,slug,locale) DO UPDATE`),
`delete`, `exists`, `listSlugs`, `listLocales`, `maxPosition`, `countAll`, `distinctCollections`.
Export a `touchSentinel()` helper that writes `Date.now()` to `.astroadmin/.touch` (dev reload, Phase 3).

The `file()` vs `glob()` distinction (recorded by `schema-parser.js`) no longer affects storage —
both are rows. It survives only as two server-side behaviours: (a) for **file** collections, fold
`{...data, id: slug}` into stored `data` (parity with current `content.js`) and use `position`;
(b) **file** collections are always locale-less (`locale=''`). The loader ignores loaderType entirely.

## Phase 1 — Rewrite `server/utils/content.js` (DB-backed, identical signatures)

Preserve every export and return shape so `server/api/content.js` and `collections.js` dynamic
imports keep working (minimize blast radius):
- `readContent(collection, slug, locale=null)` → `{type, data, body, filePath, locale}`. Throw the
  same `Error('Content not found: ...')` on miss (API key-matches `'not found'`).
- `writeContent(collection, slug, {data, body, type}, locale=null)` → `{filePath, locale}`. Compute
  `digest`, set `position` for file collections via `maxPosition+1`, upsert, then `touchSentinel()`.
- `deleteContent(...)` → `{deleted, locale}` (throw not-found if 0 rows); `touchSentinel()`.
- `contentExists(...)` → boolean.
- `getAvailableLocales(collection, baseSlug, configuredLocales)` → one query intersected with config.

`filePath` has no file anymore — keep the key but return a synthetic locator
`db:${collection}/${slug}${locale?'.'+locale:''}` with a comment that it's a logical id.
Keep `getCollectionLoaderInfo()` (simplified — still reads `loadSchemas()` for loaderType/type,
no path math) and `sanitizePath` (defense-in-depth on slug/collection). Delete all file helpers
(`getContentPath`, `findExistingFile`, `*FileCollectionEntry`) and the `gray-matter` import.

## Phase 2 — Entry listing in `server/utils/collections.js`

Only `getCollectionEntries` + `getFileCollectionEntries` touch the FS for entries; everything
schema-based (`loadSchemas`, `getCollectionSchema`, `getAllCollections`, block maps) stays.
- `getCollectionEntries` → `SELECT DISTINCT slug FROM entries WHERE collection=? ORDER BY position, slug`.
  i18n dedup is now free (slug already excludes locale); the `{i18nEnabled, locales}` branch is dropped.
- Delete `getFileCollectionEntries`.
- `getCollectionType` FS fallback → `SELECT type ... LIMIT 1` (default `'content'`); schema path stays primary.
- `getCollectionNames` FS fallback → `SELECT DISTINCT collection FROM entries`; schema path stays primary.

## Phase 3 — `astroadmin/loader` (Astro 6 content-layer loader, `loader/index.js`, new)

Dependency-light (cannot import `server/`). Site uses it in `src/content.config.ts`:
```js
import { astroadminLoader } from 'astroadmin/loader';
const pages = defineCollection({ loader: astroadminLoader({ collection: 'pages' }), schema });
```
The site **still defines the Zod schema** — the loader ships none and relies on `parseData`, so the
same schema drives both AstroAdmin's forms (server) and read-time validation (site). DB path
resolution: explicit `{dbPath}` → `ASTROADMIN_DB` env → `new URL('.astroadmin/content.db', config.root)`.

Loader skeleton (verified against Astro 6 Content Loader API — `store.set`/`parseData`/
`renderMarkdown`/`watcher.on('change')`):
```js
import { Database } from 'bun:sqlite';
export function astroadminLoader({ collection, dbPath }) {
  if (!collection) throw new Error('astroadminLoader: `collection` is required');
  return {
    name: 'astroadmin-loader',
    async load({ store, parseData, generateDigest, renderMarkdown, watcher, logger, config }) {
      const path = dbPath || process.env.ASTROADMIN_DB
        || new URL('.astroadmin/content.db', config.root).pathname;
      async function sync() {
        let db; try { db = new Database(path, { readonly: true }); }
        catch (e) { logger.warn(`astroadmin: cannot open ${path}: ${e.message}`); return; }
        const rows = db.query(
          `SELECT slug, locale, type, data, body, digest FROM entries
             WHERE collection=? ORDER BY position, slug`).all(collection);
        store.clear();
        for (const row of rows) {
          const id = row.locale ? `${row.slug}/${row.locale}` : row.slug;   // unique per locale
          const data = await parseData({ id, data: JSON.parse(row.data) });
          const entry = { id, data, digest: row.digest || generateDigest(data) };
          if (row.type === 'content' && row.body != null) {
            entry.body = row.body;
            entry.rendered = await renderMarkdown(row.body);                 // enables entry.render()
          }
          store.set(entry);
        }
        db.close();
      }
      await sync();
      if (watcher) {                          // dev live-reload
        const sentinel = new URL('.astroadmin/.touch', config.root).pathname;
        watcher.add(sentinel); watcher.add(path);
        watcher.on('change', (p) => { if (p === sentinel || p === path) sync().catch(e => logger.error(e.message)); });
      }
    },
  };
}
```
Live-reload uses the **sentinel file** `.astroadmin/.touch` (server `touchSentinel()` on every
write/delete) because WAL writes don't reliably fire `change` on the `.db` file. `package.json`:
add export `"./loader": "./loader/index.js"` and add `loader/index.js` to `files[]`.

## Phase 4 — Deploy adapter system

`server/utils/deploy.js` (new) — registry exporting exactly what `git.js` already imports:
```js
import { rsyncAdapter } from './adapters/rsync.js';
const ADAPTERS = { rsync: rsyncAdapter };                 // netlify/cloudflare later: one line each
export function validateDeployConfig(c){ if(!c?.adapter) return {valid:true,errors:[]};
  const a=ADAPTERS[c.adapter]; if(!a) return {valid:false,errors:[`Unknown adapter: ${c.adapter}`]};
  return a.validate(c[c.adapter]||{}); }
export async function deploy(c, projectRoot, {distDir='dist', log=console.log}={}){
  return ADAPTERS[c.adapter].deploy({ projectRoot, distDir, config:c[c.adapter]||{}, log }); }
```
Adapter interface: `{ name, validate(config)→{valid,errors[]}, deploy({projectRoot,distDir,config,log})→result }`.

`server/utils/adapters/rsync.js` (new) — uses `spawn` (no shell, avoids injection of user paths):
- Local (`host` null): `rsync -a --delete <dist>/ <config.path>/` (trailing slashes sync contents).
- Remote (`host` set): add `-e "ssh -p <port> -i <keyPath>"`, target `<user>@<host>:<path>/`.
- Map `exclude[]`→`--exclude=`, honor `dryRun`→`--dry-run`. Resolve `distDir` under `projectRoot`,
  error if missing (build must precede). `validate`: require `path`; require `user` when `host` set.
This matches the existing call at `git.js:390` and validation at `git.js:316` — no git.js change needed for deploy to work.

## Phase 5 — Make git optional; restructure publish

Content lives in `content.db`, not `src/content`, so `git add src/content` is meaningless. Publishing
becomes **build + deploy**, with git an optional pre-step.
- New `server/api/publish.js` with `POST /publish`, mounted at `/api/publish` behind `requireAuth`;
  keep `POST /api/git/publish` as a thin alias (UI currently calls it — see blast radius). Move
  `runProductionBuild` here (or `server/utils/build.js`).
- Flow: validate deploy config (if adapter); **if `config.git.enabled`** run pull --rebase / add /
  commit / push but stage only `config.git.paths` (default `['src/styles/','public/images/']`; do
  NOT commit the binary DB by default); **else** skip all git and go straight to build+deploy; then
  if adapter: `runProductionBuild()` → `deploy()`. Keep response keys (`committed/pushed/commit/
  build/deploy/message`), allowing `committed:false,pushed:false` when git disabled.
- Gate the git router mount (`server/index.js`) on `config.git.enabled` (UI already reads
  `gitEnabled` to hide git UI). Drop `src/content` from `ALLOWED_GIT_PATHS` (`git.js:61`).

## Phase 6 — Astro 6-only cleanup + build-under-Bun

- `schema-parser.js`: remove legacy `src/content/config.ts` paths; keep `src/content.config.{ts,mts,js,mjs}`.
  Keep the `astro:content` / `astro/loaders` shims. **Add a shim/external for `astroadmin/loader`** so
  bundling a config that imports our loader doesn't fail (resolve to a stub recording loaderType).
- `collections.js` `watchSchemaConfig`: drop legacy paths.
- `config.js` `validateProject`: replace the `src/content` existence check with a check for
  `src/content.config.*`; drop the `mkdir src/content` hint.
- **Build under Bun**: change `config.build.production`/`staging` to run Astro under Bun (e.g.
  `bunx --bun astro build --outDir dist`) so the loader's `bun:sqlite` import works during build.
- `package.json`: bump `peerDependencies.astro` to `>=6.0.0`.

## Phase 7 — Migration (`server/utils/import-files.js` + `bin/cli.js migrate`)

One-time, non-destructive import of existing `src/content` into `content.db` (self-contained,
uses `gray-matter` + `fs`): per schema collection, glob → walk `*.{md,mdx,json}`, derive base
slug+locale (strip `.<locale>` when i18n), type from extension, upsert; file → read the JSON array,
upsert each with `slug=item.id||item.slug`, `position`=index, `type:'data'`. Idempotent (upsert by PK).
Add `astroadmin migrate` to `bin/cli.js`. Add a gated **startup auto-import** (`config.database.
autoImportOnEmpty`, default true): if DB empty and `src/content` has files, import once and set
`astroadmin_meta.imported=1` — protects upgrading installs.

## Phase 8 — Config (`server/config.js`)

Add `database: { path: process.env.ASTROADMIN_DB || path.join(PROJECT_ROOT,'.astroadmin/content.db'),
autoImportOnEmpty: true }`. Export `ASTROADMIN_DB` into the env of every spawned/exec'd Astro
child (`bin/cli.js` dev spawn, `runProductionBuild` exec, `build.js` exec) so the co-located loader
resolves the same path with zero per-site config. Add `git.paths`/`git.includeDb`. Document
`.gitignore` for `.astroadmin/` and `content.db*`.

## Front-end (`ui/`) — modest blast radius (15 refs across 3 files)

`ui/dashboard.html`, `ui/dashboard.js`, `ui/changes-panel.js` reference `filePath`, `/api/git/*`,
`gitEnabled`, `publishBtn`. `filePath` stays present (synthetic value) so display code keeps working;
publish keeps working via the `/api/git/publish` alias. Audit these for any code that assumes
`filePath` is a real path or that git routes always exist, and degrade gracefully when `gitEnabled` is false.

---

## Critical files

- New: `server/utils/db.js`, `loader/index.js`, `server/utils/deploy.js`,
  `server/utils/adapters/rsync.js`, `server/api/publish.js`, `server/utils/import-files.js`
- Rewrite: `server/utils/content.js`, `server/utils/collections.js` (listing only)
- Edit: `server/config.js`, `server/api/git.js`, `server/index.js`,
  `server/utils/schema-parser.js`, `bin/cli.js`, `package.json`, `ui/*`, README/docs

## Verification

1. **Unit/loader (Bun, no Astro):** seed a temp `content.db` via `db.js` DDL; call the loader's
   `load` with mock `{store,parseData,generateDigest,renderMarkdown}` and assert one `store.set`
   per row with correct `id` (incl. `slug/locale` for i18n) and `rendered` for content rows.
2. **API (`tests/api.test.js`):** point server at a seeded temp DB via `ASTROADMIN_DB`; existing
   read/write/delete round-trip assertions pass unchanged (they assert JSON, not files). Add a
   git-disabled run asserting `/api/git/*` is unmounted/409 and `/api/publish` still builds+deploys.
3. **Deploy:** rsync adapter with `dryRun:true` to a temp dir (local, no nginx); assert command + success.
4. **Migration:** run importer on a small `src/content` fixture (incl. an i18n collection and a
   `file()` collection); assert DB rows (base-slug/locale split, `position`).
5. **End-to-end (Astro 6 fixture):** a fixture site whose `content.config.ts` uses
   `astroadminLoader`; `bun astro build` reads the seeded DB and renders; edit via AstroAdmin →
   sentinel touch → dev server hot-reloads. Playwright e2e fixture updated to set `ASTROADMIN_DB`
   and use `deploy.adapter:'rsync'` + temp target.

## Confirm during implementation (Astro 6 specifics)

- `LoaderContext.watcher.add()` accepts an arbitrary path (sentinel outside content dir); else fall
  back to a dev-only watch via the integration hook.
- `renderMarkdown` is stable in Astro 6 and `entry.render()` consumes `{html, metadata}`.
- `astro/loaders` still exports `glob`/`file` (schema-parser shim); `astro:config:setup`
  `injectScript`/`injectRoute` signatures unchanged.
- Loader opens DB `readonly` under WAL; add a short `SQLITE_BUSY` retry.
- If any site must build under **node** (not Bun), switch the loader to `better-sqlite3`
  (declare it as the loader's dependency) — this is the main portability decision.
