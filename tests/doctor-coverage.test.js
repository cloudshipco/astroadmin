/**
 * astroadmin doctor: the built-HTML click-to-edit checks.
 *
 * The fixture page mirrors the shapes a fully annotated site builds to: a page
 * header with annotated headline and standfirst, block roots carrying
 * data-block-index (one of them a <figure>, not a <section>), an items grid
 * whose title and body are annotated with the ARRAY's control name, and a card
 * link that is deliberately not annotated. Each check is then shown to go red
 * on a mutated copy.
 *
 *   bun tests/doctor-coverage.test.js
 */

import assert from 'assert';
import { scanHtml, scanBuiltPages } from '../server/doctor/html-scan.js';
import {
  computeFieldCoverage,
  describeEntryFields,
  findAnnotatedLinks,
  findUnindexedBlocks,
  findUnknownFieldNames,
} from '../server/doctor/coverage.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ANNOTATED_PAGE = `<!DOCTYPE html><html><head><title>About</title>
<meta name="description" content="About the example company"></head><body>
<header><nav><a href="/">Home</a></nav></header>
<main>
  <header class="page-header">
    <p class="eyebrow" data-aa-field="kicker">About</p>
    <h1 data-aa-field="headline">An example company</h1>
    <div class="prose" data-aa-field="standfirst"><p>We make example things.</p></div>
  </header>
  <section data-block-index="0">
    <p class="eyebrow" data-aa-field="blocks[0].kicker">Origin</p>
    <h2 data-aa-field="blocks[0].text">Where it started</h2>
  </section>
  <section data-block-index="1">
    <div class="prose" data-aa-field="blocks[1].body"><p>One paragraph.</p><p>Another.</p></div>
  </section>
  <section data-block-index="2">
    <h2 data-aa-field="blocks[2].heading">What we offer</h2>
    <ul>
      <li><article>
        <h3 data-aa-field="blocks[2].items">First</h3>
        <p data-aa-field="blocks[2].items">The first thing.</p>
        <a href="/first">Read more</a>
      </article></li>
      <li><article>
        <h3 data-aa-field="blocks[2].items">Second</h3>
        <p data-aa-field="blocks[2].items">The second thing.</p>
      </article></li>
    </ul>
  </section>
  <figure data-block-index="3">
    <div class="image-slot" data-aa-field="blocks[3].image"></div>
    <figcaption data-aa-field="blocks[3].caption">A caption</figcaption>
  </figure>
</main>
<footer><a href="/privacy">Privacy</a></footer>
<script>const decoy = '<h2 data-aa-field="decoy">not an element</h2>';</script>
</body></html>`;

// The JSON Schema shape the schema parser produces for a discriminated union.
const blockSchema = {
  anyOf: [
    { type: 'object', properties: { type: { type: 'string', const: 'heading' }, kicker: { type: 'string' }, text: { type: 'string' } } },
    { type: 'object', properties: { type: { type: 'string', const: 'richText' }, body: { type: 'string' } } },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'featureGrid' },
        heading: { type: 'string' },
        items: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, href: { type: 'string' } } } },
      },
    },
    { type: 'object', properties: { type: { type: 'string', const: 'imageBand' }, image: { type: 'string' }, alt: { type: 'string' }, caption: { type: 'string' } } },
  ],
};

const aboutEntry = {
  collection: 'pages',
  slug: 'about',
  pagePath: '/about',
  schema: {
    type: 'object',
    properties: {
      kicker: { type: 'string' },
      headline: { type: 'string' },
      standfirst: { type: 'string' },
      metaDescription: { type: 'string' },
      navLabel: { type: 'string', enum: ['About', 'Company'] },
      blocks: { type: 'array', items: blockSchema },
    },
  },
  blockArrays: ['blocks'],
  data: {
    kicker: 'About',
    headline: 'An example company',
    standfirst: 'We make example things.',
    metaDescription: 'About the example company',
    navLabel: 'About',
    blocks: [
      { type: 'heading', kicker: 'Origin', text: 'Where it started' },
      { type: 'richText', body: 'One paragraph.\n\nAnother.' },
      {
        type: 'featureGrid',
        heading: 'What we offer',
        items: [
          { title: 'First', body: 'The first thing.', href: '/first' },
          { title: 'Second', body: 'The second thing.' },
        ],
      },
      { type: 'imageBand', image: '/images/band.jpg', alt: 'A band of colour', caption: 'A caption' },
    ],
  },
};

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

async function pagesFor(html, pagePath = '/about') {
  return new Map([[pagePath, await scanHtml(html)]]);
}

console.log('\n🧪 doctor: click-to-edit on built HTML\n' + '='.repeat(40));

await check('the scan reads annotations and block indexes, not decoys inside <script>', async () => {
  const scan = await scanHtml(ANNOTATED_PAGE);
  assert.deepEqual(scan.blockIndexes, [0, 1, 2, 3]);
  assert.equal(scan.fields.length, 13, JSON.stringify(scan.fields.map((field) => field.name)));
  assert.ok(!scan.fields.some((field) => field.name === 'decoy'), 'a string inside a script is not an element');
});

await check('text fields leave out ids, links, images, alt, metadata, enums and discriminators', () => {
  const { textFields } = describeEntryFields(aboutEntry);
  assert.deepEqual(textFields, [
    'kicker', 'headline', 'standfirst',
    'blocks[0].kicker', 'blocks[0].text',
    'blocks[1].body',
    'blocks[2].heading', 'blocks[2].items[0].title', 'blocks[2].items[0].body', 'blocks[2].items[1].title', 'blocks[2].items[1].body',
    'blocks[3].caption',
  ]);
});

await check('a Markdown body counts as the "body" field', () => {
  const { textFields } = describeEntryFields({ data: { title: 'A post' }, body: 'Some words.\n' });
  assert.deepEqual(textFields, ['title', 'body']);
});

await check('coverage: a fully annotated page covers every text field (array items via the array control)', async () => {
  const report = computeFieldCoverage([aboutEntry], await pagesFor(ANNOTATED_PAGE));
  assert.equal(report.totalFields, 12);
  assert.equal(report.coveredFields, 12, JSON.stringify(report.entries[0].missing));
});

await check('coverage MUTATION: an unannotated build of the same page covers nothing', async () => {
  const bare = ANNOTATED_PAGE.replace(/ data-aa-field="[^"]*"/g, '');
  const report = computeFieldCoverage([aboutEntry], await pagesFor(bare));
  assert.equal(report.totalFields, 12);
  assert.equal(report.coveredFields, 0);
});

await check('coverage MUTATION: dropping one annotation drops exactly that field', async () => {
  const mutated = ANNOTATED_PAGE.replace(' data-aa-field="blocks[0].text"', '');
  const report = computeFieldCoverage([aboutEntry], await pagesFor(mutated));
  assert.equal(report.coveredFields, 11);
  assert.deepEqual(report.entries[0].missing, ['blocks[0].text']);
});

await check('coverage: annotating a whole block does not count (it is not a control)', async () => {
  const mutated = ANNOTATED_PAGE
    .replace(' data-aa-field="blocks[0].kicker"', '')
    .replace(' data-aa-field="blocks[0].text"', '')
    .replace('<section data-block-index="0">', '<section data-block-index="0" data-aa-field="blocks[0]">');
  const report = computeFieldCoverage([aboutEntry], await pagesFor(mutated));
  assert.deepEqual(report.entries[0].missing, ['blocks[0].kicker', 'blocks[0].text']);
});

await check('coverage: an entry whose page was not built is reported as unchecked, not as zero', async () => {
  const report = computeFieldCoverage([{ ...aboutEntry, pagePath: '/missing' }], await pagesFor(ANNOTATED_PAGE));
  assert.equal(report.totalFields, 0);
  assert.deepEqual(report.unchecked, [{ collection: 'pages', slug: 'about', pagePath: '/missing' }]);
});

await check('block index: every block on the fixture page is indexed', async () => {
  const report = findUnindexedBlocks([aboutEntry], await pagesFor(ANNOTATED_PAGE));
  assert.equal(report.totalBlocks, 4);
  assert.equal(report.indexedBlocks, 4);
  assert.deepEqual(report.pages, []);
});

await check('block index MUTATION: removing one data-block-index (the <figure>) is reported', async () => {
  const mutated = ANNOTATED_PAGE.replace('<figure data-block-index="3">', '<figure>');
  const report = findUnindexedBlocks([aboutEntry], await pagesFor(mutated));
  assert.equal(report.indexedBlocks, 3);
  assert.deepEqual(report.pages.map((page) => page.missing), [[3]]);
});

await check('links: the fixture (card link not annotated) has no annotated link', async () => {
  assert.deepEqual(findAnnotatedLinks(await pagesFor(ANNOTATED_PAGE)), []);
});

await check('links MUTATION: data-aa-field on an <a href> is reported', async () => {
  const mutated = ANNOTATED_PAGE.replace('<a href="/first">', '<a href="/first" data-aa-field="blocks[2].items">');
  assert.deepEqual(findAnnotatedLinks(await pagesFor(mutated)), [{ pagePath: '/about', name: 'blocks[2].items', problem: 'is a link' }]);
});

await check('links: an annotated ANCESTOR of a link is not reported (the link click resolves to nothing)', async () => {
  const mutated = ANNOTATED_PAGE.replace('<li><article>', '<li><article data-aa-field="blocks[2].items">')
    .replace('<p data-aa-field="blocks[2].items">The first thing.</p>', '<p data-aa-field="blocks[2].items">The <a href="/x">first</a> thing.</p>');
  assert.deepEqual(findAnnotatedLinks(await pagesFor(mutated)), []);
});

await check('links MUTATION: data-aa-field INSIDE a link is reported (it can never fire)', async () => {
  const mutated = ANNOTATED_PAGE.replace('<a href="/first">Read more</a>', '<a href="/first"><span data-aa-field="blocks[2].items">Read more</span></a>');
  assert.deepEqual(findAnnotatedLinks(await pagesFor(mutated)), [{ pagePath: '/about', name: 'blocks[2].items', problem: 'is inside a link' }]);
});

await check('links: an <a> without href is not a link (a click on it focuses its field)', async () => {
  const mutated = ANNOTATED_PAGE.replace('<p class="eyebrow" data-aa-field="kicker">About</p>', '<a class="eyebrow" data-aa-field="kicker">About</a>');
  assert.deepEqual(findAnnotatedLinks(await pagesFor(mutated)), []);
});

await check('links MUTATION: an annotated <area href> is reported', async () => {
  const mutated = ANNOTATED_PAGE.replace('</main>', '<map name="m"><area href="/a" data-aa-field="headline"></map></main>');
  assert.deepEqual(findAnnotatedLinks(await pagesFor(mutated)), [{ pagePath: '/about', name: 'headline', problem: 'is a link' }]);
});

await check('coverage: an annotation on or inside a link does not cover its field (a click never reaches it)', async () => {
  const onLink = ANNOTATED_PAGE.replace('<h1 data-aa-field="headline">An example company</h1>', '<h1><a href="/" data-aa-field="headline">An example company</a></h1>');
  // Its text is then wholly inside a link, so it is left out rather than
  // counted as covered (without the filter it would count as covered: 12/12).
  for (const html of [onLink, ANNOTATED_PAGE.replace('<h1 data-aa-field="headline">An example company</h1>', '<a href="/"><h1 data-aa-field="headline">An example company</h1></a>')]) {
    const report = computeFieldCoverage([aboutEntry], await pagesFor(html));
    assert.equal(report.coveredFields, 11);
    assert.deepEqual(report.entries[0].notRendered, ['headline']);
  }
});

await check('names: every annotation on the fixture names a real control', async () => {
  assert.deepEqual(findUnknownFieldNames([aboutEntry], await pagesFor(ANNOTATED_PAGE)), []);
});

await check('names MUTATION: a block field without its index qualification is reported', async () => {
  const mutated = ANNOTATED_PAGE.replace('data-aa-field="blocks[2].heading"', 'data-aa-field="heading"');
  assert.deepEqual(findUnknownFieldNames([aboutEntry], await pagesFor(mutated)), [{ pagePath: '/about', name: 'heading' }]);
});

await check('coverage: text visible only inside a link (a button label) is not counted against the page', async () => {
  const withCta = { ...aboutEntry, data: { ...aboutEntry.data, ctaLabel: 'Get in touch today' }, schema: { ...aboutEntry.schema, properties: { ...aboutEntry.schema.properties, ctaLabel: { type: 'string' } } } };
  const page = ANNOTATED_PAGE.replace('</main>', '<a class="button" href="/contact">Get in touch today</a></main>');
  const report = computeFieldCoverage([withCta], await pagesFor(page));
  assert.equal(report.totalFields, 12, 'the label is not counted');
  assert.deepEqual(report.entries[0].notRendered, ['ctaLabel']);
  // Control: the same text outside the link IS counted, and is uncovered.
  const visible = ANNOTATED_PAGE.replace('</main>', '<p>Get in touch today</p></main>');
  const visibleReport = computeFieldCoverage([withCta], await pagesFor(visible));
  assert.equal(visibleReport.totalFields, 13);
  assert.deepEqual(visibleReport.entries[0].missing, ['ctaLabel']);
});

await check('coverage: a short value must appear as whole words, not inside another word', async () => {
  const withShort = { ...aboutEntry, data: { ...aboutEntry.data, badge: 'Or' }, schema: { ...aboutEntry.schema, properties: { ...aboutEntry.schema.properties, badge: { type: 'string' } } } };
  const report = computeFieldCoverage([withShort], await pagesFor(ANNOTATED_PAGE));
  assert.deepEqual(report.entries[0].notRendered, ['badge'], '"Or" is inside "Origin" but is not on the page');
  const visible = ANNOTATED_PAGE.replace('</main>', '<span>or</span></main>');
  assert.deepEqual(computeFieldCoverage([withShort], await pagesFor(visible)).entries[0].missing, ['badge']);
});

await check('coverage: a Markdown paragraph is found however it rendered (links, entities, emphasis)', async () => {
  const entry = { collection: 'articles', slug: 'post', pagePath: '/p', data: { title: 'A post' }, body: 'It\'s [our *first*](https://example.com) post, & more.\n\nSecond paragraph.' };
  const page = '<html><body><h1>A post</h1><div><p>It&#39;s <a href="https://example.com">our <em>first</em></a> post, &amp; more.</p></div></body></html>';
  const report = computeFieldCoverage([entry], await pagesFor(page, '/p'));
  assert.deepEqual(report.entries[0].missing, ['title', 'body'], 'the body counts as rendered, though part of it is a link');
  assert.equal(report.totalFields, 2);
  // Control: the same paragraph rendered wholly inside a link is not counted.
  const linked = page.replace('<p>It&#39;s <a href="https://example.com">our <em>first</em></a> post, &amp; more.</p>',
    '<a href="/p"><p>It&#39;s our <em>first</em> post, &amp; more.</p></a>');
  assert.deepEqual(computeFieldCoverage([entry], await pagesFor(linked, '/p')).entries[0].notRendered, ['body']);
});

await check('coverage: per-collection totals', async () => {
  const other = { collection: 'faqs', slug: 'one', pagePath: '/about', data: { question: 'Is this an example question?' } };
  const page = ANNOTATED_PAGE.replace('</main>', '<p>Is this an example question?</p></main>');
  const report = computeFieldCoverage([aboutEntry, other], await pagesFor(page));
  assert.deepEqual(report.byCollection, [
    { collection: 'pages', entries: 1, fields: 12, covered: 12 },
    { collection: 'faqs', entries: 1, fields: 1, covered: 0 },
  ]);
});

await check('names: a field the schema declares but the entry leaves empty is a real control', async () => {
  const withoutKicker = { ...aboutEntry, data: { ...aboutEntry.data } };
  delete withoutKicker.data.kicker;
  assert.deepEqual(findUnknownFieldNames([withoutKicker], await pagesFor(ANNOTATED_PAGE)), []);
});

await check('the built-page reader finds both build formats and skips missing pages', async () => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-doctor-dist-'));
  try {
    fs.mkdirSync(path.join(distDir, 'about'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<h1 data-aa-field="title">Home</h1>');
    fs.writeFileSync(path.join(distDir, 'about', 'index.html'), ANNOTATED_PAGE);
    fs.writeFileSync(path.join(distDir, 'contact.html'), '<p data-aa-field="intro">Hi</p>');
    const pages = await scanBuiltPages(distDir, ['/', '/about', '/contact', '/missing']);
    assert.deepEqual([...pages.keys()], ['/', '/about', '/contact']);
    assert.equal(pages.get('/contact').fields[0].name, 'intro');
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
