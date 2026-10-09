/**
 * A quiet notice in the editor panel when the last publish's build showed
 * click-to-edit gaps (server/doctor/editor.js, GET /api/doctor/latest).
 *
 * Self-contained: it brings its own stylesheet (ui/doctor-notice.css), places
 * itself above the editor form, and refreshes when the dashboard announces a
 * publish with the `astroadmin:published` window event. Dismissing hides it
 * until a later publish produces a different result.
 */

const DOCS_URL = 'https://github.com/cloudshipco/astroadmin/blob/main/docs/doctor.md';
const DISMISS_KEY = 'astroadmin.doctorNotice.dismissed';
const NOTICE_CLASS = 'aa-doctor-notice';

/** Results worth a notice: something the built-HTML checks warned about. */
function problems(result) {
  return (result?.results || []).filter((item) => item.severity === 'warn' || item.severity === 'fail');
}

/** A key for one result, so a dismissal lasts until the result changes. */
export function resultKey(result) {
  const coverage = result.coverage ? `${result.coverage.covered}/${result.coverage.total}` : '-';
  return `${coverage}|${problems(result).map((item) => item.id).join(',')}`;
}

/**
 * The notice's text and link, or null when there is nothing to say (no result
 * yet, the scan was unavailable, or every check passed).
 * @param {Object|null} result - the API's `result`
 * @returns {{text: string, docsUrl: string}|null}
 */
export function describeDoctorResult(result) {
  if (!result || result.status !== 'ok') return null;
  const found = problems(result);
  if (found.length === 0) return null;
  const coverageProblem = found.find((item) => item.id === 'click-to-edit-coverage');
  const others = found.filter((item) => item !== coverageProblem);
  const parts = [];
  if (result.coverage) {
    parts.push(`Click-to-edit covers ${result.coverage.covered} of ${result.coverage.total} text fields on this site.`);
  }
  if (others.length > 0) {
    parts.push(`Also needs attention: ${others.map((item) => item.title).join('; ')}.`);
  }
  const anchor = (coverageProblem || found[0]).id;
  return { text: parts.join(' '), docsUrl: `${DOCS_URL}#${anchor}` };
}

function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(key) {
  try {
    localStorage.setItem(DISMISS_KEY, key);
  } catch {
    // storage unavailable: the dismissal lasts until reload
  }
}

/**
 * Build the notice element for a result, or null.
 * @param {Object|null} result
 * @param {Document} [doc]
 */
export function renderDoctorNotice(result, doc = document) {
  const description = describeDoctorResult(result);
  if (!description) return null;
  const notice = doc.createElement('div');
  notice.className = NOTICE_CLASS;
  notice.setAttribute('role', 'status');

  const text = doc.createElement('span');
  text.className = `${NOTICE_CLASS}-text`;
  text.textContent = `${description.text} `;
  const link = doc.createElement('a');
  link.href = description.docsUrl;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'How to fix';
  text.appendChild(link);
  notice.appendChild(text);

  const close = doc.createElement('button');
  close.type = 'button';
  close.className = `${NOTICE_CLASS}-close`;
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => {
    writeDismissed(resultKey(result));
    notice.remove();
  });
  notice.appendChild(close);
  return notice;
}

function ensureStylesheet() {
  if (document.querySelector(`link[data-${NOTICE_CLASS}]`)) return;
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = '/doctor-notice.css';
  stylesheet.setAttribute(`data-${NOTICE_CLASS}`, '');
  document.head.appendChild(stylesheet);
}

/** Fetch the latest result and show, replace or remove the notice. */
export async function refreshDoctorNotice() {
  let result = null;
  try {
    const response = await fetch('/api/doctor/latest');
    if (!response.ok) return;
    result = (await response.json()).result;
  } catch {
    return; // quiet: the notice is optional
  }
  document.querySelector(`.${NOTICE_CLASS}`)?.remove();
  if (!result || readDismissed() === resultKey(result)) return;
  const notice = renderDoctorNotice(result);
  const panel = document.querySelector('.editor-panel');
  if (!notice || !panel) return;
  ensureStylesheet();
  // Above the editor form, below the panel's own header.
  panel.insertBefore(notice, document.getElementById('editorForm'));
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.querySelector('.editor-panel')) {
  refreshDoctorNotice();
  window.addEventListener('astroadmin:published', () => refreshDoctorNotice());
}
