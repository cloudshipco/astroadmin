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

// data-aa-entry (a card naming another entry) is not supported in this
// version: an annotation always means the entry open in the editor.
await check('an annotation inside a data-aa-entry card posts only its field: no entry, no page path', () => {
  const page = previewPage(`<h1 id="page-title" data-aa-field="title">Home</h1>
    <li data-aa-entry="services/garden-design"><h3 id="card-title" data-aa-field="title">Garden design</h3></li>`);
  page.click('#card-title');
  assert.deepEqual(page.posted, [{ type: 'fieldFocus', field: 'title' }]);
});

console.log('\n🧪 preview: highlightField\n' + '='.repeat(40));

await check('highlightField outlines the first element annotated with that field', () => {
  const page = previewPage(`${RICH_TEXT}<h2 id="second-title" data-aa-field="title">Again</h2>`);
  page.send({ type: 'highlightField', field: 'title' });
  assert.deepEqual(page.highlighted(), ['title']);
});

await check('highlightField for a field with no element (or not a string) outlines nothing', () => {
  const page = previewPage(RICH_TEXT);
  page.send({ type: 'highlightField', field: 'missing' });
  page.send({ type: 'highlightField', field: 42 });
  assert.deepEqual(page.highlighted(), []);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
