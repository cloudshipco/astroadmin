#!/usr/bin/env node

/**
 * AstroAdmin CLI
 * Command-line interface for running the admin server
 *
 * Usage:
 *   npx astroadmin dev              # Start on auto-selected port
 *   npx astroadmin dev --project .  # Explicit project path
 *   npx astroadmin dev -p 3030      # Specific port
 */

import { Command } from 'commander';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const program = new Command();

program
  .name('astroadmin')
  .description('Admin interface for Astro Content Collections')
  .version('0.1.0');

program
  .command('dev')
  .description('Start admin development server')
  .option('-p, --port <port>', 'Port to run on (0 for auto)', '0')
  .option('-H, --host <host>', 'Host to bind to', 'localhost')
  .option('--project <path>', 'Astro project root directory', process.cwd())
  .action(async (options) => {
    try {
      // Resolve project path and set environment variable
      const projectRoot = path.resolve(options.project);
      process.env.ASTROADMIN_PROJECT_ROOT = projectRoot;

      console.log(`\n📁 Project root: ${projectRoot}`);

      // Dynamic import to ensure PROJECT_ROOT is set before config loads
      const { validateProject } = await import('../server/config.js');

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

      // Start server
      const { startServer } = await import('../server/index.js');
      await startServer(options);
    } catch (error) {
      console.error('❌ Failed to start server:', error.message);
      if (process.env.DEBUG) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program
  .command('start')
  .description('Start admin server (alias for dev)')
  .option('-p, --port <port>', 'Port to run on (0 for auto)', '0')
  .option('-H, --host <host>', 'Host to bind to', 'localhost')
  .option('--project <path>', 'Astro project root directory', process.cwd())
  .action(async (options) => {
    // Same as dev
    process.env.ASTROADMIN_PROJECT_ROOT = path.resolve(options.project);

    try {
      const { validateProject } = await import('../server/config.js');

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

      const { startServer } = await import('../server/index.js');
      await startServer(options);
    } catch (error) {
      console.error('❌ Failed to start server:', error.message);
      process.exit(1);
    }
  });

// If no command specified, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
  process.exit(0);
}

program.parse();
