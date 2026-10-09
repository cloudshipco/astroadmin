/**
 * The doctor inside the editor: after the publish check has built a commit
 * (server/utils/astro-check.js), read that build's HTML with the built-HTML
 * checks, keep the latest result, and serve it to the editor's notice.
 *
 * It costs no extra build. It can never fail or noticeably slow a publish:
 * the scan runs in a child process (./editor-scan.js) against the check's
 * worktree, the deadline is enforced here by killing that process, and any
 * error becomes an "unavailable" result. The API's `reason` is short and names
 * no server path; the full error goes to the server log.
 * The result lives in memory, so it is empty again after a restart until the
 * next publish.
 */

import express from 'express';
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { cleanCheckOutput } from '../utils/astro-check.js';
import { RESULT_MARKER, outDirFor } from './editor-scan.js';
import { bunExecutable } from '../utils/astro-bin.js';

export { outDirFor };

const DEFAULT_SCAN_TIMEOUT_MS = 3000;
const SCAN_SCRIPT = fileURLToPath(new URL('./editor-scan.js', import.meta.url));
const PACKAGE_ROOT = path.resolve(path.dirname(SCAN_SCRIPT), '../..');
const MAX_REASON_LENGTH = 300;
const MAX_TEXT_LENGTH = 1000;

/**
 * @typedef {Object} EditorDoctorResult
 * @property {'ok'|'unavailable'} status
 * @property {string} commit
 * @property {string} checkedAt - ISO time
 * @property {number} durationMs - how long the scan held up the publish
 * @property {string} [reason] - why it is unavailable (short, no server paths)
 * @property {{covered: number, total: number, byCollection: Array}|null} [coverage]
 * @property {Array} [results] - the built-HTML checks' results
 */

/** @type {EditorDoctorResult|null} */
let latestResult = null;
let scanGeneration = 0;

/** The latest result, or null before the first publish check. */
export function getLatestDoctorResult() {
  return latestResult;
}

/** For tests. */
export function resetLatestDoctorResult() {
  latestResult = null;
}

function bounded(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * An error for the API: the given server directories made relative, any other
 * absolute path reduced to its last segment, whitespace collapsed, bounded.
 */
function reasonForApi(text, serverPaths) {
  return bounded(cleanCheckOutput(String(text), serverPaths)
    .replace(/(^|[\s"'(=:])\/(?:[^\s"'()/]+\/)+([^\s"'()/]*)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim(), MAX_REASON_LENGTH);
}

/**
 * A check's message or detail for the API: the server directories made
 * relative (page paths such as /services/a are the site's, and stay), bounded.
 */
function textForApi(text, serverPaths) {
  return bounded(cleanCheckOutput(String(text), serverPaths), MAX_TEXT_LENGTH);
}

/**
 * Run the scan script in a child process and settle by the deadline, killing
 * the child if it has not finished.
 * @returns {Promise<{timedOut: true}|{outcome: {ok?: Object, error?: string}}|{crashed: string}>}
 */
function runScanProcess(scanScript, input, env, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // --no-install: a missing import must fail, never be fetched. The cwd is
    // this package, so a site's bunfig.toml (preloads) does not apply.
    const child = spawn(bunExecutable(), ['--no-install', scanScript, JSON.stringify(input)], { cwd: PACKAGE_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      settle({ timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (stdout.length < 5_000_000) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 100_000) stderr += chunk; });
    child.on('error', (error) => settle({ crashed: error.message }));
    child.on('close', (exitCode) => {
      const line = stdout.split('\n').reverse().find((candidate) => candidate.startsWith(RESULT_MARKER));
      if (!line) {
        settle({ crashed: `exit code ${exitCode}: ${stderr.trim().split('\n').slice(-5).join(' | ')}` });
        return;
      }
      try {
        settle({ outcome: JSON.parse(line.slice(RESULT_MARKER.length)) });
      } catch (error) {
        settle({ crashed: `unreadable result: ${error.message}` });
      }
    });
  });
}

/**
 * Run the built-HTML checks on a publish check's build and record the result.
 * Never throws, and returns within `timeoutMs` (plus process start-up).
 * @param {Object} fullConfig - getConfig() result
 * @param {{siteDir: string, commit: string, command: string}} build
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.scanScript] - for tests: the script the child runs
 */
export async function recordDoctorAfterCheck(fullConfig, build, { timeoutMs = DEFAULT_SCAN_TIMEOUT_MS, scanScript = SCAN_SCRIPT } = {}) {
  if (fullConfig.doctor?.enabled === false) return;
  const generation = ++scanGeneration;
  const startedAt = Date.now();
  const checkedAt = new Date(startedAt).toISOString();
  const record = (result) => {
    if (generation === scanGeneration) latestResult = { commit: build.commit, checkedAt, durationMs: Date.now() - startedAt, ...result };
  };
  const serverPaths = [build.siteDir, fullConfig.paths?.projectRoot, os.tmpdir(), PACKAGE_ROOT];
  const unavailable = (logMessage, reason) => {
    console.warn(`Doctor scan unavailable: ${logMessage}`);
    record({ status: 'unavailable', reason: reasonForApi(reason, serverPaths) });
  };
  try {
    const { realpath } = await import('fs/promises');
    for (const directory of [...serverPaths]) {
      if (directory) serverPaths.push(await realpath(directory).catch(() => null));
    }
    const env = {
      ...process.env,
      ASTROADMIN_PROJECT_ROOT: build.siteDir,
      ASTROADMIN_CONTENT_STORE: process.env.ASTROADMIN_CONTENT_STORE || fullConfig.content?.store || 'files',
    };
    const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
    const run = await runScanProcess(scanScript, { siteDir: build.siteDir, command: build.command }, env, remaining);
    if (run.timedOut) {
      unavailable(`it did not finish within ${timeoutMs} ms`, `The scan did not finish within ${timeoutMs} ms.`);
      return;
    }
    if (run.crashed) {
      unavailable(`the scan process stopped without a result (${run.crashed})`, 'The scan stopped without a result.');
      return;
    }
    if (run.outcome.error) {
      unavailable(run.outcome.error, `The scan could not run: ${run.outcome.error}`);
      return;
    }
    const { coverage, results } = run.outcome.ok;
    record({
      status: 'ok',
      coverage,
      results: results.map((result) => ({
        ...result,
        message: textForApi(result.message, serverPaths),
        details: result.details.map((detail) => textForApi(detail, serverPaths)),
      })),
    });
  } catch (error) {
    unavailable(error.stack || error.message, 'The scan could not run.');
  }
}

const router = express.Router();

/** GET /api/doctor/latest — the latest built-HTML check result, or null. */
router.get('/latest', (req, res) => {
  res.json({ success: true, result: getLatestDoctorResult() });
});

export default router;
