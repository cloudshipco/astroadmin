/**
 * Build utility
 * Runs the configured Astro production build (under Bun, so the content-layer
 * loader's bun:sqlite import works). Shared by the publish pipeline.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { config, getConfig } from '../config.js';

const execAsync = promisify(exec);

/**
 * Run the production build for deployment.
 * @returns {Promise<{success: boolean, duration: number, output?: string, error?: string}>}
 */
export async function runProductionBuild() {
  console.log('🔨 Starting production build for deployment...');
  const startTime = Date.now();

  try {
    const fullConfig = await getConfig();
    const buildCommand = fullConfig.build?.production || 'bunx --bun astro build --outDir dist';

    const { stdout, stderr } = await execAsync(buildCommand, {
      cwd: config.paths.projectRoot,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    const duration = Date.now() - startTime;
    console.log(`✅ Production build completed in ${duration}ms`);

    return {
      success: true,
      duration,
      output: (stdout + stderr).slice(-1000),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('❌ Production build failed:', error.message);

    return {
      success: false,
      duration,
      error: error.message,
      output: (error.stdout || '') + (error.stderr || ''),
    };
  }
}
