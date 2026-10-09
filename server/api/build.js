/**
 * Build API Router
 * Trigger Astro builds for staging and production
 */

import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { config, getConfig, IS_DEV } from '../config.js';
import { DEFAULT_BUILD_ARGS, resolveBuildCommand } from '../utils/astro-bin.js';

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

/** What the status endpoint shows for a build: the configured command, or the default's description. */
async function describeBuildCommand(kind) {
  const fullConfig = await getConfig();
  return fullConfig.build?.[kind] || `astro ${DEFAULT_BUILD_ARGS[kind].join(' ')} (the site's installed astro)`;
}

/**
 * Execute build command
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
    console.log(`✅ ${label} build completed in ${duration}ms`);

    return {
      success: true,
      duration,
      stdout: stdout.slice(-1000), // Last 1000 chars
      stderr: stderr.slice(-1000),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ ${label} build failed:`, error.message);

    return {
      success: false,
      duration,
      error: error.message,
      stdout: error.stdout?.slice(-1000),
      stderr: error.stderr?.slice(-1000),
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
      // The description, not the resolved command line, which holds server paths.
      command: await describeBuildCommand('staging'),
    });
  } catch (error) {
    console.error('Error triggering staging build:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to trigger staging build',
      message: error.message,
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
      command: await describeBuildCommand('production'),
    });
  } catch (error) {
    console.error('Error triggering production build:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to trigger production build',
      message: error.message,
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
        command: await describeBuildCommand('staging'),
        previewUrl: config.preview.url,
        method: config.preview.method,
      },
      production: {
        command: await describeBuildCommand('production'),
      },
    });
  } catch (error) {
    console.error('Error reading build status:', error);
    res.status(500).json({ success: false, error: 'Failed to read build status', message: error.message });
  }
});

export default router;
