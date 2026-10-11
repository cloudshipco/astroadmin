/**
 * Build utility
 * Runs the configured Astro production build (under Bun, so the content-layer
 * loader's `bun:sqlite` import works). Shared by the publish pipeline.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { config, getConfig } from '../config.js';
import { resolveBuildCommand } from './astro-bin.js';

const execAsync = promisify(exec);

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

  try {
    const { command: buildCommand, error } = await resolveBuildCommand(fullConfig.build?.production, 'production', projectRoot);
    if (!buildCommand) {
      console.error('❌ Production build not run:', error);
      return { success: false, duration: Date.now() - startTime, error, output: '' };
    }

    const { stdout, stderr } = await execAsync(buildCommand, {
      cwd: projectRoot,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    const duration = Date.now() - startTime;
    console.log(`✅ Production build completed in ${duration}ms. Its output:\n${stdout}${stderr}`);

    return {
      success: true,
      duration,
      output: (stdout + stderr).slice(-1000),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ Production build failed: ${error.message}\nIts output:\n${error.stdout || ''}${error.stderr || ''}`);

    return {
      success: false,
      duration,
      // Not error.message: it is `Command failed: <resolved command line>`,
      // which holds server paths. The output is what says why.
      error: 'The build command failed.',
      output: (error.stdout || '') + (error.stderr || ''),
    };
  }
}
