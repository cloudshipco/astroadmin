/**
 * The editor's click-to-edit notice (ui/doctor-notice.js), in happy-dom:
 * what it says for each kind of result, that it stays quiet when there is
 * nothing to say, and that a dismissal lasts until the result changes.
 *
 *   bun tests/doctor-notice.test.js
 */

import assert from 'assert';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost/dashboard' });
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;

const { describeDoctorResult, renderDoctorNotice, resultKey } = await import('../ui/doctor-notice.js');

const coverageWarn = { id: 'click-to-edit-coverage', title: 'Click-to-edit coverage', severity: 'warn' };
const linksWarn = { id: 'click-to-edit-links', title: 'No data-aa-field on links', severity: 'warn' };
const pass = (id) => ({ id, title: id, severity: 'pass' });

const partial = { status: 'ok', commit: 'abc1234', coverage: { covered: 0, total: 31 }, results: [pass('block-index'), coverageWarn, pass('click-to-edit-links')] };

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

console.log('\n🧪 doctor: the editor notice\n' + '='.repeat(40));

check('a coverage gap says how many fields click-to-edit reaches, linking to the docs', () => {
  assert.deepEqual(describeDoctorResult(partial), {
    text: 'Click-to-edit covers 0 of 31 text fields on this site.',
    docsUrl: 'https://github.com/cloudshipco/astroadmin/blob/main/docs/doctor.md#click-to-edit-coverage',
  });
});

check('other click-to-edit warnings are named after the coverage', () => {
  const result = { ...partial, coverage: { covered: 30, total: 31 }, results: [pass('click-to-edit-coverage'), linksWarn] };
  assert.deepEqual(describeDoctorResult(result), {
    text: 'Click-to-edit covers 30 of 31 text fields on this site. Also needs attention: No data-aa-field on links.',
    docsUrl: 'https://github.com/cloudshipco/astroadmin/blob/main/docs/doctor.md#click-to-edit-links',
  });
});

check('quiet when there is nothing to say: no result, unavailable, or all passing', () => {
  assert.equal(describeDoctorResult(null), null);
  assert.equal(describeDoctorResult({ status: 'unavailable', reason: 'timeout' }), null);
  assert.equal(describeDoctorResult({ ...partial, coverage: { covered: 31, total: 31 }, results: [pass('click-to-edit-coverage')] }), null);
  assert.equal(renderDoctorNotice(null, document), null);
});

check('the notice renders the text, a docs link that opens a new tab, and a dismiss button', () => {
  const notice = renderDoctorNotice(partial, document);
  document.body.appendChild(notice);
  assert.equal(notice.getAttribute('role'), 'status');
  assert.match(notice.textContent, /Click-to-edit covers 0 of 31 text fields on this site\. How to fix/);
  const link = notice.querySelector('a');
  assert.equal(link.getAttribute('href'), 'https://github.com/cloudshipco/astroadmin/blob/main/docs/doctor.md#click-to-edit-coverage');
  assert.equal(link.getAttribute('target'), '_blank');
  notice.querySelector('button').click();
  assert.equal(document.querySelector('.aa-doctor-notice'), null, 'dismissed');
  assert.equal(localStorage.getItem('astroadmin.doctorNotice.dismissed'), resultKey(partial));
});

check('a dismissal is keyed to the result, so a changed result shows again', () => {
  const changed = { ...partial, coverage: { covered: 12, total: 31 } };
  assert.notEqual(resultKey(changed), resultKey(partial));
  assert.equal(resultKey({ ...partial, commit: 'def5678' }), resultKey(partial), 'a new commit with the same gaps stays dismissed');
});

check('text from the result is set as text, never parsed as markup', () => {
  const hostile = { ...partial, coverage: null, results: [{ id: 'click-to-edit-names', title: '<img src=x onerror=alert(1)>', severity: 'warn' }] };
  const notice = renderDoctorNotice(hostile, document);
  assert.equal(notice.querySelector('img'), null);
  assert.match(notice.textContent, /<img src=x/);
});

console.log('='.repeat(40));
console.log(`\n📊 ${passed} checks passed.\n`);
await window.happyDOM.close();
