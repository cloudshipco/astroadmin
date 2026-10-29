/**
 * The production build Publish runs before a deploy adapter uploads `dist/`:
 * `build.production` if configured, else the site's own installed astro
 * (server/utils/astro-bin.js). The only production build runner; the
 * publish check's build is a separate one, in a worktree
 * (server/utils/astro-check.js).
 *
 * It runs through the check's runCommand: in its own process group, killed
 * whole at `build.productionTimeoutMs` (default five minutes), its output
 * capped, and without the admin's own secrets and settings in its
 * environment (buildEnvironment), except ASTROADMIN_DB, which the site's
 * loader reads.
 */

import { config, getConfig } from '../config.js';
import { resolveBuildCommand } from './astro-bin.js';
import { buildEnvironment, runCommand } from './astro-check.js';

const DEFAULT_PRODUCTION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The admin's own variables the SITE legitimately reads when it builds for
 * deployment: ASTROADMIN_DB is where the shelved db store's loader
 * (loader/index.js) finds content. buildEnvironment() removes every
 * ASTROADMIN_* variable, and without this one a site with a custom DB path
 * built empty collections, which rsync --delete then made live. Not the
 * publish check's build: that builds a commit in a worktree.
 */
const SITE_BUILD_VARIABLES = ['ASTROADMIN_DB'];

/** buildEnvironment() plus SITE_BUILD_VARIABLES. */
function productionBuildEnvironment() {
  const environment = buildEnvironment();
  for (const name of SITE_BUILD_VARIABLES) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

/**
 * Run the production build for deployment.
 *
 * `output` is the build's raw output, for the server (it is logged here):
 * it names server paths, so a response carries publish.js
 * buildResultForEditor() of this result, never the result itself. `error` is
 * always a sentence we wrote.
 * @returns {Promise<{success: boolean, duration: number, output?: string, error?: string}>}
 */
export async function runProductionBuild() {
  return runProductionBuildIn(await getConfig(), config.paths.projectRoot);
}

/**
 * Run the production build of the site in projectRoot: `build.production`, else
 * the site's own installed astro (never a fetched one; refused when missing).
 * @param {Object} fullConfig - getConfig() result
 * @param {string} projectRoot
 * @returns {Promise<{success: boolean, duration: number, output?: string, error?: string}>}
 */
export async function runProductionBuildIn(fullConfig, projectRoot) {
  console.log('🔨 Starting production build for deployment...');
  const startTime = Date.now();
  const timeoutMs = fullConfig.build?.productionTimeoutMs || DEFAULT_PRODUCTION_TIMEOUT_MS;

  try {
    const { command: buildCommand, error } = await resolveBuildCommand(fullConfig.build?.production, 'production', projectRoot);
    if (!buildCommand) {
      console.error('❌ Production build not run:', error);
      return { success: false, duration: Date.now() - startTime, error, output: '' };
    }

    const { exitCode, output, timedOut } = await runCommand(buildCommand, projectRoot, timeoutMs, productionBuildEnvironment());
    const duration = Date.now() - startTime;

    if (exitCode === 0 && !timedOut) {
      console.log(`✅ Production build completed in ${duration}ms. Its output:\n${output}`);
      return { success: true, duration, output: output.slice(-1000) };
    }

    console.error(`❌ Production build ${timedOut ? `timed out after ${timeoutMs}ms` : `failed with exit code ${exitCode}`}. Its output:\n${output}`);
    return {
      success: false,
      duration,
      // Never the command line, which holds server paths. The output is what
      // says why.
      error: timedOut ? 'The build command did not finish in time.' : 'The build command failed.',
      output,
    };
  } catch (error) {
    // The shell could not be started at all.
    console.error('❌ Production build could not start:', error);
    return { success: false, duration: Date.now() - startTime, error: 'The build command failed.', output: '' };
  }
}
