/**
 * The editor's doctor scan, run in a CHILD PROCESS by ./editor.js after a
 * publish check has built a commit.
 *
 * Why a child process: the scan is mostly synchronous work (parsing the
 * content config, tokenising HTML, matching text), and a timer in the same
 * thread cannot fire until that work yields. Run in-process, a 10 ms cap
 * returned after 152 ms, and the publish waited for it while holding the git
 * lock. Here the parent owns the deadline and kills this process when it
 * passes.
 *
 * Why its own process root: the parent sets ASTROADMIN_PROJECT_ROOT to the
 * publish check's worktree, so the entries, schemas, routes and
 * astroadmin.config.js read here are the commit's, the same snapshot the HTML
 * was built from, not the live checkout an autosave may have changed since.
 *
 *   bun --no-install editor-scan.js '{"siteDir": "...", "command": "..."}'
 *
 * Prints one line, RESULT_MARKER followed by JSON: {ok: summary} or
 * {error: message}. Anything else on stdout (the editor's own logging) is
 * ignored by the parent.
 */

import path from 'path';
import { readAstroConfigFacts } from './project.js';

export const RESULT_MARKER = 'ASTROADMIN_DOCTOR_RESULT ';

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

/** What the editor keeps of a report: coverage totals and the checks without their raw data. */
export function summarise(report) {
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
 * @param {{siteDir: string, command: string}} input
 */
async function scan({ siteDir, command }) {
  const facts = await readAstroConfigFacts(siteDir);
  const distDir = path.resolve(siteDir, outDirFor(command, facts.outDir));
  const { listBuiltPagePaths } = await import('./html-scan.js');
  if ((await listBuiltPagePaths(distDir)).length === 0) throw new Error('The build has no HTML pages to scan.');
  // Loaded after ASTROADMIN_PROJECT_ROOT is in place (config reads it on import).
  const { collectEntries } = await import('./entries.js');
  const { runDoctor } = await import('./index.js');
  // Entries are loaded up front so a store or schema error makes the result
  // unavailable, rather than a report of checks that could not run.
  const loaded = await collectEntries();
  const report = await runDoctor({ projectRoot: siteDir, distDir, build: false, phases: ['built'], loadEntries: async () => loaded });
  return summarise(report);
}

if (import.meta.main) {
  let outcome;
  try {
    outcome = { ok: await scan(JSON.parse(process.argv[2] || '{}')) };
  } catch (error) {
    outcome = { error: String(error?.message || error) };
  }
  process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(outcome)}\n`);
  process.exit(0);
}
