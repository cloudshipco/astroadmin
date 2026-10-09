/**
 * The preview side of click-to-edit: the script the integration injects into
 * every preview page (integration/index.js), run for real in happy-dom inside
 * a stand-in iframe whose parent records what it is sent.
 *
 *   bun tests/preview-click.test.js
 */

import assert from 'assert';
import { Window } from 'happy-dom';
import { adminPreviewScript } from '../integration/index.js';

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

/**
 * A preview page with the injected script running in it.
 * @param {string} bodyHtml
 * @returns {{document: Document, posted: Array<Object>, click: (selector: string) => boolean, send: (data: Object) => void, highlighted: () => string[]}}
 */
function previewPage(bodyHtml, pathname = '/') {
  const pageWindow = new Window({ url: `http://localhost:4321${pathname}` });
  const { document } = pageWindow;
  document.body.innerHTML = bodyHtml;
  const posted = [];
  // The script checks it is inside an iframe (window.parent !== window), so
  // give it a frame whose parent records the messages.
  const frame = {
    parent: { postMessage: (message) => posted.push(message) },
    location: pageWindow.location,
    addEventListener: (...args) => pageWindow.addEventListener(...args),
    scrollTo() {},
  };
  new Function('window', 'document', adminPreviewScript)(frame, document);
  posted.length = 0; // drop the load-time pageNavigation
  return {
    document,
    posted,
    // Returns whether the click's default action (navigation) was left alone.
    click(selector) {
      const element = document.querySelector(selector);
      assert.ok(element, `no element for ${selector}`);
      const event = new pageWindow.MouseEvent('click', { bubbles: true, cancelable: true });
      return element.dispatchEvent(event);
    },
    send(data) {
      pageWindow.dispatchEvent(new pageWindow.MessageEvent('message', { data }));
    },
    highlighted() {
      return [...document.querySelectorAll('.aa-highlight')].map((element) => element.id);
    },
  };
}

const RICH_TEXT = `
  <section id="hero" data-aa-field="hero">
    <h1 id="title" data-aa-field="title">A title</h1>
    <div id="body" data-aa-field="body"><p id="para">Words with <a id="inline" href="/elsewhere"><em id="emph">a link</em></a> in them.</p></div>
    <a id="cta" class="button" href="/contact"><span id="cta-label">Get in touch</span></a>
    <a id="annotated-link" href="/x" data-aa-field="ctaLabel">Annotated link</a>
    <a id="anchor-no-href" data-aa-field="kicker">Not a link</a>
    <map><area id="area" href="/map" data-aa-field="mapLabel"></map>
  </section>`;

console.log('\n🧪 preview: click-to-edit clicks\n' + '='.repeat(40));

await check('a click on plain annotated text posts a fieldFocus for its field', () => {
  const page = previewPage(RICH_TEXT);
  page.click('#title');
  assert.equal(page.posted.length, 1);
  assert.equal(page.posted[0].type, 'fieldFocus');
  assert.equal(page.posted[0].field, 'title');
});

await check('a click on text inside an annotated element resolves to it (positive control for the link cases)', () => {
  const page = previewPage(RICH_TEXT);
  page.click('#para');
  assert.deepEqual(page.posted.map((message) => message.field), ['body']);
});

await check('a click on a link inside an annotated rich-text block posts nothing and is not cancelled', () => {
  const page = previewPage(RICH_TEXT);
  const notCancelled = page.click('#inline');
  assert.deepEqual(page.posted, [], 'the link navigates; no field is focused');
  assert.equal(notCancelled, true, 'the navigation must not be prevented');
});

await check('a click on an element INSIDE such a link posts nothing either', () => {
  const page = previewPage(RICH_TEXT);
  page.click('#emph');
  assert.deepEqual(page.posted, []);
});

await check('a CTA link inside an annotated section posts nothing', () => {
  const page = previewPage(RICH_TEXT);
  page.click('#cta-label');
  assert.deepEqual(page.posted, []);
});

await check('an annotation ON a link never fires (the link wins)', () => {
  const page = previewPage(RICH_TEXT);
  page.click('#annotated-link');
  page.click('#area');
  assert.deepEqual(page.posted, []);
});

await check('an <a> with no href does not navigate, so its annotation still fires', () => {
  const page = previewPage(RICH_TEXT);
  page.click('#anchor-no-href');
  assert.deepEqual(page.posted.map((message) => message.field), ['kicker']);
});

const CARDS = `
  <h1 id="page-title" data-aa-field="title">Home</h1>
  <ul>
    <li id="card-a" data-aa-entry="services/garden-design">
      <h3 id="card-a-title" data-aa-field="title">Garden design</h3>
      <p id="card-a-summary" data-aa-field="summary">Plans and planting.</p>
      <a id="card-a-link" href="/services/garden-design">Read more</a>
    </li>
    <li id="card-b" data-aa-entry="services/hedge-trimming">
      <h3 id="card-b-title" data-aa-field="title">Hedge trimming</h3>
      <p id="card-b-summary" data-aa-field="summary">Neat edges.</p>
    </li>
    <li id="card-c"><h3 id="card-c-title" data-aa-entry="services/tree-work" data-aa-field="title">Tree work</h3></li>
  </ul>`;

console.log('\n🧪 preview: entry-qualified annotations\n' + '='.repeat(40));

await check('a click on an unqualified annotation says it names no entry, and where the click was', () => {
  const page = previewPage(CARDS, '/');
  page.click('#page-title');
  assert.deepEqual(page.posted, [{ type: 'fieldFocus', field: 'title', entry: null, pathname: '/' }]);
});

await check('a click inside a card carries the entry from the nearest data-aa-entry ancestor', () => {
  const page = previewPage(CARDS, '/');
  page.click('#card-b-summary');
  assert.deepEqual(page.posted, [{ type: 'fieldFocus', field: 'summary', entry: 'services/hedge-trimming', pathname: '/' }]);
});

await check('data-aa-entry on the annotated element itself qualifies it', () => {
  const page = previewPage(CARDS, '/');
  page.click('#card-c-title');
  assert.equal(page.posted[0].entry, 'services/tree-work');
});

await check('the card\'s link still navigates and posts nothing', () => {
  const page = previewPage(CARDS, '/');
  page.click('#card-a-link');
  assert.deepEqual(page.posted, []);
});

await check('highlight: with a card\'s entry open, its field outlines THAT card, not the page title', () => {
  const page = previewPage(CARDS, '/');
  page.send({ type: 'highlightField', field: 'title', entry: 'services/hedge-trimming', pageEntry: false });
  assert.deepEqual(page.highlighted(), ['card-b-title']);
});

await check('highlight: the page\'s own entry outlines the unqualified element, not a card', () => {
  const page = previewPage(CARDS, '/');
  page.send({ type: 'highlightField', field: 'title', entry: 'pages/home', pageEntry: true });
  assert.deepEqual(page.highlighted(), ['page-title']);
});

await check('highlight: an entry with no card on this page outlines nothing', () => {
  const page = previewPage(CARDS, '/');
  page.send({ type: 'highlightField', field: 'title', entry: 'services/not-listed', pageEntry: false });
  assert.deepEqual(page.highlighted(), []);
});

await check('highlight: an entry\'s own page prefers its unqualified element over a card naming it', () => {
  const page = previewPage(`<li data-aa-entry="services/garden-design"><h3 id="related" data-aa-field="title">Garden design</h3></li>
    <h1 id="own" data-aa-field="title">Garden design</h1>`, '/services/garden-design');
  page.send({ type: 'highlightField', field: 'title', entry: 'services/garden-design', pageEntry: true });
  assert.deepEqual(page.highlighted(), ['own']);
});

await check('highlight: a message from an older editor (no entry) outlines the first match, as before', () => {
  const page = previewPage(CARDS, '/');
  page.send({ type: 'highlightField', field: 'summary' });
  assert.deepEqual(page.highlighted(), ['card-a-summary']);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
