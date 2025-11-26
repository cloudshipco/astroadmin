/**
 * Build API Router
 * Trigger Astro builds for staging and production
 */

import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { config, IS_DEV } from '../config.js';

const execAsync = promisify(exec);
const router = express.Router();

/**
 * Execute build command
 */
async function runBuild(command, label) {
  console.log(`🔨 Starting ${label} build...`);
  const startTime = Date.now();

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

    const result = await runBuild(config.build.staging, 'Staging');

    res.json({
      ...result,
      message: result.success
        ? 'Staging build completed successfully'
        : 'Staging build failed',
      command: config.build.staging,
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
    const result = await runBuild(config.build.production, 'Production');

    res.json({
      ...result,
      message: result.success
        ? 'Production build completed successfully'
        : 'Production build failed',
      command: config.build.production,
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
router.get('/status', (req, res) => {
  res.json({
    success: true,
    environment: IS_DEV ? 'development' : 'production',
    staging: {
      command: config.build.staging,
      previewUrl: config.preview.url,
      method: config.preview.method,
    },
    production: {
      command: config.build.production,
    },
  });
});

export default router;
