/**
 * Environment configuration for AstroAdmin
 * Supports both development and production environments
 *
 * When running as npx astroadmin:
 * - PROJECT_ROOT is detected from process.cwd() or --project flag
 * - Optional astroadmin.config.js can override defaults
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Environment detection
export const ENV = process.env.NODE_ENV || 'development';
export const IS_DEV = ENV === 'development';
export const IS_PROD = ENV === 'production';

// Project root: from env var (set by CLI), or fall back to cwd
export const PROJECT_ROOT = process.env.ASTROADMIN_PROJECT_ROOT || process.cwd();

// Content store mode as far as the defaults can know it (env only —
// astroadmin.config.js may still override content.store; getConfig()
// recomputes mode-dependent defaults once that override is known, and
// content-store.js's activeStoreMode() is the runtime source of truth).
const CONTENT_STORE_MODE = process.env.ASTROADMIN_CONTENT_STORE || 'files';

// In files mode content lives in src/content, so publishing commits + pushes
// it along with assets. In db mode src/content is NOT staged — it may hold
// stale pre-migration files.
function defaultGitPathsForStore(storeMode) {
  return [
    ...(storeMode === 'db' ? [] : ['src/content/']),
    'src/styles/',
    'public/images/',
  ];
}

// UI assets directory (inside astroadmin package)
export const UI_DIR = path.resolve(__dirname, '../ui');

// Derived paths (can be overridden by user config)
const defaultPaths = {
  projectRoot: PROJECT_ROOT,
  content: path.join(PROJECT_ROOT, 'src/content'),
  public: path.join(PROJECT_ROOT, 'public'),
  srcImages: path.join(PROJECT_ROOT, 'src/assets/images'),
  images: path.join(PROJECT_ROOT, 'public/images'),
};

// Default configuration
const defaultConfig = {
  // Server settings (ASTROADMIN_PORT takes priority over PORT to avoid conflicts)
  port: parseInt(process.env.ASTROADMIN_PORT || process.env.PORT, 10) || 4000,
  host: process.env.ASTROADMIN_HOST || process.env.HOST || 'localhost',

  // Paths
  paths: defaultPaths,

  // Preview strategy
  preview: {
    // PREVIEW_URL: browser-accessible URL for the preview iframe
    // In dev: typically http://localhost:4321 (Astro dev server)
    // In prod: typically https://preview.example.com (proxied to Astro dev)
    url: process.env.PREVIEW_URL || (IS_DEV ? 'http://localhost:4321' : 'http://localhost:4322'),

    // How to update preview
    method: IS_DEV ? 'hot-reload' : 'build',
  },

  // Build commands
  // Run Astro under Bun so the content-layer loader's `bun:sqlite` import works.
  build: {
    staging: 'bunx --bun astro build --outDir staging-dist',
    production: 'bunx --bun astro build --outDir dist',
  },

  // Authentication
  // Prefer ADMIN_PASSWORD_HASH (argon2, generated via `astroadmin hash-password`).
  // ADMIN_PASSWORD is a plaintext fallback for local/dev only.
  auth: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin',
    passwordHash: process.env.ADMIN_PASSWORD_HASH || null,
    sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
    sessionCookie: {
      secure: IS_PROD,  // HTTPS only in production
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      // Host-only by default (undefined => cookie bound to the exact admin host).
      // A hosted instance sets this to its OWN admin host (e.g.
      // waveney.admin.example.com) so the cookie also reaches a nested preview
      // subdomain (preview.waveney.admin.example.com) for the preview vhost's
      // nginx auth_request — while STILL never reaching sibling instances
      // (feathered-thorns.admin.example.com), which aren't subdomains of it.
      domain: process.env.SESSION_COOKIE_DOMAIN || undefined,
    },
  },

  // Session store (production only - dev uses in-memory)
  sessionStore: IS_PROD ? {
    path: process.env.SESSION_DB_PATH || '/data/sessions.db',
    ttl: 1000 * 60 * 60 * 24 * 7, // 7 days (match cookie maxAge)
  } : null,

  // Content store selection: 'files' (default — git is the source of truth,
  // the site reads content via Astro's native glob()/file() loaders) or 'db'
  // (the shelved SQLite content store, kept for the future SaaS/DB direction).
  content: {
    store: CONTENT_STORE_MODE,
  },

  // Git integration
  // git.paths defaults are store-mode dependent (see defaultGitPathsForStore);
  // the site rebuilds from git on push (e.g. Netlify build-on-push). The
  // binary content DB is committed only when includeDb is true.
  git: {
    enabled: process.env.GIT_ENABLED !== 'false',
    autoCommit: IS_PROD,  // Auto-commit in production, manual in dev
    autoPush: process.env.GIT_AUTO_PUSH === 'true',
    paths: defaultGitPathsForStore(CONTENT_STORE_MODE),
    includeDb: false,
  },

  // Webhook (production only)
  webhook: {
    enabled: IS_PROD && process.env.WEBHOOK_ENABLED === 'true',
    secret: process.env.GITHUB_WEBHOOK_SECRET,
  },

  // File watching
  fileWatcher: {
    enabled: true,  // Both environments
    debounce: IS_DEV ? 500 : 2000,  // Faster in dev
  },

  // CORS
  cors: {
    origin: IS_DEV
      ? '*'  // Allow all in development
      : (process.env.ALLOWED_ORIGINS?.split(',') || []),
    credentials: true,
  },

  // Rate limiting (production only)
  rateLimit: {
    enabled: IS_PROD,
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: IS_DEV ? 1000 : 100, // Loose in dev, strict in prod
  },

  // Deployment configuration
  // When configured, the publish flow will: git commit + push → build → deploy
  // Supported adapters: 'rsync' (more coming: 's3', 'ftp', 'vercel', 'netlify')
  deploy: {
    adapter: null, // Set to 'rsync' to enable deployment
    // rsync adapter configuration
    rsync: {
      path: null,           // Required: destination path (e.g., '/var/www/mysite/public')
      host: null,           // Optional: hostname for remote deploy (omit for local)
      user: null,           // Required if host is set: SSH username (e.g., 'deploy')
      port: 22,             // SSH port (remote only)
      keyPath: null,        // Optional: path to SSH key (e.g., '~/.ssh/deploy_key')
      exclude: [],          // Optional: patterns to exclude (e.g., ['.git', 'node_modules'])
      dryRun: false,        // Optional: test without making changes
    },
  },

  // Content database (SQLite via bun:sqlite)
  // Single source of truth for content entries. The site's content-layer
  // loader reads this same file at build time (co-located per site).
  database: {
    path: process.env.ASTROADMIN_DB || path.join(PROJECT_ROOT, '.astroadmin/content.db'),
    autoImportOnEmpty: true, // import existing src/content on first run (Phase 7)
  },

  // Internationalization (i18n)
  // When enabled, content files use locale suffixes: page.en.md, page.fr.md
  i18n: {
    enabled: false,              // Disabled by default for backwards compatibility
    defaultLocale: 'en',         // Default locale when none specified
    locales: ['en'],             // Supported locales (add more when enabled)
  },
};

// User config (loaded asynchronously)
let userConfig = null;

/**
 * Load user config from astroadmin.config.js if it exists
 */
async function loadUserConfig() {
  if (userConfig !== null) return userConfig;

  const configPath = path.join(PROJECT_ROOT, 'astroadmin.config.js');

  try {
    await fs.access(configPath);
  } catch {
    // No user config file — defaults apply.
    userConfig = {};
    return userConfig;
  }

  // The file exists, so a failed import must be loud, not treated as "no
  // config" — silently falling back to defaults could flip the content store
  // mode and split reads/writes across stores.
  try {
    const imported = await import(configPath);
    userConfig = imported.default || imported;
    console.log('📋 Loaded user config from astroadmin.config.js');
  } catch (error) {
    console.error(`❌ Failed to load astroadmin.config.js: ${error.message}`);
    throw error;
  }

  return userConfig;
}

/**
 * Deep merge two objects
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Get merged configuration (default + user overrides)
 */
export async function getConfig() {
  const user = await loadUserConfig();
  const merged = deepMerge(defaultConfig, user);

  // The git.paths default depends on the store mode, and astroadmin.config.js
  // can set content.store — recompute the default once the override is known.
  // An explicit user git.paths always wins; env still beats the config file.
  if (!Array.isArray(user.git?.paths)) {
    const storeMode = process.env.ASTROADMIN_CONTENT_STORE || merged.content?.store || 'files';
    merged.git = { ...merged.git, paths: defaultGitPathsForStore(storeMode) };
  }

  return merged;
}

// Resolve ASTROADMIN_DB to a concrete absolute path so every child process we
// spawn (the Astro dev server, production builds) inherits the same content
// store path the server uses — the co-located loader then needs zero config.
if (!process.env.ASTROADMIN_DB) {
  process.env.ASTROADMIN_DB = defaultConfig.database.path;
}

// Export default config for synchronous access
// Note: This won't include user overrides until getConfig() is called
export const config = defaultConfig;

// Log configuration on startup (minimal version)
export function logConfig() {
  // Logging moved to after server starts for cleaner output
}

/**
 * Validate that the project root looks like an Astro project
 * Returns structured errors with hints for fixing issues
 */
export async function validateProject() {
  const errors = [];

  // Check for astro config (either .mjs or .ts)
  const astroConfigPaths = [
    path.join(PROJECT_ROOT, 'astro.config.mjs'),
    path.join(PROJECT_ROOT, 'astro.config.ts'),
  ];

  let hasAstroConfig = false;
  for (const configPath of astroConfigPaths) {
    try {
      await fs.access(configPath);
      hasAstroConfig = true;
      break;
    } catch {
      // Continue checking
    }
  }

  if (!hasAstroConfig) {
    errors.push({
      message: 'Not an Astro project (no astro.config.mjs or astro.config.ts found)',
      hint: 'Run astroadmin from your Astro project root directory, or use --project flag',
    });
  }

  // Check for a content config (Astro 6 Content Collections).
  const contentConfigPaths = [
    path.join(PROJECT_ROOT, 'src/content.config.ts'),
    path.join(PROJECT_ROOT, 'src/content.config.mts'),
    path.join(PROJECT_ROOT, 'src/content.config.js'),
    path.join(PROJECT_ROOT, 'src/content.config.mjs'),
  ];

  let hasContentConfig = false;
  for (const configPath of contentConfigPaths) {
    try {
      await fs.access(configPath);
      hasContentConfig = true;
      break;
    } catch {
      // Continue checking
    }
  }

  if (!hasContentConfig) {
    errors.push({
      message: 'Missing src/content.config.ts (Content Collections not set up)',
      hint: 'Create src/content.config.ts exporting your collections',
    });
  }

  return { valid: errors.length === 0, errors };
}
