/**
 * Deploy Utilities
 * Adapters for deploying built sites to various destinations
 */

import { spawn } from 'child_process';
import path from 'path';

/**
 * Deploy using rsync (local or remote over SSH)
 *
 * @param {Object} rsyncConfig - rsync configuration
 * @param {string} rsyncConfig.path - Destination path (local or remote)
 * @param {string} [rsyncConfig.host] - Remote hostname or IP (omit for local deploy)
 * @param {string} [rsyncConfig.user] - SSH username (required if host is set)
 * @param {number} [rsyncConfig.port=22] - SSH port
 * @param {string} [rsyncConfig.keyPath] - Path to SSH private key
 * @param {string[]} [rsyncConfig.exclude=[]] - Patterns to exclude
 * @param {boolean} [rsyncConfig.dryRun=false] - Test mode without changes
 * @param {string} projectRoot - Path to the project root
 * @returns {Promise<{success: boolean, output: string, local: boolean}>}
 */
export async function rsyncDeploy(rsyncConfig, projectRoot) {
  // Validate required fields
  if (!rsyncConfig.path) {
    throw new Error(`rsync deploy: missing required field 'path'`);
  }

  // Determine if this is a local or remote deployment
  const isLocal = !rsyncConfig.host;

  // For remote deploys, user is required
  if (!isLocal && !rsyncConfig.user) {
    throw new Error(`rsync deploy: 'user' is required when 'host' is specified`);
  }

  const args = [
    '-av',       // archive, verbose
    '--delete',  // remove files at destination that don't exist in source
  ];

  // Only add compression for remote transfers
  if (!isLocal) {
    args.push('-z');  // compress

    // Build SSH command with port and optional key
    const sshPort = rsyncConfig.port || 22;
    let sshCommand = `ssh -p ${sshPort}`;

    if (rsyncConfig.keyPath) {
      // Expand ~ to home directory
      const keyPath = rsyncConfig.keyPath.replace(/^~/, process.env.HOME || '');
      sshCommand += ` -i ${keyPath}`;
    }

    // Add strict host key checking option for automation
    sshCommand += ' -o StrictHostKeyChecking=accept-new';

    args.push('-e', sshCommand);
  }

  // Add exclude patterns
  if (rsyncConfig.exclude && Array.isArray(rsyncConfig.exclude)) {
    for (const pattern of rsyncConfig.exclude) {
      args.push('--exclude', pattern);
    }
  }

  // Dry run mode for testing
  if (rsyncConfig.dryRun) {
    args.push('--dry-run');
  }

  // Source: dist directory (with trailing slash to copy contents)
  const distPath = path.join(projectRoot, 'dist') + '/';

  // Destination: local path or user@host:path
  const destination = isLocal
    ? rsyncConfig.path
    : `${rsyncConfig.user}@${rsyncConfig.host}:${rsyncConfig.path}`;

  args.push(distPath, destination);

  const targetDescription = isLocal
    ? rsyncConfig.path
    : `${rsyncConfig.host}:${rsyncConfig.path}`;

  console.log(`🚀 Starting rsync deploy to ${targetDescription}${isLocal ? ' (local)' : ''}`);
  if (rsyncConfig.dryRun) {
    console.log('   (dry-run mode - no changes will be made)');
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
      // Log progress in real-time
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
        console.log(`✅ rsync deploy completed successfully`);
        resolve({
          success: true,
          output: output.slice(-2000), // Limit output size
          dryRun: rsyncConfig.dryRun || false,
          local: isLocal,
        });
      } else {
        console.error(`❌ rsync deploy failed with exit code ${code}`);
        reject(new Error(`rsync failed with exit code ${code}:\n${output.slice(-2000)}`));
      }
    });
  });
}

/**
 * Run deployment based on configured adapter
 *
 * @param {Object} deployConfig - Deploy configuration from astroadmin.config.js
 * @param {string} deployConfig.adapter - Adapter name ('rsync', etc.)
 * @param {Object} deployConfig.rsync - rsync-specific configuration
 * @param {string} projectRoot - Path to the project root
 * @returns {Promise<{success: boolean, adapter: string, output: string}>}
 */
export async function deploy(deployConfig, projectRoot) {
  if (!deployConfig?.adapter) {
    return { success: true, skipped: true, message: 'No deploy adapter configured' };
  }

  const adapterName = deployConfig.adapter.toLowerCase();

  switch (adapterName) {
    case 'rsync':
      if (!deployConfig.rsync) {
        throw new Error('rsync adapter configured but rsync options missing');
      }
      const result = await rsyncDeploy(deployConfig.rsync, projectRoot);
      return {
        ...result,
        adapter: 'rsync',
      };

    // Future adapters can be added here:
    // case 's3':
    //   return s3Deploy(deployConfig.s3, projectRoot);
    // case 'ftp':
    //   return ftpDeploy(deployConfig.ftp, projectRoot);
    // case 'vercel':
    //   return vercelDeploy(deployConfig.vercel, projectRoot);
    // case 'netlify':
    //   return netlifyDeploy(deployConfig.netlify, projectRoot);

    default:
      throw new Error(`Unknown deploy adapter: ${adapterName}. Supported: rsync`);
  }
}

/**
 * Validate deploy configuration without running deployment
 *
 * @param {Object} deployConfig - Deploy configuration
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateDeployConfig(deployConfig) {
  const errors = [];

  if (!deployConfig?.adapter) {
    return { valid: true, errors: [] }; // No deployment configured is valid
  }

  const adapterName = deployConfig.adapter.toLowerCase();

  switch (adapterName) {
    case 'rsync':
      if (!deployConfig.rsync) {
        errors.push('rsync adapter configured but rsync options missing');
      } else {
        const { host, user, path: destPath } = deployConfig.rsync;
        if (!destPath) errors.push('rsync.path is required');
        // user is only required for remote deploys (when host is set)
        if (host && !user) errors.push('rsync.user is required when host is specified');
      }
      break;

    default:
      errors.push(`Unknown deploy adapter: ${adapterName}. Supported: rsync`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
