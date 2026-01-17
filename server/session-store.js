/**
 * SQLite Session Store for express-session
 * Uses Bun's built-in SQLite for fast, native SQLite access
 */

import { Database } from 'bun:sqlite';
import session from 'express-session';

const Store = session.Store;

export class SQLiteStore extends Store {
  /**
   * @param {Object} options
   * @param {string} options.path - Path to SQLite database file
   * @param {number} options.ttl - Session TTL in milliseconds (default: 1 day)
   * @param {number} options.cleanupInterval - Cleanup interval in ms (default: 15 min)
   */
  constructor(options = {}) {
    super();

    const dbPath = options.path || './data/sessions.db';
    this.ttl = options.ttl || 86400000; // 1 day default
    this.cleanupInterval = options.cleanupInterval || 900000; // 15 minutes

    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');

    // Create sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires INTEGER NOT NULL
      )
    `);

    // Create index for cleanup queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires)
    `);

    // Prepare statements for performance
    this.stmts = {
      get: this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?'),
      set: this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expires) VALUES (?, ?, ?)'),
      destroy: this.db.prepare('DELETE FROM sessions WHERE sid = ?'),
      clear: this.db.prepare('DELETE FROM sessions'),
      length: this.db.prepare('SELECT COUNT(*) as count FROM sessions WHERE expires > ?'),
      all: this.db.prepare('SELECT sid, sess FROM sessions WHERE expires > ?'),
      touch: this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      cleanup: this.db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };

    // Start cleanup interval
    this._startCleanup();

    console.log(`[Session Store] SQLite store initialized at ${dbPath}`);
  }

  _startCleanup() {
    this._cleanupTimer = setInterval(() => {
      const now = Date.now();
      const result = this.stmts.cleanup.run(now);
      if (result.changes > 0) {
        console.log(`[Session Store] Cleaned up ${result.changes} expired sessions`);
      }
    }, this.cleanupInterval);

    // Don't keep process alive just for cleanup
    if (this._cleanupTimer.unref) {
      this._cleanupTimer.unref();
    }
  }

  get(sid, callback) {
    try {
      const row = this.stmts.get.get(sid, Date.now());
      if (row) {
        callback(null, JSON.parse(row.sess));
      } else {
        callback(null, null);
      }
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      const expires = Date.now() + this._getTTL(sess);
      this.stmts.set.run(sid, JSON.stringify(sess), expires);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.stmts.destroy.run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  clear(callback) {
    try {
      this.stmts.clear.run();
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  length(callback) {
    try {
      const row = this.stmts.length.get(Date.now());
      callback(null, row.count);
    } catch (err) {
      callback(err);
    }
  }

  all(callback) {
    try {
      const rows = this.stmts.all.all(Date.now());
      const sessions = rows.map(row => JSON.parse(row.sess));
      callback(null, sessions);
    } catch (err) {
      callback(err);
    }
  }

  touch(sid, sess, callback) {
    try {
      const expires = Date.now() + this._getTTL(sess);
      this.stmts.touch.run(expires, sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  _getTTL(sess) {
    if (sess && sess.cookie && sess.cookie.maxAge) {
      return sess.cookie.maxAge;
    }
    return this.ttl;
  }

  close() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
    }
    this.db.close();
  }
}

/**
 * Create a SQLite session store
 * @param {Object} options - Store options
 * @returns {SQLiteStore}
 */
export function createSessionStore(options) {
  return new SQLiteStore(options);
}
