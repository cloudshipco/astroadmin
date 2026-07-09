/**
 * AstroAdmin Express Server
 * Main server entry point
 */

import express from 'express';
import session from 'express-session';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { getConfig, IS_DEV, IS_PROD, logConfig } from './config.js';

// Import API routers
import collectionsRouter from './api/collections.js';
import contentRouter from './api/content.js';
import buildRouter from './api/build.js';
import gitRouter from './api/git.js';
import publishRouter from './api/publish.js';
import imagesRouter from './api/images.js';
import { clearSchemaCache, loadSchemas, watchSchemaConfig } from './utils/collections.js';
import { maybeAutoImport } from './utils/import-files.js';
import { verifyCredentials, authConfigWarnings } from './utils/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createServer() {
  const fullConfig = await getConfig();
  const app = express();

  // Trust proxy (for secure cookies behind nginx/reverse proxy)
  if (IS_PROD) {
    app.set('trust proxy', 1);
  }

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // CORS
  app.use(cors(fullConfig.cors));

  // Rate limiting (production only)
  if (fullConfig.rateLimit.enabled) {
    const limiter = rateLimit({
      windowMs: fullConfig.rateLimit.windowMs,
      max: fullConfig.rateLimit.max,
      message: 'Too many requests, please try again later.',
    });
    app.use('/api/', limiter);
  }

  // Session management with SQLite store (when running under Bun)
  const sessionConfig = {
    secret: fullConfig.auth.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: fullConfig.auth.sessionCookie,
  };

  // Use SQLite store in production for persistence across restarts
  // Only available when running under Bun (has built-in SQLite)
  if (IS_PROD && fullConfig.sessionStore?.path && typeof Bun !== 'undefined') {
    // Ensure data directory exists
    const dataDir = path.dirname(fullConfig.sessionStore.path);
    mkdirSync(dataDir, { recursive: true });

    // Dynamic import since bun:sqlite only exists in Bun runtime
    const { createSessionStore } = await import('./session-store.js');
    sessionConfig.store = createSessionStore({
      path: fullConfig.sessionStore.path,
      ttl: fullConfig.sessionStore.ttl,
    });
  }

  app.use(session(sessionConfig));

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      environment: IS_DEV ? 'development' : 'production',
      timestamp: new Date().toISOString(),
    });
  });

  // Config endpoint (returns safe config for frontend)
  app.get('/api/config', (req, res) => {
    res.json({
      environment: IS_DEV ? 'development' : 'production',
      previewUrl: fullConfig.preview.url,
      previewMethod: fullConfig.preview.method,
      gitEnabled: fullConfig.git.enabled,
    });
  });

  // Warn loudly (once, at startup) about weak auth config in production.
  for (const warning of authConfigWarnings(fullConfig.auth, IS_PROD)) {
    console.warn(`⚠️  Insecure auth: ${warning}`);
  }

  // Authentication endpoints
  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    let ok = false;
    try {
      ok = await verifyCredentials(fullConfig.auth, username, password);
    } catch (err) {
      console.error('[Login] Verification error:', err);
      return res.status(500).json({ success: false, error: 'Authentication error' });
    }

    if (ok) {
      req.session.authenticated = true;
      req.session.user = fullConfig.auth.username;

      // Explicitly save session to ensure cookie is set
      req.session.save((err) => {
        if (err) {
          console.error('[Login] Session save error:', err);
          return res.status(500).json({ success: false, error: 'Session error' });
        }
        console.log(`[Login] Success, session ID: ${req.sessionID}`);
        res.json({ success: true, user: fullConfig.auth.username });
      });
    } else {
      console.log('[Login] Failed login attempt');
      res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ success: false, error: 'Logout failed' });
      }
      res.json({ success: true });
    });
  });

  app.get('/api/session', (req, res) => {
    if (req.session.authenticated) {
      res.json({
        authenticated: true,
        user: req.session.user,
      });
    } else {
      res.json({ authenticated: false });
    }
  });

  // Lightweight auth probe for the hosted preview vhost's nginx `auth_request`.
  // Deliberately NOT under /api/ (so the /api/ rate limiter can't trip it — one
  // preview page load fires an auth_request per asset) and NOT /api/session
  // (which 200s when logged out, which auth_request reads as ALLOW). 204 when
  // authenticated, 401 otherwise — the only two statuses auth_request needs.
  app.get('/__authz', (req, res) => {
    res.sendStatus(req.session.authenticated ? 204 : 401);
  });

  // Reload schemas endpoint (requires auth)
  app.post('/api/reload-schemas', (req, res) => {
    if (!req.session.authenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      console.log('🔄 Reloading schemas...');
      clearSchemaCache();
      // Trigger reload
      loadSchemas().then(schemas => {
        res.json({
          success: true,
          message: `Reloaded ${Object.keys(schemas).length} collection schemas`
        });
      }).catch(error => {
        res.status(500).json({ error: error.message });
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Auth middleware for protected routes
  function requireAuth(req, res, next) {
    if (req.session.authenticated) {
      next();
    } else {
      res.status(401).json({ error: 'Authentication required' });
    }
  }

  // API routes
  app.use('/api/collections', requireAuth, collectionsRouter);
  app.use('/api/content', requireAuth, contentRouter);
  app.use('/api/build', requireAuth, buildRouter);
  app.use('/api/publish', requireAuth, publishRouter);
  // Git endpoints are only mounted when git is enabled. Publishing does not
  // require git — use /api/publish (the git router's /publish is an alias).
  if (fullConfig.git.enabled) {
    app.use('/api/git', requireAuth, gitRouter);
  }
  app.use('/api/images', requireAuth, imagesRouter);

  // Page routes (BEFORE static middleware to take precedence)
  app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, '../ui/login.html'));
  });

  app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, '../ui/dashboard.html'));
  });

  // Dashboard with collection/slug in URL (for direct linking)
  app.get('/dashboard/:collection/:slug', (req, res) => {
    res.sendFile(path.join(__dirname, '../ui/dashboard.html'));
  });

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../ui/index.html'));
  });

  // Serve static assets (CSS, JS files with explicit extensions)
  app.use(express.static(path.join(__dirname, '../ui'), {
    index: false, // Don't auto-serve index.html
  }));

  // Serve images for previews in the admin
  // First check src/assets/images (source images), then public/images (uploads)
  app.use('/images', express.static(fullConfig.paths.srcImages));
  app.use('/images', express.static(fullConfig.paths.images));

  // Serve assets for content-relative image paths
  // Content files use relative paths like ../assets/posts/... which resolve to src/content/assets/
  // Also check src/assets for project-level assets
  const contentAssetsDir = path.join(fullConfig.paths.projectRoot, 'src/content/assets');
  const srcAssetsDir = path.join(fullConfig.paths.projectRoot, 'src/assets');
  app.use('/assets', express.static(contentAssetsDir));
  app.use('/assets', express.static(srcAssetsDir));

  // Catch-all for API routes (404)
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      // API route not found
      return res.status(404).json({ error: 'API endpoint not found' });
    }
    // Serve UI for all other routes
    res.sendFile(path.join(__dirname, '../ui/index.html'));
  });

  // Error handling middleware
  app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
      error: 'Internal server error',
      message: IS_DEV ? err.message : 'Something went wrong',
    });
  });

  return { app, requireAuth };
}

/**
 * Try to start server on a port, with fallback to next ports if taken
 */
function tryListen(app, port, host, maxAttempts = 20) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    let currentPort = port;

    const tryPort = () => {
      attempts++;
      const server = app.listen(currentPort, host);

      server.on('listening', () => {
        resolve({ server, port: currentPort });
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          if (attempts < maxAttempts) {
            currentPort++;
            tryPort();
          } else {
            reject(new Error(`Could not find available port after ${maxAttempts} attempts (tried ${port}-${currentPort})`));
          }
        } else {
          reject(err);
        }
      });
    };

    tryPort();
  });
}

export async function startServer(options = {}) {
  const fullConfig = await getConfig();
  const port = options.port !== undefined ? options.port : fullConfig.port;
  const host = options.host !== undefined ? options.host : fullConfig.host;

  // Log configuration
  logConfig();

  // Create Express app
  const { app } = await createServer();

  // Start watching schema config for changes
  watchSchemaConfig();

  // Import existing src/content into the DB on first run (when empty)
  await maybeAutoImport();

  // Start server with port fallback
  const { server, port: actualPort } = await tryListen(app, port, host);

  // Clean startup message
  console.log('');
  if (actualPort !== port) {
    console.log(`⚠️  Port ${port} in use`);
  }
  console.log(`✅ AstroAdmin running at http://${host}:${actualPort}`);
  console.log(`   Preview: ${fullConfig.preview.url}`);
  if (fullConfig.git.enabled) {
    console.log(`   Git: ${fullConfig.git.autoCommit ? 'auto-commit enabled' : 'manual commits'}`);
  }
  console.log('');

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('\n👋 SIGTERM received, shutting down gracefully...');
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('\n👋 SIGINT received, shutting down gracefully...');
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });

  return server;
}
