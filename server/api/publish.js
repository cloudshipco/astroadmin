/**
 * Publish API Router
 *
 * Publishing is build + deploy, with git as an OPTIONAL pre-step. When git is
 * enabled we stage the configured paths (config.git.paths — src/content plus
 * assets in files mode, assets only in db mode), and never the binary content
 * DB unless config.git.includeDb.
 *
 * Pipeline: [git pull/commit/push if enabled] -> build -> deploy (if adapter).
 *
 * Mounted at /api/publish. The handler is also re-exported and aliased at
 * /api/git/publish (git.js) for backwards compatibility when git is enabled.
 */

import express from 'express';
import path from 'path';
import simpleGit from 'simple-git';
import { getConfig } from '../config.js';
import { deploy, validateDeployConfig } from '../utils/deploy.js';
import { runProductionBuild } from '../utils/build.js';
import { checkHeadWithAstro } from '../utils/astro-check.js';
import { listSlugs } from '../utils/content.js';

const router = express.Router();
// Conservative fallback for a malformed config; an explicitly-configured
// empty array means "stage nothing" and is respected.
// (Helpers are exported for reuse by api/git.js — keep one definition.)
const DEFAULT_GIT_PATHS = ['src/styles/', 'public/images/'];

export function createGitClient(fullConfig) {
  return simpleGit(fullConfig.paths.projectRoot);
}

export function getGitPaths(fullConfig) {
  return Array.isArray(fullConfig.git?.paths) ? fullConfig.git.paths : DEFAULT_GIT_PATHS;
}

export async function getStagedFilesForPaths(git, gitPaths) {
  if (gitPaths.length === 0) return [];

  const diffOutput = await git.diff(['--name-only', '--cached', '--', ...gitPaths]);
  return diffOutput.split(/\r?\n/).filter(Boolean);
}

export async function stageGitPaths(git, gitPaths) {
  const stagedPaths = [];

  for (const gitPath of gitPaths) {
    try {
      await git.add(['-A', '--', gitPath]);
      stagedPaths.push(gitPath);
    } catch (error) {
      // A configured path may not exist in every project — non-fatal.
      console.log('Staging note:', error.message);
    }
  }

  return stagedPaths;
}

// Publishes and commits run one at a time, so the commit that was checked is
// the commit that gets pushed (a second publish can't commit in between).
let gitQueue = Promise.resolve();

/** Run a task that commits and/or pushes, after any such task already running. */
export function withGitLock(task) {
  const run = gitQueue.then(task, task);
  gitQueue = run.catch(() => {});
  return run;
}

/**
 * Push HEAD only if the site's own Astro accepts its content (see
 * utils/astro-check.js). A failed check leaves the commit local and unpushed.
 * `pushError` is set when there IS somewhere to push and the push failed (a
 * site with no upstream simply is not pushed, which is not an error).
 * @returns {Promise<{pushed: boolean, pushError: string|null, check: import('../utils/astro-check.js').AstroCheckResult}>}
 */
export async function pushIfAstroAccepts(fullConfig, git) {
  const check = await checkHeadWithAstro(fullConfig);
  if (!check.success) {
    return { pushed: false, pushError: null, check };
  }

  const upstream = await findUpstream(git);
  if (!upstream) {
    console.log('Push skipped: no upstream branch configured');
    return { pushed: false, pushError: null, check };
  }

  try {
    await pushCheckedCommit(git, check.commit, upstream);
    console.log('✅ Pushed to remote');
    return { pushed: true, pushError: null, check };
  } catch (pushError) {
    console.error('Push failed:', pushError.message);
    return { pushed: false, pushError: pushError.message, check };
  }
}

/**
 * The current branch's upstream, or null when HEAD is detached or the branch
 * tracks nothing. Reads the full ref name: `--short` can return "heads/main"
 * when a tag is also called "main", which names the wrong config keys.
 * @returns {Promise<{remote: string, ref: string}|null>}
 */
async function findUpstream(git) {
  try {
    const headRef = (await git.raw(['symbolic-ref', '--quiet', 'HEAD'])).trim();
    if (!headRef.startsWith('refs/heads/')) return null;
    const branch = headRef.slice('refs/heads/'.length);
    const remote = (await git.raw(['config', '--get', `branch.${branch}.remote`])).trim();
    const ref = (await git.raw(['config', '--get', `branch.${branch}.merge`])).trim();
    return remote && ref ? { remote, ref } : null;
  } catch {
    return null;
  }
}

/**
 * Push exactly the checked commit to the upstream branch, and nothing else. A
 * bare `git push` can send other refs (a configured remote.<name>.push
 * refspec, push.default=matching, followTags), none of which were checked.
 */
async function pushCheckedCommit(git, commit, upstream) {
  await git.raw(['push', '--no-follow-tags', upstream.remote, `${commit}:${upstream.ref}`]);
}

/** Response body for a checked commit that could not be pushed. */
export function pushFailureBody({ committed = false, commitResult = null } = {}) {
  return {
    success: false,
    committed,
    pushed: false,
    commit: commitInfo(commitResult),
    error: 'Could not send your changes to the site',
    message: 'Your changes are saved and committed, but could not be sent to the site, so they are not live yet. '
      + 'Try publishing again in a moment; if it keeps happening, contact your site administrator.',
  };
}

/**
 * Astro names a refused entry by its own ID, which is not always the editor's
 * slug (a locale file home.fr.md has the ID "homefr"). Only an ID that is an
 * existing slug of its collection can be opened from the refusal.
 */
async function markEditableEntries(entries) {
  const marked = [];
  for (const entry of entries) {
    let slugs = [];
    try {
      slugs = await listSlugs(entry.collection);
    } catch {
      // unknown collection: not openable
    }
    marked.push({ ...entry, editable: slugs.includes(entry.slug) });
  }
  return marked;
}

/** Response body for a push the content check refused. */
export async function checkRefusalBody(check, { committed = false, commitResult = null } = {}) {
  return {
    success: false,
    committed,
    pushed: false,
    commit: commitInfo(commitResult),
    error: "The site's build rejects this content",
    message: committed
      ? 'Your changes are saved and committed, but were not published: the site would not build with them.'
      : 'Nothing was published: the site would not build with the current content.',
    check: { commit: check.commit, output: check.output, entries: await markEditableEntries(check.entries) },
  };
}

function commitInfo(commitResult) {
  return commitResult
    ? { hash: commitResult.commit, summary: commitResult.summary }
    : null;
}

/**
 * Run the git pre-step: pull --rebase, stage configured asset paths, commit,
 * check the resulting HEAD with Astro, push. Best-effort pull/push so a missing
 * remote doesn't fail the publish; the check is not best-effort.
 * @returns {Promise<{committed: boolean, pushed: boolean, commitResult: object|null, check: object}>}
 */
async function runGitStep(fullConfig, commitMessage) {
  let committed = false;
  let pushed = false;
  let commitResult = null;
  let check = null;
  let pushError = null;
  const git = createGitClient(fullConfig);
  const commitPaths = [];

  try {
    await git.pull(['--rebase']);
    console.log('✅ Pulled latest changes');
  } catch (pullError) {
    console.log('Pull skipped:', pullError.message);
  }

  // Optionally force-add the (gitignored) content DB.
  if (fullConfig.git?.includeDb) {
    const relDb = path.relative(fullConfig.paths.projectRoot, fullConfig.database.path);
    try {
      await git.add(['-f', relDb]);
      commitPaths.push(relDb);
    } catch (error) {
      console.log('Could not stage content DB:', error.message);
    }
  }

  const stagePaths = getGitPaths(fullConfig);
  commitPaths.push(...await stageGitPaths(git, stagePaths));

  const stagedFiles = await getStagedFilesForPaths(git, commitPaths);
  if (stagedFiles.length > 0) {
    commitResult = await git.commit(commitMessage, commitPaths);
    committed = true;
    console.log(`✅ Committed: ${commitMessage}`);
  }

  // Checked after the pull and the commit, so it is the combined result —
  // exactly what the push would send — that has to pass.
  ({ pushed, pushError, check } = await pushIfAstroAccepts(fullConfig, git));

  return { committed, pushed, commitResult, check, pushError };
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
      let check;
      let pushError;
      ({ committed, pushed, commitResult, check, pushError } =
        await withGitLock(() => runGitStep(fullConfig, commitMessage)));
      if (!check.success) {
        return res.status(422).json(await checkRefusalBody(check, { committed, commitResult }));
      }
      if (pushError) {
        return res.status(502).json(pushFailureBody({ committed, commitResult }));
      }
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
        deployResult = await deploy(deployConfig, fullConfig.paths.projectRoot);
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
      message: buildPublishMessage({ gitEnabled, committed, pushed, deployResult }),
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

/**
 * Resolve a requested page path against the configured public origin, refusing
 * anything that would escape it (SSRF guard — `path` is client-supplied, e.g.
 * `//evil.com` or `http://internal`). Returns a URL guaranteed to be same-origin
 * as publicUrl.
 */
export function resolveLiveUrl(publicUrl, requestedPath) {
  const base = new URL(publicUrl);
  const resolved = new URL(requestedPath || '/', base);
  if (resolved.origin !== base.origin) {
    throw new Error('path must stay within the configured public site');
  }
  return resolved;
}

// Stable, fast content hash (djb2) so the editor can tell when a page's live
// HTML changes after a publish without transferring the whole body around.
function hashContent(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * GET /api/publish/live-status?path=/some-page
 * Fetch a page from the configured public (production) site and return a hash of
 * its HTML. The editor captures this before a publish, then polls until the hash
 * changes — i.e. the deploy went live. No-op (configured:false) when publicUrl
 * is unset. Server-side fetch avoids the browser's cross-origin restriction.
 */
export async function liveStatusHandler(req, res) {
  try {
    const fullConfig = await getConfig();
    const publicUrl = fullConfig.publicUrl;
    if (!publicUrl) {
      return res.json({ success: true, configured: false });
    }

    let target;
    try {
      target = resolveLiveUrl(publicUrl, req.query.path);
    } catch (err) {
      return res.status(400).json({ success: false, configured: true, error: err.message });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(target.href, {
        signal: controller.signal,
        headers: { 'Cache-Control': 'no-cache' },
      });
      const body = await response.text();
      return res.json({
        success: true,
        configured: true,
        reachable: response.ok,
        status: response.status,
        hash: response.ok ? hashContent(body) : null,
      });
    } catch (fetchError) {
      // Unreachable/timeout is expected mid-deploy — report, don't 500.
      return res.json({ success: true, configured: true, reachable: false, error: fetchError.message });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.error('Error checking live status:', error);
    res.status(500).json({ success: false, error: 'Failed to check live status', message: error.message });
  }
}

router.get('/live-status', liveStatusHandler);

export function buildPublishMessage({ gitEnabled, committed, pushed, deployResult }) {
  const parts = [];
  if (gitEnabled && committed && pushed) parts.push('committed and pushed');
  else if (gitEnabled && committed) parts.push('committed');
  else if (gitEnabled && pushed) parts.push('pushed');
  if (deployResult) parts.push('built and deployed');
  if (parts.length === 0) {
    return gitEnabled
      ? 'Nothing to publish (no git changes, no deploy adapter configured)'
      : 'Nothing to publish (git disabled, no deploy adapter configured)';
  }
  return `Published: ${parts.join(', ')}`;
}

router.post('/', publishHandler);

export default router;
