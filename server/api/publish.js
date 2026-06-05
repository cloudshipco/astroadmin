/**
 * Publish API Router
 *
 * Publishing is build + deploy, with git as an OPTIONAL pre-step. Content lives
 * in the SQLite store (not src/content), so `git add src/content` is no longer
 * meaningful — when git is enabled we stage only configured asset paths
 * (config.git.paths), never the binary content DB unless config.git.includeDb.
 *
 * Pipeline: [git pull/commit/push if enabled] -> build -> deploy (if adapter).
 *
 * Mounted at /api/publish. The handler is also re-exported and aliased at
 * /api/git/publish (git.js) for backwards compatibility when git is enabled.
 */

import express from 'express';
import path from 'path';
import simpleGit from 'simple-git';
import { config, getConfig } from '../config.js';
import { deploy, validateDeployConfig } from '../utils/deploy.js';
import { runProductionBuild } from '../utils/build.js';

const router = express.Router();
const git = simpleGit(config.paths.projectRoot);

function commitInfo(commitResult) {
  return commitResult
    ? { hash: commitResult.commit, summary: commitResult.summary }
    : null;
}

/**
 * Run the git pre-step: pull --rebase, stage configured asset paths, commit,
 * push. Best-effort pull/push so a missing remote doesn't fail the publish.
 * @returns {Promise<{committed: boolean, pushed: boolean, commitResult: object|null}>}
 */
async function runGitStep(fullConfig, commitMessage) {
  let committed = false;
  let pushed = false;
  let commitResult = null;

  try {
    await git.pull(['--rebase']);
    console.log('✅ Pulled latest changes');
  } catch (pullError) {
    console.log('Pull skipped:', pullError.message);
  }

  // Optionally force-add the (gitignored) content DB.
  if (fullConfig.git?.includeDb) {
    const relDb = path.relative(config.paths.projectRoot, config.database.path);
    try {
      await git.add(['-f', relDb]);
    } catch (error) {
      console.log('Could not stage content DB:', error.message);
    }
  }

  const stagePaths = fullConfig.git?.paths || ['src/styles/', 'public/images/'];
  try {
    await git.add(stagePaths);
  } catch (error) {
    // A configured path may not exist in every project — non-fatal.
    console.log('Staging note:', error.message);
  }

  const status = await git.status();
  if (status.staged.length > 0) {
    commitResult = await git.commit(commitMessage);
    committed = true;
    console.log(`✅ Committed: ${commitMessage}`);
  }

  try {
    await git.push();
    pushed = true;
    console.log('✅ Pushed to remote');
  } catch (pushError) {
    console.log('Push skipped:', pushError.message);
  }

  return { committed, pushed, commitResult };
}

/**
 * POST /api/publish
 * Build and deploy the site; commit/push to git first when git is enabled.
 */
export async function publishHandler(req, res) {
  try {
    const { message } = req.body;
    const commitMessage = message?.trim() || 'Content update';

    const fullConfig = await getConfig();
    const deployConfig = fullConfig.deploy;
    const gitEnabled = fullConfig.git?.enabled;

    // Validate deploy config up front.
    if (deployConfig?.adapter) {
      const validation = validateDeployConfig(deployConfig);
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          error: 'Invalid deploy configuration',
          details: validation.errors,
        });
      }
    }

    // Optional git pre-step.
    let committed = false;
    let pushed = false;
    let commitResult = null;
    if (gitEnabled) {
      ({ committed, pushed, commitResult } = await runGitStep(fullConfig, commitMessage));
    }

    // Build + deploy.
    let buildResult = null;
    let deployResult = null;

    if (deployConfig?.adapter) {
      buildResult = await runProductionBuild();

      if (!buildResult.success) {
        return res.json({
          success: false,
          committed,
          pushed,
          commit: commitInfo(commitResult),
          build: buildResult,
          deploy: null,
          message: gitEnabled ? 'Published to git, but build failed' : 'Build failed',
          error: 'Build failed - deployment skipped',
        });
      }

      try {
        deployResult = await deploy(deployConfig, config.paths.projectRoot);
        console.log('✅ Deployment completed');
      } catch (deployError) {
        return res.json({
          success: false,
          committed,
          pushed,
          commit: commitInfo(commitResult),
          build: buildResult,
          deploy: { success: false, error: deployError.message },
          message: 'Built, but deployment failed',
          error: deployError.message,
        });
      }
    }

    res.json({
      success: true,
      committed,
      pushed,
      commit: commitInfo(commitResult),
      build: buildResult,
      deploy: deployResult,
      message: buildPublishMessage({ gitEnabled, committed, deployResult }),
    });
  } catch (error) {
    console.error('Error publishing:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to publish',
      message: error.message,
    });
  }
}

function buildPublishMessage({ gitEnabled, committed, deployResult }) {
  const parts = [];
  if (gitEnabled) parts.push(committed ? 'committed and pushed' : 'pushed');
  if (deployResult) parts.push('built and deployed');
  if (parts.length === 0) return 'Nothing to publish (git disabled, no deploy adapter configured)';
  return `Published: ${parts.join(', ')}`;
}

router.post('/', publishHandler);

export default router;
