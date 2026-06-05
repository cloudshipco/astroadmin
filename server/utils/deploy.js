/**
 * Deploy adapter registry
 *
 * Dispatches deployment to a named adapter. Adding a new target (e.g. netlify,
 * cloudflare) is a one-line registry entry plus an adapter module implementing
 * the interface in adapters/rsync.js.
 *
 * Signatures are kept compatible with the original single-file deploy.js so
 * existing callers (server/api/git.js, server/api/publish.js) need no change:
 *   validateDeployConfig(deployConfig) -> { valid, errors[] }
 *   deploy(deployConfig, projectRoot, { distDir, log }) -> result
 */

import { rsyncAdapter } from './adapters/rsync.js';

/** @type {Record<string, { name: string, validate: Function, deploy: Function }>} */
const ADAPTERS = {
  rsync: rsyncAdapter,
  // netlify: netlifyAdapter,   // future — one line each
  // cloudflare: cloudflareAdapter,
};

function supportedList() {
  return Object.keys(ADAPTERS).join(', ');
}

/**
 * Validate deploy configuration without running a deployment.
 * No adapter configured is considered valid (deployment is optional).
 *
 * @param {object} deployConfig - The `deploy` config block
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateDeployConfig(deployConfig) {
  if (!deployConfig?.adapter) {
    return { valid: true, errors: [] };
  }

  const adapter = ADAPTERS[deployConfig.adapter];
  if (!adapter) {
    return {
      valid: false,
      errors: [`Unknown deploy adapter: ${deployConfig.adapter}. Supported: ${supportedList()}`],
    };
  }

  return adapter.validate(deployConfig[deployConfig.adapter] || {});
}

/**
 * Run deployment using the configured adapter.
 *
 * @param {object} deployConfig - The `deploy` config block
 * @param {string} projectRoot - Project root directory
 * @param {object} [options]
 * @param {string} [options.distDir='dist'] - Build output directory
 * @param {(msg: string) => void} [options.log=console.log] - Log sink
 * @returns {Promise<object>} - Adapter result, with `adapter` name attached
 */
export async function deploy(deployConfig, projectRoot, { distDir = 'dist', log = console.log } = {}) {
  if (!deployConfig?.adapter) {
    return { success: true, skipped: true, message: 'No deploy adapter configured' };
  }

  const adapter = ADAPTERS[deployConfig.adapter];
  if (!adapter) {
    throw new Error(`Unknown deploy adapter: ${deployConfig.adapter}. Supported: ${supportedList()}`);
  }

  const result = await adapter.deploy({
    projectRoot,
    distDir,
    config: deployConfig[deployConfig.adapter] || {},
    log,
  });

  return { ...result, adapter: adapter.name };
}
