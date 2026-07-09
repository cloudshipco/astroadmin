/**
 * Netlify deploy adapter
 *
 * Deploys a pre-built `dist/` to a Netlify site via the Netlify CLI. Netlify
 * never sees the source repo — only the built artifact — so this needs no
 * per-repo CI authorization and works on the free tier for private repos.
 *
 * The auth token is passed via the child's environment (NETLIFY_AUTH_TOKEN),
 * NEVER on argv (argv is visible in process listings).
 *
 * Adapter interface:
 *   name
 *   validate(config) -> { valid, errors[] }
 *   deploy({ projectRoot, distDir, config, log }) -> { success, output, url }
 */

import { spawn } from 'child_process';
import path from 'path';

/**
 * @param {object} config - netlify config block: { siteId, authToken, command?, dryRun? }
 * @returns {{valid: boolean, errors: string[]}}
 */
function validate(config) {
  const errors = [];
  if (!config?.siteId) {
    errors.push('netlify.siteId is required');
  }
  if (!config?.authToken) {
    errors.push('netlify.authToken is required (set NETLIFY_AUTH_TOKEN)');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * @param {object} args
 * @param {string} args.projectRoot - Project root directory (build cwd)
 * @param {string} args.distDir - Build output directory (relative to projectRoot)
 * @param {object} args.config - netlify config block
 * @param {(msg: string) => void} args.log - Log sink
 * @returns {Promise<{success: boolean, output: string, url: string|null, draft: boolean}>}
 */
function deploy({ projectRoot, distDir, config, log }) {
  if (!config?.siteId) {
    throw new Error("netlify deploy: missing required field 'siteId'");
  }
  if (!config?.authToken) {
    throw new Error('netlify deploy: missing auth token (NETLIFY_AUTH_TOKEN)');
  }

  const distPath = path.join(projectRoot, distDir);
  const command = config.command || 'netlify';
  const draft = config.dryRun === true;

  // Deploy the pre-built directory as-is (no --build). Omitting --prod produces
  // a draft/preview deploy; --prod publishes to the live site.
  const args = ['deploy', '--dir', distPath, '--site', config.siteId];
  if (!draft) {
    args.push('--prod');
  }
  if (config.message) {
    args.push('--message', String(config.message));
  }

  log(`🚀 Netlify deploy: ${distPath} → site ${config.siteId} (${draft ? 'draft' : 'production'})`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      // Token via env, NEVER argv.
      env: { ...process.env, NETLIFY_AUTH_TOKEN: config.authToken },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      process.stdout.write(chunk);
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      process.stderr.write(chunk);
    });

    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new Error(`netlify deploy: '${command}' not found on PATH (install netlify-cli)`));
      } else {
        reject(new Error(`Failed to spawn ${command}: ${error.message}`));
      }
    });

    child.on('close', (code) => {
      const output = stdout + stderr;
      if (code !== 0) {
        reject(new Error(`netlify deploy failed (exit ${code}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      // Netlify prints e.g. "Website URL: https://…" (prod) or a draft URL.
      const match = output.match(/https:\/\/[^\s]+\.netlify\.app[^\s]*/i)
        || output.match(/(?:Website|Live|Draft) URL:\s*(\S+)/i);
      const url = match ? (match[1] || match[0]) : null;
      log(`✅ Netlify deploy complete${url ? `: ${url}` : ''}`);
      resolve({ success: true, output, url, draft });
    });
  });
}

export const netlifyAdapter = {
  name: 'netlify',
  validate,
  deploy,
};
