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
import { config, IS_DEV, IS_PROD, logConfig } from './config.js';

// Import API routers
import collectionsRouter from './api/collections.js';
import contentRouter from './api/content.js';
import buildRouter from './api/build.js';
import gitRouter from './api/git.js';
import imagesRouter from './api/images.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer() {
  const app = express();

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

  // Session management
  app.use(session({
    secret: config.auth.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: config.auth.sessionCookie,
  }));

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

    if (
      username === config.auth.username &&
      password === config.auth.password
    ) {
      req.session.authenticated = true;
      req.session.user = username;
      res.json({ success: true, user: username });
    } else {
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

export async function startServer(options = {}) {
  const port = options.port || config.port;
  const host = options.host || config.host;

  // Log configuration
  logConfig();

  // Create Express app
  const { app } = createServer();

  // Start server
  const server = app.listen(port, host, () => {
    const actualPort = server.address().port;
    console.log(`✅ AstroAdmin server running at http://${host}:${actualPort}`);
    console.log(`📝 Admin UI: http://${host}:${actualPort}`);
    console.log(`🔍 Preview: ${config.preview.url}\n`);

    if (IS_DEV) {
      console.log('💡 Development mode - hot reload enabled');
      console.log('   Make sure Astro dev server is running on port 4321\n');
    } else {
      console.log('🚀 Production mode - builds required for preview\n');
    }
  });

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
