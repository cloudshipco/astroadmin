/**
 * The integration's /component-preview/[block]/[...slug] route
 * (integration/preview-route.astro), in a real `astro dev` of a scratch site
 * started through Astro's own dev() API:
 *
 * - a site with no src/styles/global.css still gets the preview (the route
 *   imported that file unconditionally and answered 500 without it);
 * - the block component receives the synthetic block both as `block` and
 *   spread as props (docs/blocks.md's components take the fields as props);
 * - `?field=` names the block field that carries the ids, for a block type
 *   whose field is not `<singular type>Ids`;
 * - `&single=1` makes that field one value, not a list (a single
 *   reference('team') or `teamId`), and `&collection=` makes it the
 *   {collection, id} the build gives a reference().
 * - the path's id is ONE entry id: a nested id (`regional/ada`) is never split
 *   into `regional` and `ada`, and a `?` or `#` in an id survives the trip
 *   (Astro's param is decodeURI'd, so the route decodes the raw path).
 *
 * - an id holding the route's own name (`regional/component-preview/ada`) is
 *   that id: the prefix is found after the site's base, with and without one.
 *
 * Port: COMPONENT_PREVIEW_PORT, default 4728 (and the next port, for the
 * restart with a `base`).
 *   bun tests/component-preview.test.js     (~15 s; ports 4728-4729)
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { linkNodeModules, sharedAstroStore } from './link-node-modules.js';
import { componentPreviewPath } from '../ui/preview-routes.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const siteDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-component-preview-')));
const PORT = Number(process.env.COMPONENT_PREVIEW_PORT) || 4728;

function writeFile(relativePath, content) {
  const fullPath = path.join(siteDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

writeFile('package.json', JSON.stringify({ name: 'example-site', type: 'module' }));
writeFile('astro.config.mjs', `import { defineConfig } from 'astro/config';
import astroadmin from 'astroadmin/integration';
export default defineConfig({ integrations: [astroadmin()] });
`);
writeFile('src/content.config.ts', `import { defineCollection } from 'astro:content';
import { glob, file } from 'astro/loaders';
import { z } from 'astro/zod';
export const collections = {
  pages: defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/pages' }), schema: z.object({ title: z.string() }) }),
  team: defineCollection({ loader: file('src/content/team.json'), schema: z.object({ name: z.string() }) }),
  testimonials: defineCollection({ loader: file('src/content/testimonials.json'), schema: z.object({ quote: z.string() }) }),
};
`);
writeFile('src/content/pages/home.md', '---\ntitle: Home\n---\n');
// A nested id (a glob collection's `regional/ada.md` has one too) must reach
// the component whole, never split into `regional` and `ada`.
writeFile('src/content/team.json', JSON.stringify([
  { id: 'ada', name: 'Ada from the team' },
  { id: 'regional', name: 'Not this one' },
  { id: 'regional/ada', name: 'Ada from the regional team' },
  { id: 'north east/o?brien#1', name: 'An id with a space, ? and #' },
  // The route's own name inside an id: the route found its prefix with
  // lastIndexOf, so these decoded to '' and to 'ada'.
  { id: 'regional/component-preview/ada', name: 'Ada with the route name in her id' },
  { id: 'regional/component-preview/team/ada', name: 'Ada two levels down' },
]));
writeFile('src/content/testimonials.json', JSON.stringify([{ id: 'sue', quote: 'A quote from Sue' }]));
writeFile('src/pages/index.astro', '<h1>Home</h1>\n');
// Spread props, as docs/blocks.md writes components.
writeFile('src/components/blocks/TeamBlock.astro', `---
import { getEntry } from 'astro:content';
const { teamIds = [] } = Astro.props;
const members = (await Promise.all(teamIds.map((id) => getEntry('team', id)))).filter(Boolean);
---
<ul>{members.map((member) => <li class="member">{member.data.name}</li>)}</ul>
`);
// The \`block\` prop, reading a field named by ?field=.
writeFile('src/components/blocks/FeaturedQuotesBlock.astro', `---
import { getEntry } from 'astro:content';
const { block } = Astro.props;
const quotes = (await Promise.all((block.testimonialIds || []).map((id) => getEntry('testimonials', id)))).filter(Boolean);
---
<ul>{quotes.map((item) => <li class="quote">{item.data.quote}</li>)}</ul>
`);
// A single reference() field: the build hands the component {collection, id},
// which getEntry() takes as it is.
writeFile('src/components/blocks/AuthorBlock.astro', `---
import { getEntry } from 'astro:content';
const { block } = Astro.props;
const member = block.author && !Array.isArray(block.author) ? await getEntry(block.author) : null;
---
<p class="author">{member ? member.data.name : 'no author: ' + JSON.stringify(block.author)}</p>
`);
// A list of reference()s: the build hands each item as {collection, id}, so the
// component passes each straight to getEntry (a bare id would fail there).
writeFile('src/components/blocks/CrewBlock.astro', `---
import { getEntry } from 'astro:content';
const { block } = Astro.props;
const members = await Promise.all((block.members || []).map((ref) => (typeof ref === 'object' ? getEntry(ref) : null)));
---
<ul class="crew">{members.map((member, index) => <li class="crew-member">{member ? member.data.name : 'bare id: ' + JSON.stringify(block.members[index])}</li>)}</ul>
`);
// A single plain id field (\`<base>Id\`): the component looks it up by id.
writeFile('src/components/blocks/LeadBlock.astro', `---
import { getEntry } from 'astro:content';
const { leadId } = Astro.props;
const member = typeof leadId === 'string' ? await getEntry('team', leadId) : null;
---
<p class="lead">{member ? member.data.name : 'no lead: ' + JSON.stringify(leadId)}</p>
`);
linkNodeModules(repoRoot, siteDir);
// A copy, as an install has it: the integration inside the site's node_modules
// (a symlink out of the site root makes Vite mis-key the route's own <style>).
fs.mkdirSync(path.join(siteDir, 'node_modules', 'astroadmin'));
fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(siteDir, 'node_modules', 'astroadmin', 'package.json'));
fs.cpSync(path.join(repoRoot, 'integration'), path.join(siteDir, 'node_modules', 'astroadmin', 'integration'), { recursive: true });

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

let server = null;
try {
  console.log('\n🧪 Component preview route\n' + '='.repeat(40));
  const { dev } = await import(path.join(siteDir, 'node_modules/astro/dist/core/index.js')).catch(() => import('astro'));
  server = await dev({ root: siteDir, logLevel: 'error', server: { port: PORT, host: 'localhost' } });
  const get = async (pathname) => {
    const response = await fetch(`http://localhost:${PORT}${pathname}`);
    return { status: response.status, text: await response.text() };
  };

  await check('the site does not share this checkout\'s Astro data store (node_modules/.astro)', async () => {
    const shared = sharedAstroStore(repoRoot, siteDir);
    assert.equal(shared, null, `the site's node_modules/.astro resolves into this checkout (${shared}), so test sites share one content store`);
    assert.ok(fs.existsSync(path.join(siteDir, 'node_modules', '.bin')), 'positive control: .bin is still linked');
  });

  await check('the dev server is up (positive control)', async () => {
    const home = await get('/');
    assert.equal(home.status, 200);
    assert.match(home.text, /<h1[^>]*>Home<\/h1>/);
  });

  await check('a site with no src/styles/global.css gets the preview, its component given the block as props', async () => {
    assert.ok(!fs.existsSync(path.join(siteDir, 'src/styles/global.css')));
    const preview = await get('/component-preview/team/ada');
    assert.equal(preview.status, 200, preview.text.slice(0, 400));
    assert.match(preview.text, /<li class="member"[^>]*>Ada from the team<\/li>/);
  });

  await check('?field= names the ids field; the component also gets `block`; a multi-word type finds FeaturedQuotesBlock', async () => {
    const preview = await get('/component-preview/featuredquotes/sue?field=testimonialIds');
    assert.equal(preview.status, 200, preview.text.slice(0, 400));
    assert.match(preview.text, /<li class="quote"[^>]*>A quote from Sue<\/li>/);
  });

  await check('a single reference() field is given one {collection, id}, not a list', async () => {
    // The path the dashboard builds for it (ui/preview-routes.js).
    const pathname = componentPreviewPath({ type: 'author', field: 'author', single: true, reference: true }, 'team', 'ada');
    assert.equal(pathname, '/component-preview/author/ada?field=author&single=1&collection=team');
    const preview = await get(pathname);
    assert.equal(preview.status, 200, preview.text.slice(0, 400));
    assert.match(preview.text, /<p class="author"[^>]*>Ada from the team<\/p>/, preview.text.slice(0, 600));
  });

  await check('a list of reference()s is given {collection, id} items, as the build gives them', async () => {
    const pathname = componentPreviewPath({ type: 'crew', field: 'members', reference: true }, 'team', 'ada');
    assert.equal(pathname, '/component-preview/crew/ada?field=members&collection=team');
    const preview = await get(pathname);
    assert.equal(preview.status, 200, preview.text.slice(0, 400));
    assert.match(preview.text, /<li class="crew-member"[^>]*>Ada from the team<\/li>/, preview.text.slice(0, 600));
  });

  await check('a single plain id field is given one id, not a list', async () => {
    const preview = await get(componentPreviewPath({ type: 'lead', field: 'leadId', single: true }, 'team', 'ada'));
    assert.equal(preview.status, 200, preview.text.slice(0, 400));
    assert.match(preview.text, /<p class="lead"[^>]*>Ada from the team<\/p>/, preview.text.slice(0, 600));
  });

  await check('a nested entry id reaches the component whole: single reference, reference list, id list', async () => {
    const single = await get(componentPreviewPath({ type: 'author', field: 'author', single: true, reference: true }, 'team', 'regional/ada'));
    assert.equal(single.status, 200, single.text.slice(0, 400));
    assert.match(single.text, /<p class="author"[^>]*>Ada from the regional team<\/p>/, single.text.slice(0, 600));

    const list = await get(componentPreviewPath({ type: 'crew', field: 'members', reference: true }, 'team', 'regional/ada'));
    assert.equal(list.status, 200, list.text.slice(0, 400));
    const crew = [...list.text.matchAll(/<li class="crew-member"[^>]*>([^<]*)<\/li>/g)].map((match) => match[1]);
    assert.deepEqual(crew, ['Ada from the regional team'], 'one member, the nested entry');

    const ids = await get(componentPreviewPath({ type: 'team' }, 'team', 'regional/ada'));
    assert.equal(ids.status, 200, ids.text.slice(0, 400));
    const members = [...ids.text.matchAll(/<li class="member"[^>]*>([^<]*)<\/li>/g)].map((match) => match[1]);
    assert.deepEqual(members, ['Ada from the regional team'], 'one id, the nested entry');
  });

  await check('an id with a space, ? and # reaches the component as it is', async () => {
    const preview = await get(componentPreviewPath({ type: 'author', field: 'author', single: true, reference: true }, 'team', 'north east/o?brien#1'));
    assert.equal(preview.status, 200, preview.text.slice(0, 400));
    assert.match(preview.text, /<p class="author"[^>]*>An id with a space, \? and #<\/p>/, preview.text.match(/<main[\s\S]*<\/main>/)?.[0]);
  });

  await check('an id containing the route name reaches the component whole', async () => {
    for (const [id, name] of [
      ['regional/component-preview/ada', 'Ada with the route name in her id'],
      ['regional/component-preview/team/ada', 'Ada two levels down'],
    ]) {
      const preview = await get(componentPreviewPath({ type: 'team' }, 'team', id));
      assert.equal(preview.status, 200, preview.text.slice(0, 400));
      const members = [...preview.text.matchAll(/<li class="member"[^>]*>([^<]*)<\/li>/g)].map((match) => match[1]);
      assert.deepEqual(members, [name], `${id}: one id, the whole one`);
    }
  });

  await check('a global.css, when the site has one, is still loaded', async () => {
    writeFile('src/styles/global.css', '.member { color: rgb(1, 2, 3); }\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const preview = await get('/component-preview/team/ada');
    assert.equal(preview.status, 200);
    assert.match(preview.text, /global\.css|rgb\(1, 2, 3\)/, 'the stylesheet is linked or inlined');
  });

  // The same route on a site with a `base`: the prefix is found after the
  // base, never searched for inside the id.
  await Promise.race([server.stop(), new Promise((resolve) => setTimeout(resolve, 10000))]);
  server = null;
  // Inline: a rewritten astro.config.mjs is not re-read by a second dev() in
  // the same process.
  server = await dev({ root: siteDir, base: '/docs', logLevel: 'error', server: { port: PORT + 1, host: 'localhost' } });
  const getWithBase = async (pathname) => {
    const response = await fetch(`http://localhost:${PORT + 1}/docs${pathname}`);
    return { status: response.status, text: await response.text() };
  };

  await check('with a base: a plain and a nested id reach the component (positive control)', async () => {
    for (const [id, name] of [['ada', 'Ada from the team'], ['regional/ada', 'Ada from the regional team']]) {
      const preview = await getWithBase(componentPreviewPath({ type: 'team' }, 'team', id));
      assert.equal(preview.status, 200, preview.text.slice(0, 400));
      const members = [...preview.text.matchAll(/<li class="member"[^>]*>([^<]*)<\/li>/g)].map((match) => match[1]);
      assert.deepEqual(members, [name], `${id} under /docs`);
    }
  });

  await check('with a base: an id containing the route name reaches the component whole', async () => {
    for (const [id, name] of [
      ['regional/component-preview/ada', 'Ada with the route name in her id'],
      ['regional/component-preview/team/ada', 'Ada two levels down'],
    ]) {
      const preview = await getWithBase(componentPreviewPath({ type: 'team' }, 'team', id));
      assert.equal(preview.status, 200, preview.text.slice(0, 400));
      const members = [...preview.text.matchAll(/<li class="member"[^>]*>([^<]*)<\/li>/g)].map((match) => match[1]);
      assert.deepEqual(members, [name], `${id} under /docs`);
    }
  });

  console.log('='.repeat(40));
  console.log(`\n📊 ${passed} checks passed.\n`);
} finally {
  // A dev server that failed to start can hang in stop(); never let that hold the suite.
  if (server) await Promise.race([server.stop(), new Promise((resolve) => setTimeout(resolve, 10000))]);
  fs.rmSync(siteDir, { recursive: true, force: true });
}
process.exit(process.exitCode || 0);
