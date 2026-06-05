/**
 * rsync deploy adapter
 *
 * Syncs the built site (distDir) to a destination, local or remote over SSH.
 * Uses spawn (no shell) so user-supplied paths can't be interpreted as shell.
 *
 * Adapter interface:
 *   name
 *   validate(config) -> { valid, errors[] }
 *   deploy({ projectRoot, distDir, config, log }) -> { success, output, ... }
 */

import { spawn } from 'child_process';
import path from 'path';

/**
 * @param {object} config - rsync config block
 * @returns {{valid: boolean, errors: string[]}}
 */
function validate(config) {
  const errors = [];
  if (!config?.path) {
    errors.push('rsync.path is required');
  }
  // user is only required for remote deploys (when host is set)
  if (config?.host && !config?.user) {
    errors.push('rsync.user is required when rsync.host is specified');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * @param {object} args
 * @param {string} args.projectRoot - Project root directory
 * @param {string} args.distDir - Build output directory (relative to projectRoot)
 * @param {object} args.config - rsync config block
 * @param {(msg: string) => void} args.log - Log sink
 * @returns {Promise<{success: boolean, output: string, dryRun: boolean, local: boolean}>}
 */
function deploy({ projectRoot, distDir, config, log }) {
  if (!config.path) {
    throw new Error("rsync deploy: missing required field 'path'");
  }

  const isLocal = !config.host;

  if (!isLocal && !config.user) {
    throw new Error("rsync deploy: 'user' is required when 'host' is specified");
  }

  const args = [
    '-av', // archive, verbose
    '--delete', // remove files at destination not present in source
  ];

  if (!isLocal) {
    args.push('-z'); // compress for remote transfers

    const sshPort = config.port || 22;
    let sshCommand = `ssh -p ${sshPort}`;

    if (config.keyPath) {
      const keyPath = config.keyPath.replace(/^~/, process.env.HOME || '');
      sshCommand += ` -i ${keyPath}`;
    }

    sshCommand += ' -o StrictHostKeyChecking=accept-new';
    args.push('-e', sshCommand);
  }

  if (Array.isArray(config.exclude)) {
    for (const pattern of config.exclude) {
      args.push('--exclude', pattern);
    }
  }

  if (config.dryRun) {
    args.push('--dry-run');
  }

  // Source: build output dir with a trailing slash to copy its contents.
  const distPath = path.join(projectRoot, distDir) + '/';

  const destination = isLocal
    ? config.path
    : `${config.user}@${config.host}:${config.path}`;

  args.push(distPath, destination);

  const targetDescription = isLocal ? config.path : `${config.host}:${config.path}`;
  log(`🚀 Starting rsync deploy to ${targetDescription}${isLocal ? ' (local)' : ''}`);
  if (config.dryRun) {
    log('   (dry-run mode - no changes will be made)');
  }

  return new Promise((resolve, reject) => {
    const rsync = spawn('rsync', args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    rsync.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      process.stdout.write(chunk);
    });

    rsync.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      process.stderr.write(chunk);
    });

    rsync.on('error', (error) => {
      reject(new Error(`Failed to spawn rsync: ${error.message}`));
    });

    rsync.on('close', (code) => {
      const output = stdout + (stderr ? `\nStderr:\n${stderr}` : '');

      if (code === 0) {
        log('✅ rsync deploy completed successfully');
        resolve({
          success: true,
          output: output.slice(-2000),
          dryRun: config.dryRun || false,
          local: isLocal,
        });
      } else {
        reject(new Error(`rsync failed with exit code ${code}:\n${output.slice(-2000)}`));
      }
    });
  });
}

export const rsyncAdapter = {
  name: 'rsync',
  validate,
  deploy,
};
