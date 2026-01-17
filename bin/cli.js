#!/usr/bin/env bun

/**
 * AstroAdmin CLI
 * Command-line interface for running the admin server
 *
 * Usage:
 *   npx astroadmin dev              # Start on auto-selected port
 *   npx astroadmin dev --project .  # Explicit project path
 *   npx astroadmin dev -p 3030      # Specific port
 *   npx astroadmin dev --no-astro   # Don't start Astro dev server
 */

import { Command } from 'commander';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import net from 'net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Track spawned Astro process for cleanup
let astroProcess = null;

/**
 * Check if a port is in use (i.e., a server is listening on it)
 * @param {number} port - Port to check
 * @returns {Promise<boolean>} - True if something is listening on the port
 */
function checkPort(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.connect(port, 'localhost');
  });
}

/**
 * Wait for a port to become available (something listening)
 * @param {number} port - Port to wait for
 * @param {number} timeout - Maximum time to wait in ms
 * @returns {Promise<boolean>} - True if port became available
 */
async function waitForPort(port, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await checkPort(port)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for port ${port}`);
}

/**
 * Clean up spawned processes on exit
 */
function cleanup() {
  if (astroProcess) {
    console.log('\n🛑 Stopping Astro dev server...');
    astroProcess.kill('SIGTERM');
    astroProcess = null;
  }
  process.exit(0);
}

// Register cleanup handlers
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

/**
 * Start the Astro dev server if not already running
 * @param {string} projectRoot - Path to the Astro project
 * @param {string} previewUrl - Preview URL from config
 * @returns {Promise<void>}
 */
async function maybeStartAstro(projectRoot, previewUrl) {
  // Extract port from preview URL
  const portMatch = previewUrl.match(/:(\d+)/);
  const previewPort = portMatch ? parseInt(portMatch[1], 10) : 4321;

  // Check if Astro is already running
  const isRunning = await checkPort(previewPort);
  if (isRunning) {
    console.log(`📡 Astro dev server already running on port ${previewPort}`);
    return;
  }

  console.log('🚀 Starting Astro dev server...');

  // Spawn Astro dev server
  astroProcess = spawn('npm', ['run', 'dev'], {
    cwd: projectRoot,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: true,
  });

  // Prefix Astro output for clarity
  astroProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach((line) => {
      if (line.trim()) {
        process.stdout.write(`[astro] ${line}\n`);
      }
    });
  });

  astroProcess.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach((line) => {
      if (line.trim()) {
        process.stderr.write(`[astro] ${line}\n`);
      }
    });
  });

  astroProcess.on('error', (err) => {
    console.error(`❌ Failed to start Astro: ${err.message}`);
    astroProcess = null;
  });

  astroProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[astro] Process exited with code ${code}`);
    }
    astroProcess = null;
  });

  // Wait for Astro to be ready
  try {
    await waitForPort(previewPort, 30000);
    console.log('✅ Astro dev server ready\n');
  } catch (err) {
    console.error(`❌ Astro dev server failed to start within 30 seconds`);
    if (astroProcess) {
      astroProcess.kill('SIGTERM');
      astroProcess = null;
    }
    throw new Error('Astro dev server startup timeout');
  }
}

const program = new Command();

program
  .name('astroadmin')
  .description('Admin interface for Astro Content Collections')
  .version('0.1.0');

program
  .command('dev')
  .description('Start admin development server')
  .option('-p, --port <port>', 'Port to run on (default: from PORT env or auto)')
  .option('-H, --host <host>', 'Host to bind to (default: from HOST env or localhost)')
  .option('--project <path>', 'Astro project root directory', process.cwd())
  .option('--no-astro', 'Do not start Astro dev server automatically')
  .action(async (options) => {
    try {
      // Resolve project path and set environment variable
      const projectRoot = path.resolve(options.project);
      process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;

      console.log(`\n📁 Project root: ${projectRoot}`);

      // Dynamic import to ensure PROJECT_ROOT is set before config loads
      const { validateProject, config } = await import('../server/config.js');

      // Validate project structure
      const validation = await validateProject();
      if (!validation.valid) {
        console.error('\n❌ Invalid Astro project:\n');
        validation.errors.forEach(err => {
          console.error(`   • ${err.message}`);
          if (err.hint) {
            console.error(`     → ${err.hint}`);
          }
        });
        console.error('\nAstroAdmin requires Astro Content Collections.');
        console.error('See: https://github.com/cloudshipco/astroadmin/blob/main/docs/requirements.md\n');
        process.exit(1);
      }

      // Start Astro dev server if --no-astro was not specified
      if (options.astro !== false) {
        await maybeStartAstro(projectRoot, config.preview.url);
      }

      // Start server
      const { startServer } = await import('../server/index.js');
      await startServer(options);
    } catch (error) {
      console.error('❌ Failed to start server:', error.message);
      if (process.env.DEBUG) {
        console.error(error.stack);
      }
      cleanup();
    }
  });

program
  .command('start')
  .description('Start admin server (alias for dev)')
  .option('-p, --port <port>', 'Port to run on (default: from PORT env or auto)')
  .option('-H, --host <host>', 'Host to bind to (default: from HOST env or localhost)')
  .option('--project <path>', 'Astro project root directory', process.cwd())
  .option('--no-astro', 'Do not start Astro dev server automatically')
  .action(async (options) => {
    // Same as dev
    const projectRoot = path.resolve(options.project);
    process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;

    console.log(`\n📁 Project root: ${projectRoot}`);

    try {
      const { validateProject, config } = await import('../server/config.js');

      const validation = await validateProject();
      if (!validation.valid) {
        console.error('\n❌ Invalid Astro project:\n');
        validation.errors.forEach(err => {
          console.error(`   • ${err.message}`);
          if (err.hint) {
            console.error(`     → ${err.hint}`);
          }
        });
        console.error('\nAstroAdmin requires Astro Content Collections.');
        console.error('See: https://github.com/cloudshipco/astroadmin/blob/main/docs/requirements.md\n');
        process.exit(1);
      }

      // Start Astro dev server if --no-astro was not specified
      if (options.astro !== false) {
        await maybeStartAstro(projectRoot, config.preview.url);
      }

      const { startServer } = await import('../server/index.js');
      await startServer(options);
    } catch (error) {
      console.error('❌ Failed to start server:', error.message);
      cleanup();
    }
  });

// If no command specified, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
  process.exit(0);
}

program.parse();
