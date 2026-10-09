/**
 * astroadmin doctor: run the checks in ./checks.js against a site and report.
 *
 * Used by the CLI (`astroadmin doctor`) and, for the built-HTML checks only,
 * by the editor after a publish check has built the commit (./editor.js).
 */

import { createRequire } from 'module';
import { CHECKS, DOCS_BASE } from './checks.js';
import { listBuiltPagePaths, scanBuiltPages } from './html-scan.js';
import { readAstroConfigFacts } from './project.js';

const require = createRequire(import.meta.url);
const { version: ASTROADMIN_VERSION } = require('../../package.json');

/** Every check definition, with its docs link. */
export const DOCTOR_CHECKS = CHECKS.map((definition) => ({ ...definition, docs: `${DOCS_BASE}#${definition.id}` }));

const PHASES = ['static', 'build', 'built'];

/**
 * One check's outcome.
 * @typedef {Object} DoctorResult
 * @property {string} id
 * @property {string} title
 * @property {string} since - the astroadmin version that introduced the feature
 * @property {import('./checks.js').Severity} severity
 * @property {string} message
 * @property {string[]} details
 * @property {string} docs
 * @property {Object} [data] - the raw report, for a dashboard
 */

/**
 * @param {Object} options
 * @param {string} options.projectRoot
 * @param {string|null} [options.distDir] - an existing build to read instead of building
 * @param {boolean} [options.build=true] - build into a temp dir when no distDir is given
 * @param {string[]} [options.phases] - which phases to run (default: all)
 * @param {() => Promise<{entries: Array}>} [options.loadEntries] - entries with page paths
 *   (default: the editor's store, via ./entries.js)
 * @returns {Promise<{version: string, projectRoot: string, ok: boolean, counts: Object, results: DoctorResult[]}>}
 */
export async function runDoctor({ projectRoot, distDir = null, build = true, phases = PHASES, loadEntries = null }) {
  const memo = new Map();
  const remember = (key, compute) => {
    if (!memo.has(key)) memo.set(key, compute());
    return memo.get(key);
  };
  const context = {
    projectRoot,
    distDir,
    build,
    buildSkippedReason: null,
    cleanups: [],
    astroConfig: () => remember('astroConfig', () => readAstroConfigFacts(projectRoot)),
    built: () => remember('built', async () => {
      const load = loadEntries || (async () => (await import('./entries.js')).collectEntries());
      const { entries } = await load();
      // Every built page, not only the entries' own: a page no entry owns can
      // still show other entries' cards (data-aa-entry).
      const pagePaths = entries.map((entry) => entry.pagePath).filter(Boolean);
      const pages = await scanBuiltPages(context.distDir, [...pagePaths, ...await listBuiltPagePaths(context.distDir)]);
      return { entries, pages };
    }),
  };

  const results = [];
  try {
    for (const definition of DOCTOR_CHECKS) {
      if (!phases.includes(definition.phase)) continue;
      let outcome;
      try {
        outcome = await definition.run(context);
      } catch (error) {
        outcome = { severity: 'warn', message: `The check could not run: ${error.message}` };
      }
      results.push({
        id: definition.id,
        title: definition.title,
        since: definition.since,
        severity: outcome.severity,
        message: outcome.message,
        details: outcome.details || [],
        docs: definition.docs,
        ...(outcome.data ? { data: outcome.data } : {}),
      });
    }
  } finally {
    for (const cleanup of context.cleanups) await cleanup().catch(() => {});
  }

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const result of results) counts[result.severity] = (counts[result.severity] || 0) + 1;
  return { version: ASTROADMIN_VERSION, projectRoot, ok: counts.fail === 0, counts, results };
}

const SYMBOLS = { pass: '✓', warn: '!', fail: '✗', skip: '-' };

/** The report as terminal text. */
export function formatReport(report) {
  const lines = [`astroadmin doctor ${report.version} — ${report.projectRoot}`, ''];
  for (const result of report.results) {
    lines.push(`${SYMBOLS[result.severity]} ${result.severity.toUpperCase().padEnd(4)} ${result.title} (since ${result.since})`);
    lines.push(`       ${result.message}`);
    for (const detail of result.details) {
      for (const detailLine of String(detail).split('\n')) lines.push(`         ${detailLine}`);
    }
    if (result.severity === 'warn' || result.severity === 'fail') lines.push(`       ${result.docs}`);
  }
  const { pass, warn, fail, skip } = report.counts;
  lines.push('', `${pass} passed, ${warn} warnings, ${fail} failed, ${skip} skipped.`);
  return lines.join('\n');
}
