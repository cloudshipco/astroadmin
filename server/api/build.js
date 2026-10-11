/**
 * Build API Router
 * Trigger Astro builds for staging and production
 */

import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { config, getConfig, IS_DEV } from '../config.js';
import { resolveBuildCommand } from '../utils/astro-bin.js';
import { buildProblems } from '../utils/build-failure.js';

const execAsync = promisify(exec);
const router = express.Router();

/**
 * The command a build runs, as configured (astroadmin.config.js), else the
 * site's own installed astro. Never a package runner.
 * @param {'staging'|'production'} kind
 */
async function buildCommandFor(kind) {
  const fullConfig = await getConfig();
  return resolveBuildCommand(fullConfig.build?.[kind], kind, config.paths.projectRoot);
}

/**
 * What a response says a build runs: a fixed description. Not the configured
 * command line, which can name a script by its server path.
 * @param {'staging'|'production'} kind
 */
function describeBuildCommand(kind) {
  return `the site's ${kind} build`;
}

/**
 * Run a build. The result carries no output: a build's output names server
 * paths, so it goes to the server log, and a failure carries a fixed error
 * plus the problems its output names as error codes (build-failure.js).
 */
async function runBuild(kind, label) {
  console.log(`🔨 Starting ${label} build...`);
  const startTime = Date.now();
  const { command, error } = await buildCommandFor(kind);
  if (!command) {
    console.error(`❌ ${label} build not run:`, error);
    return { success: false, duration: 0, error };
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: config.paths.projectRoot,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
    });

    const duration = Date.now() - startTime;
    console.log(`✅ ${label} build completed in ${duration}ms. Its output:\n${stdout}${stderr}`);

    return { success: true, duration };
  } catch (error) {
    const duration = Date.now() - startTime;
    const output = `${error.stdout || ''}${error.stderr || ''}`;
    console.error(`❌ ${label} build failed: ${error.message}\nIts output:\n${output}`);

    return {
      success: false,
      duration,
      // Not error.message: it is `Command failed: <resolved command line>`.
      error: 'The build failed; its output is in the server log.',
      problems: buildProblems(output),
    };
  }
}

/**
 * POST /api/build/staging
 * Trigger staging build
 */
router.post('/staging', async (req, res) => {
  try {
    if (IS_DEV) {
      // In development, no build needed - dev server handles it
      return res.json({
        success: true,
        message: 'Development mode - no build needed. Dev server handles hot reload.',
        devMode: true,
      });
    }

    const result = await runBuild('staging', 'Staging');

    res.json({
      ...result,
      message: result.success
        ? 'Staging build completed successfully'
        : 'Staging build failed',
      command: describeBuildCommand('staging'),
    });
  } catch (error) {
    console.error('Error triggering staging build:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to trigger staging build',
      message: 'The staging build could not be started; see the server log.',
    });
  }
});

/**
 * POST /api/build/production
 * Trigger production build
 */
router.post('/production', async (req, res) => {
  try {
    const result = await runBuild('production', 'Production');

    res.json({
      ...result,
      message: result.success
        ? 'Production build completed successfully'
        : 'Production build failed',
      command: describeBuildCommand('production'),
    });
  } catch (error) {
    console.error('Error triggering production build:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to trigger production build',
      message: 'The production build could not be started; see the server log.',
    });
  }
});

/**
 * GET /api/build/status
 * Get build configuration and status
 */
router.get('/status', async (req, res) => {
  try {
    res.json({
      success: true,
      environment: IS_DEV ? 'development' : 'production',
      staging: {
        command: describeBuildCommand('staging'),
        previewUrl: config.preview.url,
        method: config.preview.method,
      },
      production: {
        command: describeBuildCommand('production'),
      },
    });
  } catch (error) {
    console.error('Error reading build status:', error);
    res.status(500).json({ success: false, error: 'Failed to read build status', message: 'The build settings could not be read; see the server log.' });
  }
});

export default router;
