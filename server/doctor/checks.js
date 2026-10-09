/**
 * The doctor's checks. ONE ENTRY PER CHECK: to check a new feature, add an
 * entry here (and a section in docs/doctor.md whose anchor is the id).
 *
 * Each check names the astroadmin version that introduced the feature it
 * checks, so a site owner can read "this version added X; your site does not
 * use it yet". Phases run in order: `static` (no build), `build` (makes or
 * accepts the build), `built` (reads the built HTML).
 *
 * run(context) returns { severity, message, details? } where severity is
 * 'pass' | 'warn' | 'fail' | 'skip' (not applicable here). Only 'fail' makes the
 * CLI exit non-zero, so reserve it for what stops a publish or the editor.
 */

// Synchronous fs on purpose: under Bun 1.3.4 on macOS an fs/promises call made
// while child processes come and go can lose its completion and never settle,
// hanging the process at 0% CPU. These paths run git and builds, so they use
// the sync calls (small files, bounded walks).
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildEnvironment,
  cleanCheckOutput,
  findWorkspaceLinkForProject,
  listGitlinks,
  runCommand,
} from '../utils/astro-check.js';
import { listBuiltPagePaths } from './html-scan.js';
import {
  computeFieldCoverage,
  findAnnotatedLinks,
  findUnindexedBlocks,
  findEntryCards,
  findUnknownFieldNames,
} from './coverage.js';
import { bunExecutable, findAstroExecutable, shellQuote } from '../utils/astro-bin.js';
import {
  findAstroAssetsUse,
  findCommittedLockfile,
  isGitRepository,
  probeSharp,
} from './project.js';

/** @typedef {'pass'|'warn'|'fail'|'skip'} Severity */

export const DOCS_BASE = 'https://github.com/cloudshipco/astroadmin/blob/main/docs/doctor.md';
// The click-to-edit conventions, linked from the checks that enforce them.
export const INLINE_EDITING_DOCS = 'https://github.com/cloudshipco/astroadmin/blob/main/docs/inline-editing.md';
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;
// Below this share of text fields reachable by a click, coverage warns.
export const COVERAGE_PASS_SHARE = 0.8;
const MAX_LISTED = 10;
export const NO_HTML_MESSAGE = 'The build has no HTML pages, so there was nothing to check.';

const percent = (part, whole) => `${Math.round((part / whole) * 100)}%`;
const listSome = (items) => items.slice(0, MAX_LISTED).concat(items.length > MAX_LISTED ? [`… and ${items.length - MAX_LISTED} more`] : []);

/** Built checks have nothing to read when there is no build. */
function noBuild(context) {
  return { severity: 'skip', message: context.buildSkippedReason || 'No build to check.' };
}

export const CHECKS = [
  {
    id: 'astro-integration',
    since: '0.2.0',
    phase: 'static',
    title: 'Astro integration',
    async run(context) {
      const facts = await context.astroConfig();
      if (!facts.file) return { severity: 'fail', message: 'No astro.config file found in the project.' };
      if (facts.parseError) return { severity: 'warn', message: `Could not parse ${facts.file}: ${facts.parseError}` };
      if (!facts.integrationImported) return { severity: 'fail', message: `${facts.file} does not import astroadmin/integration, so the preview has no click-to-edit, block focus or component previews.` };
      if (facts.integrationCalled === 'unknown') {
        return { severity: 'warn', message: `Could not verify that astroadmin() is in the integrations ${facts.file} exports: that list is not a plain array (or a const holding one) the doctor can read without running the config. Check it by hand.` };
      }
      if (facts.integrationCalled !== 'yes') return { severity: 'fail', message: `${facts.file} imports astroadmin/integration but the integrations it exports do not call it; add it to integrations: [astroadmin()].` };
      return { severity: 'pass', message: `astroadmin() is in ${facts.file}.` };
    },
  },
  {
    id: 'hosted-preview-config',
    since: '1.3.0',
    phase: 'static',
    title: 'Hosted preview config',
    async run(context) {
      const facts = await context.astroConfig();
      if (!facts.file || facts.parseError) return { severity: 'skip', message: 'No readable astro.config.' };
      const problems = [];
      if (facts.allowedHosts === 'missing') problems.push('vite.server.allowedHosts is not set, so Vite refuses the proxied preview host');
      if (facts.hmr === 'enabled') problems.push('vite.server.hmr is not false; the editor refreshes the preview itself and HMR cannot cross the preview proxy');
      const unknown = [facts.allowedHosts === 'unknown' ? 'allowedHosts' : null, facts.hmr === 'unknown' ? 'hmr' : null].filter(Boolean);
      if (unknown.length > 0) {
        problems.push(`could not verify vite.server ${unknown.join(' and ')}: the value is not a plain literal, or a spread or computed key may override it; check by hand`);
      }
      if (problems.length > 0) {
        const message = problems.join('; ');
        return { severity: 'warn', message: `${message[0].toUpperCase()}${message.slice(1)}.` };
      }
      return { severity: 'pass', message: 'vite.server.allowedHosts is set and hmr is false.' };
    },
  },
  {
    id: 'committed-lockfile',
    since: '1.3.0',
    phase: 'static',
    title: 'Committed bun.lock',
    async run(context) {
      if (!(await isGitRepository(context.projectRoot))) return { severity: 'warn', message: 'The project is not a git repository.' };
      const lockfile = await findCommittedLockfile(context.projectRoot);
      if (!lockfile) return { severity: 'warn', message: 'No bun.lock is committed (in HEAD), so a hosted editor installs whatever versions resolve today.' };
      return { severity: 'pass', message: `${lockfile} is committed.` };
    },
  },
  {
    id: 'no-submodules',
    since: '1.4.8',
    phase: 'static',
    title: 'No git submodules',
    async run(context) {
      if (!(await isGitRepository(context.projectRoot))) return { severity: 'skip', message: 'The project is not a git repository.' };
      let gitlinks;
      try {
        gitlinks = await listGitlinks(context.projectRoot, 'HEAD');
      } catch {
        return { severity: 'skip', message: 'The repository has no commits yet.' };
      }
      if (gitlinks.length > 0) {
        return { severity: 'fail', message: `The publish check refuses sites with git submodules: ${gitlinks.join(', ')}.` };
      }
      return { severity: 'pass', message: 'No submodules.' };
    },
  },
  {
    id: 'no-workspace-links',
    since: '1.4.8',
    phase: 'static',
    title: 'No workspace packages linked into the repo',
    async run(context) {
      if (!(await isGitRepository(context.projectRoot))) return { severity: 'skip', message: 'The project is not a git repository.' };
      const workspaceLink = await findWorkspaceLinkForProject(context.projectRoot);
      if (workspaceLink) {
        return { severity: 'fail', message: `The publish check refuses a workspace package linked back into the repository (${workspaceLink}), because it would build the uncommitted copy.` };
      }
      return { severity: 'pass', message: 'No node_modules package links back into the repository.' };
    },
  },
  {
    id: 'sharp-loads',
    since: '1.4.8',
    phase: 'static',
    title: 'sharp loads',
    async run(context) {
      const usedIn = await findAstroAssetsUse(context.projectRoot);
      if (!usedIn) return { severity: 'skip', message: 'The site does not use astro:assets or image(), so it does not need sharp.' };
      const probe = await probeSharp(context.projectRoot);
      if (!probe.ok) {
        return { severity: 'fail', message: `The site uses Astro images (${usedIn}) but sharp does not load here, so a build that optimises images fails: ${probe.error}` };
      }
      return { severity: 'pass', message: `sharp loads (the site uses Astro images in ${usedIn}).` };
    },
  },
  {
    id: 'build-runs',
    since: '1.4.8',
    phase: 'build',
    title: 'The build runs',
    async run(context) {
      if (context.distDir) {
        if ((await listBuiltPagePaths(context.distDir)).length === 0) {
          context.buildSkippedReason = NO_HTML_MESSAGE;
          const given = context.distDir;
          context.distDir = null;
          return { severity: 'fail', message: `${given} is missing or has no HTML pages, so the built pages could not be checked.` };
        }
        return { severity: 'skip', message: `Using the existing build in ${context.distDir}.` };
      }
      if (!context.build) {
        context.buildSkippedReason = 'Not built (pass --build <distDir> to check an existing build).';
        return { severity: 'skip', message: context.buildSkippedReason };
      }
      // The site's own installed astro, run by Bun with auto-install off: a
      // package runner (bunx) would otherwise fetch and run whatever Astro the
      // registry has today when the site has none installed.
      const astroBin = await findAstroExecutable(context.projectRoot);
      if (!astroBin) {
        context.buildSkippedReason = 'Not built: astro is not installed.';
        return { severity: 'fail', message: 'astro is not installed in the site (no node_modules/astro in its directory or above it in the repository); run the site\'s install first.' };
      }
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astroadmin-doctor-'));
      context.cleanups.push(async () => fs.rmSync(outDir, { recursive: true, force: true }));
      const command = [bunExecutable(), '--no-install', '--bun', astroBin, 'build', '--outDir', outDir].map(shellQuote).join(' ');
      const result = await runCommand(command, context.projectRoot, BUILD_TIMEOUT_MS, buildEnvironment());
      if (result.timedOut || result.exitCode !== 0) {
        context.buildSkippedReason = 'The build failed, so the built HTML could not be checked.';
        const output = cleanCheckOutput(result.output, [context.projectRoot, outDir]).slice(-2000);
        return { severity: 'fail', message: result.timedOut ? `The build did not finish within ${BUILD_TIMEOUT_MS / 1000} seconds.` : 'The build failed.', details: [output] };
      }
      if ((await listBuiltPagePaths(outDir)).length === 0) {
        context.buildSkippedReason = NO_HTML_MESSAGE;
        return { severity: 'fail', message: 'The build succeeded but wrote no HTML pages.' };
      }
      context.distDir = outDir;
      return { severity: 'pass', message: `astro build (${path.relative(context.projectRoot, astroBin) || astroBin}) succeeded.` };
    },
  },
  {
    id: 'block-index',
    since: '0.2.0',
    phase: 'built',
    title: 'Block roots carry data-block-index',
    async run(context) {
      if (!context.distDir) return noBuild(context);
      const { entries, pages } = await context.built();
      const report = findUnindexedBlocks(entries, pages);
      const unchecked = report.unchecked.length > 0
        ? `${report.unchecked.length} ${report.unchecked.length === 1 ? 'entry' : 'entries'} with blocks had no built page and were not checked.`
        : null;
      if (report.totalBlocks === 0) {
        if (unchecked) return { severity: 'warn', message: unchecked, details: listSome(report.unchecked.map((item) => `${item.collection}/${item.slug} (${item.pagePath})`)), data: report };
        return { severity: 'skip', message: 'No built page renders a block list.' };
      }
      const message = `${report.indexedBlocks} of ${report.totalBlocks} rendered blocks carry the right data-block-index for their position.`;
      if (report.pages.length === 0 && !unchecked) return { severity: 'pass', message };
      const details = report.pages.map((page) => `${page.pagePath} (${page.collection}/${page.slug}): ${page.field} (${page.blocks} blocks) ${page.problems.join('; ')}`);
      if (unchecked) details.push(unchecked);
      return {
        severity: 'warn',
        message: report.pages.length > 0
          ? `${message} The editor picks a block's element by its position among the page's data-block-index elements, so a missing, extra, nested or out-of-order one highlights the wrong block. See ${INLINE_EDITING_DOCS}#blocks-data-block-index.`
          : `${message} ${unchecked}`,
        details: listSome(details),
        data: report,
      };
    },
  },
  {
    id: 'click-to-edit-coverage',
    since: '1.4.1',
    phase: 'built',
    title: 'Click-to-edit coverage',
    async run(context) {
      if (!context.distDir) return noBuild(context);
      const { entries, pages } = await context.built();
      const report = computeFieldCoverage(entries, pages);
      const uncheckedNote = report.unchecked.length > 0
        ? `${report.unchecked.length} ${report.unchecked.length === 1 ? 'entry was' : 'entries were'} not checked on ${report.unchecked.length === 1 ? 'its own page, which was' : 'their own pages, which were'} not built (e.g. ${report.unchecked.slice(0, 3).map((item) => `${item.collection}/${item.slug} at ${item.pagePath}`).join(', ')}).`
        : null;
      if (report.totalFields === 0) {
        // Only "nothing to check" when every entry's page was there to read.
        if (uncheckedNote) return { severity: 'warn', message: `No text field could be checked. ${uncheckedNote}`, data: report };
        return { severity: 'skip', message: 'No built page renders an entry with text fields.', data: report };
      }
      const share = report.coveredFields / report.totalFields;
      const perCollection = report.byCollection.map((summary) => `${summary.collection} ${summary.covered}/${summary.fields}`).join(', ');
      const message = `Click-to-edit reaches ${report.coveredFields} of ${report.totalFields} text fields (${percent(report.coveredFields, report.totalFields)}): ${perCollection}.${uncheckedNote ? ` ${uncheckedNote}` : ''}`;
      const details = [];
      for (const summary of report.byCollection) {
        const gaps = report.entries.filter((entry) => entry.collection === summary.collection && entry.covered < entry.fields);
        if (gaps.length === 0) continue;
        const example = gaps[0];
        details.push(`${summary.collection}: ${gaps.length} of ${summary.entries} entries have gaps, e.g. ${example.slug} on ${example.pagePath} misses ${listSome(example.missing).join(', ')}`);
      }
      if (report.notRendered > 0) details.push(`${report.notRendered} text fields are not counted: their text is not visible outside a link on the page (page titles, link labels, metadata, reformatted dates).`);
      if (report.noControl > 0) details.push(`${report.noControl} text fields have no editor control a click could focus (gallery items, say), so are not counted.`);
      // A clean result needs every entry with a page to have been read.
      const passes = share >= COVERAGE_PASS_SHARE && !uncheckedNote;
      if (!passes) details.push(`How to annotate: ${INLINE_EDITING_DOCS}#click-to-edit-in-the-preview`);
      return { severity: passes ? 'pass' : 'warn', message, details, data: report };
    },
  },
  {
    id: 'click-to-edit-names',
    since: '1.4.1',
    phase: 'built',
    title: 'data-aa-field names match a field',
    async run(context) {
      if (!context.distDir) return noBuild(context);
      const { entries, pages } = await context.built();
      const unknown = findUnknownFieldNames(entries, pages);
      const cards = findEntryCards(pages);
      if (unknown.length === 0 && cards.length === 0) {
        return { severity: 'pass', message: 'Every data-aa-field names a field of an entry on its page.' };
      }
      const problems = [];
      if (unknown.length > 0) problems.push(`${unknown.length} data-aa-field value(s) name no field of the entries on their page, so clicking them does nothing. See ${INLINE_EDITING_DOCS}#field-names.`);
      // Cards for another entry are not supported yet: the attribute is
      // ignored, so a click in the card focuses the open entry's field.
      if (cards.length > 0) problems.push(`data-aa-entry is not supported in this version; it is ignored on ${cards.length} ${cards.length === 1 ? 'page' : 'pages'}, and the annotations inside it are not counted as coverage (a click on one focuses the open entry's field of that name).`);
      return {
        severity: 'warn',
        message: problems.join(' '),
        details: listSome([
          ...cards.map((item) => `${item.pagePath}: ${item.cards} data-aa-entry ${item.cards === 1 ? 'element' : 'elements'}`),
          ...unknown.map((item) => `${item.pagePath}: "${item.name}"`),
        ]),
      };
    },
  },
  {
    id: 'click-to-edit-links',
    since: '1.4.1',
    phase: 'built',
    title: 'No data-aa-field on links',
    async run(context) {
      if (!context.distDir) return noBuild(context);
      const { pages } = await context.built();
      const found = findAnnotatedLinks(pages);
      if (found.length === 0) return { severity: 'pass', message: 'No data-aa-field is on or inside a link.' };
      return {
        severity: 'warn',
        message: `${found.length} data-aa-field annotation(s) are on or inside a link. A click on a link follows it and focuses nothing, so these never fire; annotate the text beside the link instead. See ${INLINE_EDITING_DOCS}#links.`,
        details: listSome(found.map((item) => `${item.pagePath}: "${item.name}" ${item.problem}`)),
      };
    },
  },
];
