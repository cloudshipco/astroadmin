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
  build: {
    staging: 'astro build --outDir staging-dist',
    production: 'astro build --outDir dist',
  },

  // Authentication
  auth: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin',
    sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
    sessionCookie: {
      secure: IS_PROD,  // HTTPS only in production
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  },

  // Session store (production only - dev uses in-memory)
  sessionStore: IS_PROD ? {
    path: process.env.SESSION_DB_PATH || '/data/sessions.db',
    ttl: 1000 * 60 * 60 * 24 * 7, // 7 days (match cookie maxAge)
  } : null,

  // Git integration
  git: {
    enabled: process.env.GIT_ENABLED !== 'false',
    autoCommit: IS_PROD,  // Auto-commit in production, manual in dev
    autoPush: process.env.GIT_AUTO_PUSH === 'true',
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
    const imported = await import(configPath);
    userConfig = imported.default || imported;
    console.log('📋 Loaded user config from astroadmin.config.js');
  } catch {
    userConfig = {};
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
  return deepMerge(defaultConfig, user);
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

  // Check for content directory
  const contentPath = path.join(PROJECT_ROOT, 'src/content');
  try {
    await fs.access(contentPath);
  } catch {
    errors.push({
      message: 'Missing src/content directory (Content Collections not set up)',
      hint: 'mkdir -p src/content && touch src/content/config.ts',
    });
  }

  return { valid: errors.length === 0, errors };
}
