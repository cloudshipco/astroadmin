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
import { config, IS_DEV, IS_PROD, logConfig } from './config.js';

// Import API routers
import collectionsRouter from './api/collections.js';
import contentRouter from './api/content.js';
import buildRouter from './api/build.js';
import gitRouter from './api/git.js';
import imagesRouter from './api/images.js';
import { clearSchemaCache, loadSchemas, watchSchemaConfig } from './utils/collections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createServer() {
  const app = express();

  // Trust proxy (for secure cookies behind nginx/reverse proxy)
  if (IS_PROD) {
    app.set('trust proxy', 1);
  }

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // CORS
  app.use(cors(config.cors));

  // Rate limiting (production only)
  if (config.rateLimit.enabled) {
    const limiter = rateLimit({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
      message: 'Too many requests, please try again later.',
    });
    app.use('/api/', limiter);
  }

  // Session management with SQLite store (when running under Bun)
  const sessionConfig = {
    secret: config.auth.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: config.auth.sessionCookie,
  };

  // Use SQLite store in production for persistence across restarts
  // Only available when running under Bun (has built-in SQLite)
  if (IS_PROD && config.sessionStore?.path && typeof Bun !== 'undefined') {
    // Ensure data directory exists
    const dataDir = path.dirname(config.sessionStore.path);
    mkdirSync(dataDir, { recursive: true });

    // Dynamic import since bun:sqlite only exists in Bun runtime
    const { createSessionStore } = await import('./session-store.js');
    sessionConfig.store = createSessionStore({
      path: config.sessionStore.path,
      ttl: config.sessionStore.ttl,
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
      previewUrl: config.preview.url,
      previewMethod: config.preview.method,
      gitEnabled: config.git.enabled,
    });
  });

  // Authentication endpoints
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    console.log(`[Login] Attempt for user: ${username}`);

    if (
      username === config.auth.username &&
      password === config.auth.password
    ) {
      req.session.authenticated = true;
      req.session.user = username;

      // Explicitly save session to ensure cookie is set
      req.session.save((err) => {
        if (err) {
          console.error('[Login] Session save error:', err);
          return res.status(500).json({ success: false, error: 'Session error' });
        }
        console.log(`[Login] Success for user: ${username}, session ID: ${req.sessionID}`);
        res.json({ success: true, user: username });
      });
    } else {
      console.log(`[Login] Failed for user: ${username}`);
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
  app.use('/api/git', requireAuth, gitRouter);
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
  app.use('/images', express.static(config.paths.srcImages));
  app.use('/images', express.static(config.paths.images));

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
  const port = options.port !== undefined ? options.port : config.port;
  const host = options.host !== undefined ? options.host : config.host;

  // Log configuration
  logConfig();

  // Create Express app
  const { app } = await createServer();

  // Start watching schema config for changes
  watchSchemaConfig();

  // Start server with port fallback
  const { server, port: actualPort } = await tryListen(app, port, host);

  // Clean startup message
  console.log('');
  if (actualPort !== port) {
    console.log(`⚠️  Port ${port} in use`);
  }
  console.log(`✅ AstroAdmin running at http://${host}:${actualPort}`);
  console.log(`   Preview: ${config.preview.url}`);
  if (config.git.enabled) {
    console.log(`   Git: ${config.git.autoCommit ? 'auto-commit enabled' : 'manual commits'}`);
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
