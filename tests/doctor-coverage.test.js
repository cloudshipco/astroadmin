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
import { scanHtml, scanBuiltPages, listBuiltPagePaths } from '../server/doctor/html-scan.js';
import {
  computeFieldCoverage,
  describeEntryFields,
  findAnnotatedLinks,
  findUnindexedBlocks,
  findUnknownEntryRefs,
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

// The editor's form reads block types from `blockTypes`, which the collections
// API adds beside the union (enrichSchemaWithBlockTypes); entries.js does the same.
const blockTypes = Object.fromEntries(blockSchema.anyOf.map((option) => [option.properties.type.const, option]));

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
      blocks: { type: 'array', items: blockSchema, blockTypes },
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

// A home page listing entries of another collection as cards, each card
// qualified with data-aa-entry. The services collection has no page of its own.
const HOME_WITH_CARDS = `<!DOCTYPE html><html><head><title>Home</title></head><body>
<main>
  <h1 data-aa-field="headline">Welcome to the example company</h1>
  <section data-block-index="0">
    <ul>
      <li data-aa-entry="services/garden-design">
        <h3 data-aa-field="title">Garden design</h3>
        <p data-aa-field="summary">Plans and planting for any plot.</p>
        <a href="/services/garden-design">Read more</a>
      </li>
      <li data-aa-entry="services/hedge-trimming">
        <h3 data-aa-field="title">Hedge trimming</h3>
        <p data-aa-field="summary">Neat edges, twice a year.</p>
      </li>
    </ul>
  </section>
</main></body></html>`;

const serviceSchema = { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' }, details: { type: 'string' } } };
const homeEntry = {
  collection: 'pages', slug: 'home', pagePath: '/',
  schema: { type: 'object', properties: { headline: { type: 'string' }, title: { type: 'string' } } },
  data: { headline: 'Welcome to the example company', title: 'Garden design' },
};
const serviceEntries = [
  { collection: 'services', slug: 'garden-design', pagePath: null, schema: serviceSchema, data: { title: 'Garden design', summary: 'Plans and planting for any plot.', details: 'Long text shown only on a detail page.' } },
  { collection: 'services', slug: 'hedge-trimming', pagePath: null, schema: serviceSchema, data: { title: 'Hedge trimming', summary: 'Neat edges, twice a year.', details: 'More long text not on the home page.' } },
];

console.log('\n🧪 doctor: entry-qualified annotations (data-aa-entry)\n' + '='.repeat(40));

await check('the scan records each annotation\'s entry: the nearest data-aa-entry on it or an ancestor', async () => {
  const scan = await scanHtml(`<body><h1 data-aa-field="headline">H</h1>
    <div data-aa-entry="services/a"><p data-aa-field="title">A</p>
      <div data-aa-entry="services/b"><p data-aa-field="title">B</p></div>
      <p data-aa-field="summary">A again</p></div>
    <img data-aa-entry="services/c" data-aa-field="image" src="/c.jpg">
    <p data-aa-field="after">after</p></body>`);
  assert.deepEqual(scan.fields.map((field) => [field.name, field.entry]), [
    ['headline', null], ['title', 'services/a'], ['title', 'services/b'], ['summary', 'services/a'], ['image', 'services/c'], ['after', null],
  ]);
  assert.deepEqual(scan.entryRefs, ['services/a', 'services/b', 'services/c']);
});

await check('coverage: a card\'s qualified annotations count toward ITS entry, which has no page of its own', async () => {
  const report = computeFieldCoverage([homeEntry, ...serviceEntries], await pagesFor(HOME_WITH_CARDS, '/'));
  const garden = report.entries.find((entry) => entry.slug === 'garden-design');
  assert.ok(garden, JSON.stringify(report.entries.map((entry) => entry.slug)));
  assert.equal(garden.pagePath, '/');
  assert.equal(garden.fields, 2, 'title and summary render on the card; details does not');
  assert.equal(garden.covered, 2);
  assert.deepEqual(garden.notRendered, ['details']);
  assert.deepEqual(report.byCollection.find((summary) => summary.collection === 'services'), { collection: 'services', entries: 2, fields: 4, covered: 4 });
});

await check('coverage MUTATION: dropping one card\'s summary annotation drops exactly that entry\'s field', async () => {
  const mutated = HOME_WITH_CARDS.replace('<p data-aa-field="summary">Neat edges', '<p>Neat edges');
  const report = computeFieldCoverage([homeEntry, ...serviceEntries], await pagesFor(mutated, '/'));
  assert.deepEqual(report.entries.find((entry) => entry.slug === 'hedge-trimming').missing, ['summary']);
  assert.deepEqual(report.entries.find((entry) => entry.slug === 'garden-design').missing, []);
});

await check('coverage: a card\'s "title" does not cover the PAGE entry\'s own "title"', async () => {
  const report = computeFieldCoverage([homeEntry, ...serviceEntries], await pagesFor(HOME_WITH_CARDS, '/'));
  assert.deepEqual(report.entries.find((entry) => entry.slug === 'home').missing, ['title']);
});

await check('coverage: an entry with no page and no card is left out, not counted as zero', async () => {
  const report = computeFieldCoverage([homeEntry, ...serviceEntries], await pagesFor(HOME_WITH_CARDS.replace(/ data-aa-entry="[^"]*"/g, ''), '/'));
  assert.deepEqual(report.entries.map((entry) => entry.slug), ['home']);
  assert.deepEqual(report.unchecked, []);
});

await check('names: qualified names are checked against their entry, not the page\'s', async () => {
  // "summary" is not a field of pages/home, but it is of each service.
  assert.deepEqual(findUnknownFieldNames([homeEntry, ...serviceEntries], await pagesFor(HOME_WITH_CARDS, '/')), []);
});

await check('names MUTATION: a qualified name its entry does not have is reported with the entry', async () => {
  const mutated = HOME_WITH_CARDS.replace('<p data-aa-field="summary">Neat edges', '<p data-aa-field="blurb">Neat edges');
  assert.deepEqual(findUnknownFieldNames([homeEntry, ...serviceEntries], await pagesFor(mutated, '/')), [{ pagePath: '/', name: 'blurb', entry: 'services/hedge-trimming' }]);
});

await check('entry refs: every data-aa-entry on the fixture names an existing entry', async () => {
  assert.deepEqual(findUnknownEntryRefs([homeEntry, ...serviceEntries], await pagesFor(HOME_WITH_CARDS, '/')), []);
});

await check('entry refs MUTATION: a reference to an entry that does not exist is reported once per page', async () => {
  const mutated = HOME_WITH_CARDS.replace('data-aa-entry="services/hedge-trimming"', 'data-aa-entry="services/hedge-cutting"');
  assert.deepEqual(findUnknownEntryRefs([homeEntry, ...serviceEntries], await pagesFor(mutated, '/')), [{ pagePath: '/', entry: 'services/hedge-cutting' }]);
  // ...and its annotations are not ALSO reported as unknown names.
  assert.deepEqual(findUnknownFieldNames([homeEntry, ...serviceEntries], await pagesFor(mutated, '/')), []);
});

await check('built pages: every page in the build is listed, including pages no entry owns', async () => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-doctor-list-'));
  try {
    fs.mkdirSync(path.join(distDir, 'services', 'all'), { recursive: true });
    fs.mkdirSync(path.join(distDir, '_astro'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '');
    fs.writeFileSync(path.join(distDir, 'services', 'all', 'index.html'), '');
    fs.writeFileSync(path.join(distDir, 'contact.html'), '');
    fs.writeFileSync(path.join(distDir, '_astro', 'x.js'), '');
    assert.deepEqual((await listBuiltPagePaths(distDir)).sort(), ['/', '/contact', '/services/all']);
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
});

console.log('\n🧪 doctor: review findings (control paths, hidden markup, links, block order, unchecked pages)\n' + '='.repeat(40));

const heroEntry = {
  collection: 'pages', slug: 'home', pagePath: '/',
  schema: { type: 'object', properties: { hero: { type: 'object', properties: { headline: { type: 'string' } } } } },
  data: { hero: { headline: 'Welcome' } },
};

await check('control paths: annotating a nested OBJECT covers nothing and is an unknown name (only hero.headline is a control)', async () => {
  const page = '<html><body><section data-aa-field="hero"><h1>Welcome</h1></section></body></html>';
  const pages = await pagesFor(page, '/');
  const report = computeFieldCoverage([heroEntry], pages);
  assert.deepEqual({ total: report.totalFields, covered: report.coveredFields, missing: report.entries[0]?.missing }, { total: 1, covered: 0, missing: ['hero.headline'] });
  assert.deepEqual(findUnknownFieldNames([heroEntry], pages), [{ pagePath: '/', name: 'hero' }]);
  // Control: the control's own name covers it and is known.
  const fixed = await pagesFor('<html><body><section><h1 data-aa-field="hero.headline">Welcome</h1></section></body></html>', '/');
  assert.equal(computeFieldCoverage([heroEntry], fixed).coveredFields, 1);
  assert.deepEqual(findUnknownFieldNames([heroEntry], fixed), []);
});

await check('control paths: strings get a control per item, a one-property object list per item field, a 2+ property list one control', async () => {
  const entry = {
    collection: 'pages', slug: 'home', pagePath: '/',
    schema: {
      type: 'object',
      properties: {
        credentials: { type: 'array', items: { type: 'string' } },
        points: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } } } },
        cards: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } } },
        image: { type: 'string' },
      },
    },
    data: {
      credentials: ['Member of the example guild'],
      points: [{ text: 'A point worth making here' }],
      cards: [{ title: 'Card title for the example', body: 'Card body text for the example' }],
      image: '/images/x.jpg',
    },
  };
  const good = await pagesFor(`<html><body>
    <p data-aa-field="credentials[0]">Member of the example guild</p>
    <p data-aa-field="points[0].text">A point worth making here</p>
    <h3 data-aa-field="cards">Card title for the example</h3><p data-aa-field="cards">Card body text for the example</p>
    <img data-aa-field="image" src="/images/x.jpg"></body></html>`, '/');
  assert.deepEqual(findUnknownFieldNames([entry], good), []);
  const report = computeFieldCoverage([entry], good);
  assert.deepEqual({ total: report.totalFields, covered: report.coveredFields }, { total: 4, covered: 4 });
  // The list containers of strings and of one-property objects are not controls;
  // neither is an item of a 2+ property list.
  const bad = await pagesFor(`<html><body>
    <ul data-aa-field="credentials"><li>Member of the example guild</li></ul>
    <ul data-aa-field="points"><li>A point worth making here</li></ul>
    <h3 data-aa-field="cards[0].title">Card title for the example</h3><p>Card body text for the example</p></body></html>`, '/');
  assert.deepEqual(findUnknownFieldNames([entry], bad).map((item) => item.name), ['credentials', 'points', 'cards[0].title']);
  assert.equal(computeFieldCoverage([entry], bad).coveredFields, 0);
});

await check('links: an annotation inside a link (the review\'s exact input) is reported', async () => {
  const pages = await pagesFor('<html><body><a href="/x"><span data-aa-field="headline">Welcome</span></a></body></html>', '/');
  assert.deepEqual(findAnnotatedLinks(pages), [{ pagePath: '/', name: 'headline', problem: 'is inside a link' }]);
});

await check('hidden markup: an annotation inside <template> or a [hidden] element covers nothing', async () => {
  const entry = { collection: 'pages', slug: 'home', pagePath: '/', schema: { type: 'object', properties: { headline: { type: 'string' } } }, data: { headline: 'Welcome' } };
  for (const hiddenCopy of [
    '<template><h1 data-aa-field="headline">Welcome</h1></template>',
    '<div hidden><h1 data-aa-field="headline">Welcome</h1></div>',
    '<h1 hidden data-aa-field="headline">Welcome</h1>',
    '<noscript><h1 data-aa-field="headline">Welcome</h1></noscript>',
  ]) {
    const report = computeFieldCoverage([entry], await pagesFor(`<html><body>${hiddenCopy}<h1>Welcome</h1></body></html>`, '/'));
    assert.deepEqual({ html: hiddenCopy, total: report.totalFields, covered: report.coveredFields }, { html: hiddenCopy, total: 1, covered: 0 });
  }
  // Control: the same annotation on the visible heading covers it.
  const visible = computeFieldCoverage([entry], await pagesFor('<html><body><h1 data-aa-field="headline">Welcome</h1></body></html>', '/'));
  assert.equal(visible.coveredFields, 1);
});

await check('hidden markup: block roots and entry references inside <template> are not on the page', async () => {
  const scan = await scanHtml('<html><body><template><section data-block-index="0" data-aa-entry="services/x"></section></template><section data-block-index="0"></section></body></html>');
  assert.deepEqual(scan.blockIndexes, [0]);
  assert.deepEqual(scan.entryRefs, []);
});

await check('implicit body: a page with no <body> tag still has its text read', async () => {
  const entry = { collection: 'pages', slug: 'home', pagePath: '/', schema: { type: 'object', properties: { headline: { type: 'string' } } }, data: { headline: 'Welcome' } };
  const report = computeFieldCoverage([entry], await pagesFor('<h1>Welcome</h1>', '/'));
  assert.deepEqual({ total: report.totalFields, missing: report.entries[0]?.missing }, { total: 1, missing: ['headline'] });
  // ...but a <title> in an implicit <head> is still not body text.
  const titled = computeFieldCoverage([entry], await pagesFor('<title>Welcome</title><p>Other text</p>', '/'));
  assert.equal(titled.totalFields, 0);
});

const twoBlocks = {
  collection: 'pages', slug: 'home', pagePath: '/', blockArrays: ['blocks'],
  schema: { type: 'object', properties: { blocks: { type: 'array', items: blockSchema, blockTypes } } },
  data: { blocks: [{ type: 'heading', text: 'One' }, { type: 'heading', text: 'Two' }] },
};

await check('block order: roots in the right order pass; out of order, duplicated, extra or nested are reported', async () => {
  const blockReport = async (inner) => findUnindexedBlocks([twoBlocks], await pagesFor(`<html><body>${inner}</body></html>`, '/'));
  const good = await blockReport('<section data-block-index="0"></section><section data-block-index="1"></section>');
  assert.deepEqual(good.pages, []);
  assert.equal(good.indexedBlocks, 2);
  for (const [label, inner] of [
    ['out of order', '<section data-block-index="1"></section><section data-block-index="0"></section>'],
    ['duplicated', '<section data-block-index="0"></section><section data-block-index="0"></section><section data-block-index="1"></section>'],
    ['extra', '<section data-block-index="0"></section><section data-block-index="1"></section><section data-block-index="2"></section>'],
    ['nested', '<section data-block-index="0"><div data-block-index="1"></div></section>'],
  ]) {
    const report = await blockReport(inner);
    assert.equal(report.pages.length, 1, `${label}: ${JSON.stringify(report)}`);
    assert.ok(report.pages[0].problems?.length > 0, `${label}: names the problem`);
  }
});

await check('unmapped: an entry with no page and no card is carried in the report, not dropped', async () => {
  const report = computeFieldCoverage([homeEntry, ...serviceEntries], await pagesFor(HOME_WITH_CARDS.replace(/ data-aa-entry="[^"]*"/g, ''), '/'));
  assert.deepEqual(report.unmapped, [{ collection: 'services', slug: 'garden-design' }, { collection: 'services', slug: 'hedge-trimming' }]);
});

await check('a missing or empty build is not reported as clean', async () => {
  const { runDoctor } = await import('../server/doctor/index.js');
  const emptyDist = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-doctor-empty-'));
  try {
    for (const distDir of [emptyDist, path.join(emptyDist, 'does-not-exist')]) {
      const report = await runDoctor({ projectRoot: emptyDist, distDir, build: false, phases: ['built'], loadEntries: async () => ({ entries: [aboutEntry] }) });
      const severities = Object.fromEntries(report.results.map((result) => [result.id, result.severity]));
      for (const [id, severity] of Object.entries(severities)) {
        assert.ok(severity === 'warn' || severity === 'fail', `${distDir}: ${id} is ${severity}`);
      }
    }
  } finally {
    fs.rmSync(emptyDist, { recursive: true, force: true });
  }
});

await check('an entry whose page was not built keeps coverage from passing, and the message says so', async () => {
  const { runDoctor } = await import('../server/doctor/index.js');
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-doctor-partial-'));
  try {
    fs.mkdirSync(path.join(distDir, 'about'));
    fs.writeFileSync(path.join(distDir, 'about', 'index.html'), ANNOTATED_PAGE);
    const missingPage = { ...heroEntry, slug: 'contact', pagePath: '/contact' };
    const report = await runDoctor({ projectRoot: distDir, distDir, build: false, phases: ['built'], loadEntries: async () => ({ entries: [aboutEntry, missingPage] }) });
    const coverage = report.results.find((result) => result.id === 'click-to-edit-coverage');
    assert.equal(coverage.severity, 'warn', JSON.stringify(coverage));
    assert.match(coverage.message, /1 entr(y|ies) .*not built/, coverage.message);
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
});

console.log('\n🧪 doctor: review round 2 (cards without annotations, cards masking missing pages, <head>)\n' + '='.repeat(40));

await check('coverage MUTATION: removing EVERY annotation from a card drops coverage (the card is still a place showing its entry)', async () => {
  const bare = HOME_WITH_CARDS
    .replace('<h3 data-aa-field="title">Hedge trimming</h3>', '<h3>Hedge trimming</h3>')
    .replace('<p data-aa-field="summary">Neat edges', '<p>Neat edges');
  assert.notEqual(bare, HOME_WITH_CARDS, 'the mutation applied');
  const before = computeFieldCoverage([homeEntry, ...serviceEntries], await pagesFor(HOME_WITH_CARDS, '/'));
  const after = computeFieldCoverage([homeEntry, ...serviceEntries], await pagesFor(bare, '/'));
  // Positive control: before the mutation the hedge-trimming card is counted, 2 of 2.
  assert.deepEqual(before.entries.find((entry) => entry.slug === 'hedge-trimming')?.covered, 2);
  const hedge = after.entries.find((entry) => entry.slug === 'hedge-trimming');
  assert.ok(hedge, `the visible card's entry is still reported: ${JSON.stringify(after.entries.map((entry) => entry.slug))}`);
  assert.deepEqual({ fields: hedge.fields, covered: hedge.covered, missing: hedge.missing }, { fields: 2, covered: 0, missing: ['title', 'summary'] });
  assert.deepEqual(after.unmapped, [], 'a visible card is not "on no built page"');
  assert.equal(after.coveredFields, before.coveredFields - 2);
  assert.equal(after.totalFields, before.totalFields);
});

await check('coverage: a card naming an entry with no annotations at all (only data-aa-entry) still shows that entry', async () => {
  const scan = await scanHtml('<html><body><article data-aa-entry="services/hedge-trimming"><h3>Hedge trimming</h3></article></body></html>');
  assert.deepEqual(scan.entryRefs, ['services/hedge-trimming']);
  const report = computeFieldCoverage(serviceEntries, new Map([['/', scan]]));
  assert.deepEqual(report.entries.map((entry) => [entry.slug, entry.fields, entry.covered]), [['hedge-trimming', 1, 0]]);
  assert.deepEqual(report.unmapped, [{ collection: 'services', slug: 'garden-design' }]);
});

await check('coverage MUTATION: an entry whose own page was not built is unchecked even when a card shows it elsewhere', async () => {
  const withPages = serviceEntries.map((entry) => ({ ...entry, pagePath: `/services/${entry.slug}` }));
  const report = computeFieldCoverage([homeEntry, ...withPages], await pagesFor(HOME_WITH_CARDS, '/'));
  assert.deepEqual(report.unchecked, [
    { collection: 'services', slug: 'garden-design', pagePath: '/services/garden-design' },
    { collection: 'services', slug: 'hedge-trimming', pagePath: '/services/hedge-trimming' },
  ]);
  // The cards still count toward coverage.
  assert.deepEqual(report.entries.find((entry) => entry.slug === 'garden-design')?.covered, 2);
  // Control: with the standalone pages built, nothing is unchecked.
  const pages = await pagesFor(HOME_WITH_CARDS, '/');
  for (const entry of withPages) pages.set(entry.pagePath, await scanHtml(`<html><body><h1 data-aa-field="title">${entry.data.title}</h1></body></html>`));
  assert.deepEqual(computeFieldCoverage([homeEntry, ...withPages], pages).unchecked, []);
});

await check('coverage: a card masking a missing page keeps the check from passing (runDoctor)', async () => {
  const { runDoctor } = await import('../server/doctor/index.js');
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-doctor-card-mask-'));
  try {
    fs.writeFileSync(path.join(distDir, 'index.html'), HOME_WITH_CARDS.replace('</main>', '<p data-aa-field="title">Garden design</p></main>'));
    const garden = { ...serviceEntries[0], pagePath: '/services/garden-design' };
    const report = await runDoctor({ projectRoot: distDir, distDir, build: false, phases: ['built'], loadEntries: async () => ({ entries: [homeEntry, garden, serviceEntries[1]] }) });
    const coverage = report.results.find((result) => result.id === 'click-to-edit-coverage');
    assert.equal(coverage.data.coveredFields, coverage.data.totalFields, `positive control: everything shown is annotated: ${coverage.message}`);
    assert.equal(coverage.severity, 'warn', JSON.stringify(coverage));
    assert.match(coverage.message, /services\/garden-design at \/services\/garden-design/, coverage.message);
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
});

const titleEntry = { collection: 'pages', slug: 'home', pagePath: '/', schema: { type: 'object', properties: { title: { type: 'string' }, headline: { type: 'string' } } }, data: { title: 'Example home', headline: 'Welcome to the example' } };

await check('head MUTATION: an annotation in <head> (a <title>) is not recorded and covers nothing', async () => {
  const page = '<!DOCTYPE html><html><head><title data-aa-field="title">Example home</title></head><body><h1>Welcome to the example</h1><p>Example home</p></body></html>';
  const scan = await scanHtml(page);
  assert.deepEqual(scan.fields, [], JSON.stringify(scan.fields));
  const report = computeFieldCoverage([titleEntry], new Map([['/', scan]]));
  assert.deepEqual({ total: report.totalFields, covered: report.coveredFields }, { total: 2, covered: 0 });
  // Control: the same annotation on the visible copy is recorded and covers it.
  const visible = await scanHtml(page.replace('<p>Example home</p>', '<p data-aa-field="title">Example home</p>'));
  assert.deepEqual(visible.fields.map((field) => field.name), ['title']);
  assert.equal(computeFieldCoverage([titleEntry], new Map([['/', visible]])).coveredFields, 1);
});

await check('head: a page whose only annotation is its <title> does not report 1/1', async () => {
  const report = computeFieldCoverage([titleEntry], await pagesFor('<html><head><title data-aa-field="title">Example home</title></head><body><p>Nothing annotated</p></body></html>', '/'));
  // Unfixed, the title annotation made this 1 of 1. Its text is not in the body, so it is not counted at all.
  assert.deepEqual({ total: report.totalFields, covered: report.coveredFields }, { total: 0, covered: 0 }, JSON.stringify(report));
});

await check('head: annotations and entry refs on head elements are left out, also without a <head> tag; body text still read', async () => {
  const scan = await scanHtml('<title data-aa-field="title">Example home</title><meta data-aa-entry="services/x" data-aa-field="summary" content="x"><link data-aa-field="title" rel="icon" href="/x.png"><h1 data-aa-field="headline">Welcome to the example</h1>');
  assert.deepEqual(scan.fields.map((field) => field.name), ['headline']);
  assert.deepEqual(scan.entryRefs, []);
  assert.ok(scan.clickableText.includes('welcometotheexample'), 'the implicit body is still read');
  const inHead = await scanHtml('<html><head><meta name="x" data-aa-entry="services/hedge-trimming"><noscript></noscript></head><body><p data-aa-field="headline">Hi</p></body></html>');
  assert.deepEqual(inHead.entryRefs, []);
  assert.deepEqual(inHead.fields.map((field) => [field.name, field.entry]), [['headline', null]], 'a head entry ref does not qualify body annotations');
  // The head ends where a browser ends it: an omitted </head> does not swallow the body.
  for (const html of [
    '<html><head><title>T</title><body><p data-aa-field="headline">Hello there</p></body></html>',
    '<html><head><title>T</title><p data-aa-field="headline">Hello there</p></html>',
    '<html><head><template><div data-aa-field="inert">x</div></template><title>T</title></head><body><p data-aa-field="headline">Hello there</p></body></html>',
  ]) {
    const unclosed = await scanHtml(html);
    assert.deepEqual({ html, names: unclosed.fields.map((field) => field.name), text: unclosed.clickableText }, { html, names: ['headline'], text: 'hellothere' });
  }
});

await check('head: non-whitespace text ends an unclosed <head>, as in a browser, and is body text', async () => {
  const page = '<html><head><title>T</title>Welcome to the example</html>';
  const scan = await scanHtml(page);
  assert.equal(scan.clickableText, 'welcometotheexample', JSON.stringify(scan));
  const report = computeFieldCoverage([titleEntry], new Map([['/', scan]]));
  assert.equal(report.totalFields, 1, `the headline is shown, so it counts: ${JSON.stringify(report)}`);
  // Also with a later <body> tag, which a browser merges into the implicit body.
  assert.equal((await scanHtml('<html><head><title>T</title>Welcome<body><p>there</p></body></html>')).clickableText, 'welcomethere');
  // Controls: whitespace keeps head mode, and title/style/script text is never body text.
  assert.equal((await scanHtml('<html><head>\n  <title>T</title>\n  <style>p{}</style><script>var x</script>\n</head><body><p>Hi</p></body></html>')).clickableText, 'hi');
  assert.equal((await scanHtml('<html><head><title>Welcome to the example</title><meta name="x" data-aa-field="headline"></head></html>')).clickableText, '');
});

await check('head: a block root in <head> still counts, as the integration picks roots by position among every [data-block-index]', async () => {
  const scan = await scanHtml('<html><head><meta data-block-index="0"></head><body><section data-block-index="0"></section><section data-block-index="1"></section></body></html>');
  assert.deepEqual(scan.blockIndexes, [0, 0, 1]);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
