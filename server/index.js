/**
 * AstroAdmin Express Server
 * Main server entry point
 */

import express from 'express';
import session from 'express-session';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { getConfig, IS_DEV, IS_PROD, logConfig } from './config.js';

// Import API routers
import collectionsRouter from './api/collections.js';
import contentRouter from './api/content.js';
import gitRouter from './api/git.js';
import publishRouter from './api/publish.js';
import imagesRouter from './api/images.js';
import doctorRouter from './doctor/editor.js';
import { clearSchemaCache, loadSchemas, watchSchemaConfig } from './utils/collections.js';
import { maybeAutoImport } from './utils/import-files.js';
import { verifyCredentials, authConfigWarnings } from './utils/auth.js';
import { requireSameOrigin } from './utils/same-origin.js';
import { apiRateLimiters } from './utils/rate-limit.js';
import { sessionFingerprint } from './utils/session-fingerprint.js';
import { authFailedLine } from './utils/auth-log.js';
import { loginCookieRefusal, untrustedProxyWarning } from './utils/untrusted-proxy.js';
import { mediaKindOf } from '../ui/media-kinds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA_RELOAD_FAILED = "The content config could not be loaded; see the server log.";

// body-parser's refusals of a request (its README's error types; we pass no
// `verify`), each with our sentence. The parser's own message quotes the body.
const BODY_REFUSALS = new Map([
  ['entity.parse.failed', 'The request body must be a JSON object or array.'],
  ['entity.too.large', 'The request body is too large.'],
  ['encoding.unsupported', 'The request body\'s content encoding is not supported.'],
  ['charset.unsupported', 'The request body\'s character set is not supported.'],
  ['request.aborted', 'The request body was not received in full.'],
  ['request.size.invalid', 'The request body was not received in full.'],
]);

export async function createServer() {
  const fullConfig = await getConfig();
  const app = express();

  // Trusted proxies (config `trustProxy`, env TRUST_PROXY): their
  // X-Forwarded-For is the client's address (rate limits, the auth.failed
  // log) and X-Forwarded-Proto makes secure cookies work behind TLS
  // termination. Production defaults to loopback only, so a client that
  // reaches the app directly cannot choose its own address.
  if (fullConfig.trustProxy !== false && fullConfig.trustProxy !== undefined) {
    app.set('trust proxy', fullConfig.trustProxy);
  }

  // A TLS proxy we do not trust makes every request plain HTTP, so the
  // HTTPS-only session cookie is never set: say so in the server log (at
  // most hourly, before the same-origin check, whose 403 it can also cause).
  const cookieSecure = fullConfig.auth.sessionCookie?.secure === true;
  app.use(untrustedProxyWarning({ cookieSecure }));

  // Middleware. JSON only: nothing in the admin posts a urlencoded form (login
  // sends JSON), and multer parses /api/images uploads itself.
  app.use(express.json());

  // CORS
  app.use(cors(fullConfig.cors));

  // Refuse state-changing /api requests from any other origin, before any
  // route (login and logout included). SameSite=Strict still sends the
  // session cookie from a sibling origin on the same site, such as the hosted
  // preview subdomain. See server/utils/same-origin.js.
  app.use('/api', requireSameOrigin(fullConfig.cors.origin));

  // Session management with SQLite store (when running under Bun)
  const sessionConfig = {
    secret: fullConfig.auth.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: fullConfig.auth.sessionCookie,
  };
  // A distinct cookie name (hosted instances set one) sidesteps the collision
  // where an old host-only `connect.sid` and a new domain-scoped one coexist:
  // the browser sends the stale one first and the user is logged straight out.
  // A different name means the old cookie is simply ignored.
  if (fullConfig.auth.sessionName) sessionConfig.name = fullConfig.auth.sessionName;

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

  // Rate limiting (production only). After the session middleware: a
  // signed-in session gets its own budget, everyone else and every login
  // attempt share the strict per-address one, and failed logins also have
  // their own, smaller per-address budget (server/utils/rate-limit.js).
  if (fullConfig.rateLimit.enabled) {
    app.use('/api/', ...apiRateLimiters(fullConfig.rateLimit));
  }

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
      publicUrl: fullConfig.publicUrl || null,
      gitEnabled: fullConfig.git.enabled,
      collectionOrder: fullConfig.collectionOrder || [],
      // Whether the image library offers the crop control (images.crop).
      imageCrop: fullConfig.images?.crop === true,
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

    const cookieRefusal = ok ? loginCookieRefusal(req, cookieSecure) : null;
    if (cookieRefusal !== null) {
      // The session cookie would be dropped silently and the editor sent
      // back here; tell them why instead (after the password check, so a
      // wrong password still gets its 401 and auth.failed line).
      return res.status(500).json({ success: false, error: cookieRefusal });
    }

    if (ok) {
      // A new session ID on every login, so a session ID planted or seen
      // before login (session fixation) is never the signed-in one.
      req.session.regenerate((regenerateError) => {
        if (regenerateError) {
          console.error('[Login] Session regenerate error:', regenerateError);
          return res.status(500).json({ success: false, error: 'Session error' });
        }
        req.session.authenticated = true;
        req.session.user = fullConfig.auth.username;

        // Explicitly save session to ensure cookie is set
        req.session.save((err) => {
          if (err) {
            console.error('[Login] Session save error:', err);
            return res.status(500).json({ success: false, error: 'Session error' });
          }
          // Never the session ID itself: it is a credential, and this line goes
          // to the system journal. A short digest still ties log lines together.
          console.log(`[Login] Success, session ${sessionFingerprint(req.sessionID)}`);
          res.json({ success: true, user: fullConfig.auth.username });
        });
      });
    } else {
      // The fixed line a host's fail2ban matches (server/utils/auth-log.js):
      // no username or other client text, so it cannot be forged.
      console.log(authFailedLine(req.ip));
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
        // The bundler's message names the config file by its server path.
        console.error('Reloading schemas failed:', error);
        res.status(500).json({ error: SCHEMA_RELOAD_FAILED });
      });
    } catch (error) {
      console.error('Reloading schemas failed:', error);
      res.status(500).json({ error: SCHEMA_RELOAD_FAILED });
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
  app.use('/api/publish', requireAuth, publishRouter);
  // Git endpoints are only mounted when git is enabled. Publishing does not
  // require git — use /api/publish (the git router's /publish is an alias).
  if (fullConfig.git.enabled) {
    app.use('/api/git', requireAuth, gitRouter);
  }
  app.use('/api/images', requireAuth, imagesRouter);
  app.use('/api/doctor', requireAuth, doctorRouter);

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

  // Site files served on the admin's OWN origin (editor thumbnails only; the
  // site's host and the preview serve the site's images themselves). An SVG is
  // a document as well as an image, so an uploaded one opened directly here
  // would run its script with the editor's session. Sandbox every such
  // response: a CSP on a response applies only when it is rendered as a
  // document, so <img> display is unchanged, while a direct visit gets an
  // opaque origin and no script. nosniff keeps a file from being re-read as
  // HTML.
  //
  // A video opened directly is a media document that requests the video
  // itself. From an opaque origin that request is cross-origin (measured,
  // Chromium 151: `Sec-Fetch-Site: cross-site`), so it carries no session
  // cookie (SameSite Strict or Lax) and this route answers 401; and even a
  // 206 with the video is discarded unless it carries CORS permission. No
  // media-src (`'self'`, `*`, or none) changes either. So a video, and only a
  // video, keeps its own origin (`allow-same-origin`): its request is then
  // same-origin, with the cookie. The sandbox still allows no script (no
  // `allow-scripts`, which also stops autoplay: the viewer starts it), and
  // nosniff keeps the file a video.
  const SITE_FILE_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
  const VIDEO_FILE_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; media-src 'self'; sandbox allow-same-origin";
  const siteFileOptions = {
    setHeaders(res, filePath) {
      const policy = mediaKindOf(filePath) === 'video' ? VIDEO_FILE_POLICY : SITE_FILE_POLICY;
      res.setHeader('Content-Security-Policy', policy);
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  };

  // These folders hold unpublished drafts (src/assets, src/content/assets, new
  // uploads), so they need the same session as the API. The editor's <img>
  // requests are same-origin and carry the session cookie; the site's host
  // and the preview serve their own copies and never come here. A 401 matches
  // the API; the admin's pages send a logged-out user to /login themselves.
  app.use(['/images', '/assets'], requireAuth);

  // Serve images for previews in the admin
  // First check src/assets/images (source images), then public/images (uploads)
  app.use('/images', express.static(fullConfig.paths.srcImages, siteFileOptions));
  app.use('/images', express.static(fullConfig.paths.images, siteFileOptions));

  // Serve assets for content-relative image paths
  // Content files use relative paths like ../assets/posts/... which resolve to src/content/assets/
  // Also check src/assets for project-level assets
  const contentAssetsDir = path.join(fullConfig.paths.projectRoot, 'src/content/assets');
  const srcAssetsDir = path.join(fullConfig.paths.projectRoot, 'src/assets');
  app.use('/assets', express.static(contentAssetsDir, siteFileOptions));
  app.use('/assets', express.static(srcAssetsDir, siteFileOptions));

  // Catch-all for API routes (404)
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      // API route not found
      return res.status(404).json({ error: 'API endpoint not found' });
    }
    // Serve UI for all other routes
    res.sendFile(path.join(__dirname, '../ui/index.html'));
  });

  // A refused body comes before the session, auth and the rate limit, so
  // anyone can send them: one warning a minute at most, naming how many more.
  let lastBodyRefusalWarning = 0;
  let bodyRefusalsSinceWarning = 0;
  const warnBodyRefusal = (type, req) => {
    const now = Date.now();
    if (now - lastBodyRefusalWarning < 60_000) { bodyRefusalsSinceWarning++; return; }
    const more = bodyRefusalsSinceWarning ? `; ${bodyRefusalsSinceWarning} more since the last warning` : '';
    lastBodyRefusalWarning = now;
    bodyRefusalsSinceWarning = 0;
    console.warn(`Refused a request body (${type}) on ${req.method} ${req.path}${more}`);
  };

  // Error handling middleware
  app.use((err, req, res, next) => {
    // A body express.json() refused (a JSON primitive in strict mode,
    // malformed JSON, too large, an unsupported charset) is the request's
    // fault (#104): its own 4xx with fixed text, and only a warning here. The
    // parser's message quotes the body, so it goes nowhere.
    if (BODY_REFUSALS.has(err.type) && err.status >= 400 && err.status < 500) {
      warnBodyRefusal(err.type, req);
      return res.status(err.status).json({ error: BODY_REFUSALS.get(err.type) });
    }
    console.error('Server error:', err);
    res.status(500).json({
      error: 'Internal server error',
      // Even in development: an fs error's message is its absolute path.
      message: 'Something went wrong; see the server log.',
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
