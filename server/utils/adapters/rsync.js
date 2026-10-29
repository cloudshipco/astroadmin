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
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

const OVERRIDE_HINT = 'Point rsync.path at a directory that holds only the site, or set rsync.allowDestructivePath: true if this really is the destination.';

/** True when `candidate` is `root` or inside it (both absolute, resolved). */
function isSameOrInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/**
 * realpath() of a path that may not exist yet: the deepest existing ancestor
 * resolved, the rest re-appended. Synchronous: validation runs before any
 * request work and on paths of the site owner's config.
 */
function realpathAllowingMissing(targetPath) {
  const missingTail = [];
  let current = path.resolve(targetPath);
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missingTail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(targetPath);
      missingTail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Why a LOCAL destination is one `rsync --delete` must not be pointed at, or
 * null. Checked as written and with symlinks resolved. The sentences name no
 * path: validation errors reach the editor.
 * @param {string} destination - rsync.path, resolved as rsync resolves it
 *   (relative to the project root, its working directory)
 */
function localDestinationProblem(destination, { projectRoot, distDir }) {
  const candidates = [path.resolve(projectRoot || '.', destination)];
  candidates.push(realpathAllowingMissing(candidates[0]));
  const home = os.homedir();
  const homes = home ? [path.resolve(home), realpathAllowingMissing(home)] : [];
  for (const candidate of candidates) {
    if (path.dirname(candidate) === candidate) {
      return 'rsync.path is the filesystem root';
    }
    if (homes.some((homeDirectory) => isSameOrInside(candidate, homeDirectory))) {
      return 'rsync.path is the home directory or a directory above it';
    }
    if (!projectRoot) continue;
    for (const root of [path.resolve(projectRoot), realpathAllowingMissing(projectRoot)]) {
      if (isSameOrInside(candidate, root)) {
        return 'rsync.path is the project or a directory above it';
      }
      const dist = path.resolve(root, distDir || 'dist');
      if (isSameOrInside(dist, candidate)) {
        return 'rsync.path is the build output or inside it';
      }
      if (isSameOrInside(root, candidate)) {
        return "rsync.path is inside the project, among the site's own files";
      }
    }
  }
  return null;
}

/**
 * Why a REMOTE destination must not be synced with --delete, or null. Only
 * its spelling can be judged here: the filesystem root, a home directory and
 * anything above it. A relative path is relative to the remote user's home;
 * a leading `~` or `~name` (rsync sends it unescaped and the remote shell
 * expands it) is the remote user's or that user's home, so what follows it
 * is judged as home-relative too.
 */
function remoteDestinationProblem(destination) {
  const posix = path.posix;
  const isHomeRelative = !destination.startsWith('/');
  const withoutTilde = destination.replace(/^~[^/]*(?:\/|$)/, '');
  const normalized = isHomeRelative
    ? posix.normalize(withoutTilde === '' ? '.' : withoutTilde)
    : posix.normalize(destination);
  if (normalized === '/' || normalized === '//') {
    return 'rsync.path is the filesystem root';
  }
  if (isHomeRelative && (normalized === '.' || normalized === './' || normalized === '..' || normalized.startsWith('../'))) {
    return "rsync.path is the remote user's home directory or a directory above it";
  }
  return null;
}

/**
 * Why `rsync -av --delete` must not run against this destination, or null.
 * `allowDestructivePath: true` (the boolean) skips the check.
 */
function destinationProblem(config, context) {
  if (config.allowDestructivePath === true) return null;
  const destination = String(config.path);
  const problem = config.host
    ? remoteDestinationProblem(destination)
    : localDestinationProblem(destination, context);
  return problem ? `${problem}, and the deploy runs rsync --delete, which would remove everything there that is not in the build. ${OVERRIDE_HINT}` : null;
}

/** The SSH port as a whole number 1-65535, or null when it is not one. */
function sshPort(port) {
  if (port === undefined || port === null || port === '') return 22;
  const text = String(port);
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return number >= 1 && number <= 65535 ? number : null;
}

/**
 * A remote user name as rsync and ssh take it: letters, digits, `.`, `_`
 * and `-`, not starting with `-`. rsync hands `user@host` to ssh as ONE
 * argument (even after `--`), so a value starting with `-` would be an ssh
 * option such as -oProxyCommand.
 */
const REMOTE_USER = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

/**
 * A host name or IPv4 address (letters, digits, `.`, `-`, `_`, not starting
 * with `-`), or an IPv6 address in brackets, as rsync wants it in
 * `user@[2001:db8::1]:path`.
 */
function isRemoteHost(host) {
  const text = String(host);
  const bracketed = /^\[([^\]]+)\]$/.exec(text);
  if (bracketed) return net.isIPv6(bracketed[1]);
  return /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(text);
}

/**
 * rsync's own rule: a destination with a `:` before its first `/` is remote
 * (`host:dir`, `user@host:dir`, `host::module`, `rsync://host/...`).
 */
const LOOKS_REMOTE = /^[^/]*:/;

/**
 * One argument of rsync's `-e` command. rsync splits that string on spaces
 * itself and honours quotes: inside single quotes a doubled '' is one quote
 * (rsync(1), --rsh).
 */
function rshArgument(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * @param {object} config - rsync config block
 * @param {{projectRoot?: string, distDir?: string}} [context] - where the build
 *   is, for the destination check (without it only the root and home checks
 *   of a local destination run)
 * @returns {{valid: boolean, errors: string[]}}
 */
function validate(config, context = {}) {
  const errors = [];
  if (!config?.path) {
    errors.push('rsync.path is required');
  }
  // user is only required for remote deploys (when host is set)
  if (config?.host && !config?.user) {
    errors.push('rsync.user is required when rsync.host is specified');
  }
  if (config?.host && !isRemoteHost(config.host)) {
    errors.push('rsync.host must be a host name, an IPv4 address or an IPv6 address in brackets');
  }
  if (config?.host && config?.user && !REMOTE_USER.test(String(config.user))) {
    errors.push('rsync.user may hold only letters, digits, ".", "_" and "-", and must not start with "-"');
  }
  if (config?.host && sshPort(config.port) === null) {
    errors.push('rsync.port must be a whole number from 1 to 65535');
  }
  if (config?.path && !config.host && LOOKS_REMOTE.test(String(config.path))) {
    // Before the destination check (whose "inside the project" would be the
    // wrong reason) and regardless of allowDestructivePath: rsync would sync
    // over ssh to a user and host nobody checked.
    errors.push('rsync.path looks like a remote destination (host:path); put the server in rsync.host, the user in rsync.user and only the directory in rsync.path');
  } else if (config?.path) {
    const problem = destinationProblem(config, { distDir: 'dist', ...context });
    if (problem) errors.push(problem);
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

  // The same checks as validate(), so no caller can skip them.
  const { valid, errors } = validate(config, { projectRoot, distDir });
  if (!valid) {
    throw new Error(`rsync deploy refused: ${errors.join(' ')}`);
  }

  const args = [
    '-av', // archive, verbose
    '--delete', // remove files at destination not present in source
  ];

  if (!isLocal) {
    args.push('-z'); // compress for remote transfers

    let sshCommand = `ssh -p ${sshPort(config.port)}`;

    if (config.keyPath) {
      const keyPath = String(config.keyPath).replace(/^~(?=\/|$)/, os.homedir());
      sshCommand += ` -i ${rshArgument(keyPath)}`;
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

  // `--`: a local destination starting with `-` is a path, not an option.
  args.push('--', distPath, destination);

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
