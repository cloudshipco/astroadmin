/**
 * The doctor inside the editor: after the publish check has built a commit
 * (server/utils/astro-check.js), read that build's HTML with the built-HTML
 * checks, keep the latest result, and serve it to the editor's notice.
 *
 * It costs no extra build. It can never fail or noticeably slow a publish:
 * the scan is capped, and any error becomes an "unavailable" result.
 * The result lives in memory, so it is empty again after a restart until the
 * next publish.
 */

import express from 'express';
import path from 'path';
import { runDoctor } from './index.js';
import { readAstroConfigFacts } from './project.js';

const DEFAULT_SCAN_TIMEOUT_MS = 3000;

/**
 * @typedef {Object} EditorDoctorResult
 * @property {'ok'|'unavailable'} status
 * @property {string} commit
 * @property {string} checkedAt - ISO time
 * @property {number} durationMs - how long the scan held up the publish
 * @property {string} [reason] - why it is unavailable
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

/**
 * The build's output directory: an explicit --outDir in the check command,
 * else astro.config's outDir, else Astro's default.
 * @param {string} command
 * @param {string|null} configOutDir
 */
export function outDirFor(command, configOutDir) {
  const match = command.match(/--outDir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (match) return match[1] || match[2] || match[3];
  return configOutDir || 'dist';
}

function summarise(report) {
  const coverageResult = report.results.find((result) => result.id === 'click-to-edit-coverage');
  const coverageData = coverageResult?.data;
  return {
    coverage: coverageData && coverageData.totalFields > 0
      ? { covered: coverageData.coveredFields, total: coverageData.totalFields, byCollection: coverageData.byCollection }
      : null,
    // The per-entry lists can be long; the notice links to the CLI for those.
    results: report.results.map(({ data, ...rest }) => rest),
  };
}

/**
 * Run the built-HTML checks on a publish check's build and record the result.
 * Never throws.
 * @param {Object} fullConfig - getConfig() result
 * @param {{siteDir: string, commit: string, command: string}} build
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @param {() => Promise<{entries: Array}>} [options.loadEntries]
 */
export async function recordDoctorAfterCheck(fullConfig, build, { timeoutMs = DEFAULT_SCAN_TIMEOUT_MS, loadEntries = null } = {}) {
  if (fullConfig.doctor?.enabled === false) return;
  const generation = ++scanGeneration;
  const startedAt = Date.now();
  const checkedAt = new Date(startedAt).toISOString();
  const record = (result) => {
    if (generation === scanGeneration) latestResult = { commit: build.commit, checkedAt, durationMs: Date.now() - startedAt, ...result };
  };
  let timer;
  try {
    const facts = await readAstroConfigFacts(build.siteDir);
    const distDir = path.resolve(build.siteDir, outDirFor(build.command, facts.outDir));
    // Entries are loaded up front so a store or schema error makes the result
    // unavailable, rather than a report of checks that could not run.
    const scan = (async () => {
      const loaded = await (loadEntries || (async () => (await import('./entries.js')).collectEntries()))();
      return runDoctor({ projectRoot: fullConfig.paths.projectRoot, distDir, build: false, phases: ['built'], loadEntries: async () => loaded });
    })();
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const report = await Promise.race([scan, timeout]);
    // A scan that outlives the cap keeps running against a directory about to
    // be deleted; whatever it then produces is discarded, errors included.
    scan.catch(() => {});
    if (!report) {
      console.warn(`Doctor scan skipped: it did not finish within ${timeoutMs} ms`);
      record({ status: 'unavailable', reason: `The scan did not finish within ${timeoutMs} ms.` });
      return;
    }
    record({ status: 'ok', ...summarise(report) });
  } catch (error) {
    console.warn('Doctor scan unavailable:', error.message);
    record({ status: 'unavailable', reason: error.message });
  } finally {
    clearTimeout(timer);
  }
}

const router = express.Router();

/** GET /api/doctor/latest — the latest built-HTML check result, or null. */
router.get('/latest', (req, res) => {
  res.json({ success: true, result: getLatestDoctorResult() });
});

export default router;
