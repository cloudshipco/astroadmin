/**
 * astroadmin doctor: run the checks in ./checks.js against a site and report.
 *
 * Used by the CLI (`astroadmin doctor`) and, for the built-HTML checks only,
 * by the editor after a publish check has built the commit (./editor.js).
 */

import { createRequire } from 'module';
import { CHECKS, DOCS_BASE, NO_HTML_MESSAGE } from './checks.js';
import { listBuiltPagePaths, scanBuiltPages } from './html-scan.js';
import { readAstroConfigFacts } from './project.js';

const require = createRequire(import.meta.url);
const { version: ASTROADMIN_VERSION } = require('../../package.json');

/** Every check definition, with its docs link. */
export const DOCTOR_CHECKS = CHECKS.map((definition) => ({ ...definition, docs: `${DOCS_BASE}#${definition.id}` }));

const PHASES = ['static', 'build', 'built'];

/** runDoctor's rejection when its signal aborts (the CLI exits 128 + signal). */
export class DoctorInterrupted extends Error {
  constructor() {
    super('The doctor was interrupted.');
    this.name = 'DoctorInterrupted';
    /** Set when its build had started, and was then stopped and removed. */
    this.buildRemoved = false;
  }
}

/**
 * SIGKILL each process group, then wait (up to 2 s) until none of its
 * members is left, so nothing writes after the caller removes its folder.
 * @param {number[]} groupIds
 */
async function killProcessGroups(groupIds) {
  const alive = (groupId) => {
    try {
      process.kill(-groupId, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (const groupId of groupIds) {
    try {
      process.kill(-groupId, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 2000;
  while (groupIds.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
}

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
 * @param {boolean} [options.editor=false] - the editor's post-publish scan:
 *   leave out the checks marked commandLineOnly
 * @param {() => Promise<{entries: Array}>} [options.loadEntries] - entries with page paths
 *   (default: the editor's store, via ./entries.js)
 * @param {AbortSignal} [options.signal] - aborting it (the CLI does on SIGINT
 *   and SIGTERM) kills the build's process group, removes the build folder
 *   and rejects with DoctorInterrupted
 * @returns {Promise<{version: string, projectRoot: string, ok: boolean, counts: Object, results: DoctorResult[]}>}
 */
export async function runDoctor({ projectRoot, distDir = null, build = true, phases = PHASES, loadEntries = null, editor = false, signal = null }) {
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
    // Process groups the checks started (the build): killed on interrupt.
    processGroups: [],
    astroConfig: () => remember('astroConfig', () => readAstroConfigFacts(projectRoot)),
    built: () => remember('built', async () => {
      // A build with no HTML (an empty or missing directory) has nothing to
      // check; every built check says so rather than reporting a clean result.
      const builtPagePaths = await listBuiltPagePaths(context.distDir);
      if (builtPagePaths.length === 0) throw new Error(NO_HTML_MESSAGE);
      const load = loadEntries || (async () => (await import('./entries.js')).collectEntries());
      const { entries } = await load();
      // Every built page, not only the entries' own: the link check and the
      // unsupported-card warning apply to pages no entry owns too.
      const pages = await scanBuiltPages(context.distDir, [...entries.map((entry) => entry.pagePath), ...builtPagePaths]);
      return { entries, pages };
    }),
  };

  // Settles (rejects) only when the signal aborts: raced against each check,
  // since a build whose descendants hold its pipes open may never settle.
  const interrupted = signal
    ? new Promise((resolve, reject) => {
      if (signal.aborted) reject(new DoctorInterrupted());
      else signal.addEventListener('abort', () => reject(new DoctorInterrupted()), { once: true });
    })
    : null;
  interrupted?.catch(() => {}); // handled where it is raced

  const results = [];
  let failure = null;
  try {
    for (const definition of DOCTOR_CHECKS) {
      if (!phases.includes(definition.phase)) continue;
      if (editor && definition.commandLineOnly) continue;
      let outcome;
      try {
        outcome = await (interrupted ? Promise.race([definition.run(context), interrupted]) : definition.run(context));
      } catch (error) {
        if (error instanceof DoctorInterrupted) throw error;
        outcome = { severity: 'warn', title: `${definition.title} (could not run)`, message: `The check could not run: ${error.message}` };
      }
      // A warn or fail is reported by a title that states the problem (the
      // editor's notice lists failing checks by title alone).
      const failing = outcome.severity === 'warn' || outcome.severity === 'fail';
      results.push({
        id: definition.id,
        title: failing ? (outcome.title || definition.problemTitle || definition.title) : definition.title,
        since: definition.since,
        severity: outcome.severity,
        message: outcome.message,
        details: outcome.details || [],
        docs: definition.docs,
        ...(outcome.data ? { data: outcome.data } : {}),
      });
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Stop a build still running before removing its folder, or it writes
    // into the site after the doctor has gone.
    if (signal?.aborted) await killProcessGroups(context.processGroups);
    for (const cleanup of context.cleanups) await cleanup().catch(() => {});
    // The CLI says a build was stopped and removed only when one had started.
    if (failure instanceof DoctorInterrupted) failure.buildRemoved = context.cleanups.length > 0;
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
