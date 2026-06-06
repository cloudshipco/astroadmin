/**
 * SQLite driver abstraction for the content-layer loader.
 *
 * The loader runs inside the consuming site's Astro build, which may be Bun OR
 * Node (e.g. Netlify, generic CI). Bun ships a built-in `bun:sqlite`; Node has
 * no bundled SQLite, so we fall back to the optional `better-sqlite3` native
 * addon. The driver is chosen at runtime and loaded via a dynamic import whose
 * specifier is hidden behind a variable (plus `@vite-ignore`) so that Astro's
 * Vite/esbuild config load never tries to statically resolve `bun:sqlite` under
 * Node — a static import there breaks the whole build.
 *
 * Both drivers are normalised to the tiny slice the loader needs:
 *   openContentDb(path) -> { query(sql) -> { all(...params) }, close() }
 */

let driverPromise = null;

/** Whether the current runtime is Bun (has a built-in `bun:sqlite`). */
function runningUnderBun() {
  return typeof process !== 'undefined' && Boolean(process.versions?.bun);
}

async function loadDriver() {
  if (runningUnderBun()) {
    // Hidden behind a variable so Node bundlers never try to resolve it.
    const specifier = 'bun:sqlite';
    const { Database } = await import(/* @vite-ignore */ specifier);
    return {
      name: 'bun:sqlite',
      open(path) {
        const db = new Database(path, { readonly: true });
        return {
          query: (sql) => db.query(sql),
          close: () => db.close(),
        };
      },
    };
  }

  // Node (or any non-Bun runtime): use the optional better-sqlite3 addon.
  const specifier = 'better-sqlite3';
  let BetterSqlite3;
  try {
    BetterSqlite3 = (await import(/* @vite-ignore */ specifier)).default;
  } catch (error) {
    throw new Error(
      'astroadmin loader: this build is running under Node, which needs the ' +
        'optional `better-sqlite3` dependency to read the content store. ' +
        'Install it (`npm install better-sqlite3`) or build under Bun ' +
        `(\`bunx --bun astro build\`). Underlying error: ${error.message}`
    );
  }
  return {
    name: 'better-sqlite3',
    open(path) {
      const db = new BetterSqlite3(path, { readonly: true });
      return {
        // better-sqlite3 uses prepare(); its statement also exposes .all().
        query: (sql) => db.prepare(sql),
        close: () => db.close(),
      };
    },
  };
}

/**
 * Open the content DB read-only with whichever SQLite driver is available for
 * the current runtime. Returns a normalised handle: { query, close }.
 */
export async function openContentDb(path) {
  if (!driverPromise) {
    driverPromise = loadDriver();
  }

  let driver;
  try {
    driver = await driverPromise;
  } catch (error) {
    // Don't cache a failed driver load — let a later call retry the import.
    driverPromise = null;
    throw error;
  }

  return driver.open(path);
}

/**
 * Whether an error is a transient SQLITE_BUSY (a concurrent AstroAdmin writer
 * under WAL). The loader retries briefly on these; everything else is fatal.
 */
export function isBusyError(error) {
  const message = String(error?.message || '');
  return (
    error?.code === 'SQLITE_BUSY' ||
    message.includes('SQLITE_BUSY') ||
    message.includes('database is locked')
  );
}
