/**
 * A date-time survives repeated saves in any time zone.
 *
 * Run: bun tests/date-round-trip.test.js
 *
 * The editor shows a date with a time of day in a `datetime-local` input, in
 * UTC. That input has no zone, so the value it submits (`2026-07-01T12:30`)
 * used to be saved as-is. A markdown entry read it back as UTC (YAML does), but
 * a JSON entry (a `file()` collection, `z.coerce.date()`) stored the zoneless
 * string, and the next render read it with `new Date()`, which means LOCAL
 * time: in London's summer each save moved the instant an hour earlier
 * (12:30Z, 11:30Z, 10:30Z...). Milliseconds were dropped too (.123Z -> .000Z).
 *
 * The check renders through the real generateForm into a happy-dom <form>,
 * reads it back with the real extractFormData, and serialises with the real
 * store serialisers, three times in a row. It runs once per time zone in a
 * child process (TZ must be set before the runtime reads it), and each child
 * first proves its zone took effect.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';

const ZONES = ['Europe/London', 'America/New_York', 'UTC'];

if (!process.env.AA_DATE_ROUND_TRIP_ZONE) {
  let failedZones = 0;
  for (const zone of ZONES) {
    const result = spawnSync(process.execPath, [import.meta.path], {
      env: { ...process.env, TZ: zone, AA_DATE_ROUND_TRIP_ZONE: zone },
      encoding: 'utf8',
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status !== 0) failedZones++;
  }
  console.log('='.repeat(40));
  console.log(`\n📊 ${ZONES.length - failedZones} of ${ZONES.length} zones passed.\n`);
  process.exit(failedZones === 0 ? 0 : 1);
}

// --- Child: one time zone ---------------------------------------------------

const zone = process.env.AA_DATE_ROUND_TRIP_ZONE;
const { Window } = await import('happy-dom');
const window = new Window({ url: 'http://localhost/' });
globalThis.window = window;
globalThis.document = window.document;
globalThis.FormData = window.FormData;
globalThis.CSS = window.CSS;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.Event = window.Event;

const { generateForm, extractFormData } = await import('../ui/form-generator.js');
const { serializeJson, serializeMarkdown, orderLike } = await import('../server/utils/content-format.js');
const matter = (await import('gray-matter')).default;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ [${zone}] ${name}`);
  } catch (error) {
    failed++;
    console.log(`❌ [${zone}] ${name}\n   ${String(error.stack || error.message).split('\n').join('\n   ')}`);
  }
}

/** Render `data` into a real form, optionally edit it, and read it back. */
function renderAndExtract(schema, data, edit = () => {}) {
  const form = document.createElement('form');
  form.innerHTML = generateForm(schema, data);
  document.body.appendChild(form);
  edit(form);
  const extracted = extractFormData(form, schema);
  form.remove();
  return extracted;
}

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    // z.date() / z.coerce.date(), as the schema parser emits them.
    when: { type: 'string', format: 'date', 'x-astroadmin-date': true },
  },
  required: ['title', 'when'],
};

// The process really is in the zone named, or every check below is vacuous.
check('control: the zone took effect', () => {
  const summerOffset = new Date(Date.UTC(2026, 6, 1, 12)).getTimezoneOffset();
  const expected = { 'Europe/London': -60, 'America/New_York': 240, UTC: 0 }[zone];
  assert.equal(summerOffset, expected);
});

/** A file() collection's JSON text through `saves` title-only edits. */
function saveJsonRepeatedly(text, saves) {
  let current = text;
  const history = [];
  for (let save = 1; save <= saves; save++) {
    const [entry] = JSON.parse(current);
    const extracted = renderAndExtract(SCHEMA, entry, (form) => {
      form.querySelector('[name="title"]').value = `Title ${save}`;
    });
    // As writeFileCollectionEntry does: the edited entry, in the original's order.
    const next = [orderLike(entry, { ...extracted, id: entry.id })];
    current = serializeJson(next, current);
    history.push(JSON.parse(current)[0]);
  }
  return history;
}

check('JSON: three title-only saves keep the exact instant, milliseconds included', () => {
  const original = '[\n  {\n    "id": "launch",\n    "title": "Launch",\n    "when": "2026-07-01T12:30:00.123Z"\n  }\n]\n';
  const history = saveJsonRepeatedly(original, 3);
  assert.equal(history[2].title, 'Title 3', 'positive control: the title edit was saved');
  for (const [index, entry] of history.entries()) {
    assert.equal(new Date(entry.when).toISOString(), '2026-07-01T12:30:00.123Z', `save ${index + 1}: ${entry.when}`);
  }
  // Unedited, the stored text is the original text.
  assert.equal(history[2].when, '2026-07-01T12:30:00.123Z');
});

check('JSON: a zoned instant with no milliseconds keeps its text', () => {
  const original = '[{"id": "launch", "title": "Launch", "when": "2026-07-01T12:30:00Z"}]\n';
  const history = saveJsonRepeatedly(original, 3);
  assert.equal(history[2].when, '2026-07-01T12:30:00Z');
});

check('JSON: an edited time is saved as that UTC instant and then stays put', () => {
  const original = '[{"id": "launch", "title": "Launch", "when": "2026-07-01T12:30:00Z"}]\n';
  const [entry] = JSON.parse(original);
  const edited = renderAndExtract(SCHEMA, entry, (form) => {
    const input = form.querySelector('[name="when"]');
    assert.equal(input.type, 'datetime-local', 'positive control: a datetime input');
    assert.equal(input.value, '2026-07-01T12:30', 'the input shows the UTC time');
    input.value = '2026-07-02T09:15';
  });
  assert.equal(new Date(edited.when).toISOString(), '2026-07-02T09:15:00.000Z', `edited value: ${edited.when}`);
  const text = serializeJson([{ ...edited, id: 'launch' }], original);
  const history = saveJsonRepeatedly(text, 3);
  for (const saved of history) assert.equal(new Date(saved.when).toISOString(), '2026-07-02T09:15:00.000Z', saved.when);
});

check('JSON: editing the day of a value with milliseconds keeps them', () => {
  const entry = { id: 'launch', title: 'Launch', when: '2026-07-01T12:30:00.123Z' };
  const edited = renderAndExtract(SCHEMA, entry, (form) => {
    const input = form.querySelector('[name="when"]');
    assert.equal(input.value, '2026-07-01T12:30:00.123', 'the input shows the milliseconds');
    input.value = '2026-07-02T12:30:00.123';
  });
  assert.equal(edited.when, '2026-07-02T12:30:00.123Z');
});

check('JSON: a date-only value stays date-only', () => {
  const original = '[{"id": "launch", "title": "Launch", "when": "2026-07-01"}]\n';
  const history = saveJsonRepeatedly(original, 2);
  assert.equal(history[1].when, '2026-07-01');
  const [entry] = JSON.parse(original);
  const edited = renderAndExtract(SCHEMA, entry, (form) => {
    const input = form.querySelector('[name="when"]');
    assert.equal(input.type, 'date');
    input.value = '2026-08-02';
  });
  assert.equal(edited.when, '2026-08-02');
});

/** A markdown entry through `saves` title-only edits, as the API does. */
function saveMarkdownRepeatedly(text, saves) {
  let current = text;
  const history = [];
  for (let save = 1; save <= saves; save++) {
    const parsed = matter(current, {});
    // The editor receives the entry as JSON: a Date arrives as its ISO string.
    const entry = JSON.parse(JSON.stringify(parsed.data));
    const extracted = renderAndExtract(SCHEMA, entry, (form) => {
      form.querySelector('[name="title"]').value = `Title ${save}`;
    });
    current = serializeMarkdown(parsed.content, extracted, current);
    history.push({ text: current, data: matter(current, {}).data });
  }
  return history;
}

check('markdown: three title-only saves keep the exact instant and its text', () => {
  const original = '---\ntitle: Launch\nwhen: 2026-07-01T12:30:00.123Z\n---\nBody\n';
  const history = saveMarkdownRepeatedly(original, 3);
  assert.equal(history[2].data.title, 'Title 3', 'positive control: the title edit was saved');
  for (const { data, text } of history) {
    assert.ok(data.when instanceof Date, `stays a YAML date: ${text}`);
    assert.equal(data.when.toISOString(), '2026-07-01T12:30:00.123Z', text);
  }
  assert.match(history[2].text, /^when: 2026-07-01T12:30:00\.123Z$/m);
});

check('markdown: an edited time is saved as that UTC instant', () => {
  const original = '---\ntitle: Launch\nwhen: 2026-07-01T12:30:00Z\n---\nBody\n';
  const entry = JSON.parse(JSON.stringify(matter(original, {}).data));
  const edited = renderAndExtract(SCHEMA, entry, (form) => {
    form.querySelector('[name="when"]').value = '2026-07-02T09:15';
  });
  const text = serializeMarkdown('Body\n', edited, original);
  const history = saveMarkdownRepeatedly(text, 2);
  for (const { data, text: saved } of history) assert.equal(data.when.toISOString(), '2026-07-02T09:15:00.000Z', saved);
});

check('a date-time string field (z.iso.datetime()) always gets a time, and saves a zoned instant', () => {
  const schema = { type: 'object', properties: { at: { type: 'string', format: 'date-time' } }, required: ['at'] };
  for (const value of ['2026-07-01T00:00:00Z', undefined]) {
    const edited = renderAndExtract(schema, value === undefined ? {} : { at: value }, (form) => {
      const input = form.querySelector('[name="at"]');
      assert.equal(input.type, 'datetime-local', `${value}: a date input would save YYYY-MM-DD`);
      input.value = '2026-07-02T00:00';
    });
    assert.equal(edited.at, '2026-07-02T00:00:00.000Z');
  }
  assert.deepEqual(renderAndExtract(schema, { at: '2026-07-01T00:00:00Z' }), { at: '2026-07-01T00:00:00Z' }, 'unedited: unchanged');
});

check('a zoneless stored timestamp is shown as UTC, as the serialiser reads it', () => {
  // Written by an older version: no zone. YAML and parseTimestamp read it as UTC.
  const form = document.createElement('form');
  form.innerHTML = generateForm(SCHEMA, { title: 'T', when: '2026-07-01T12:30' });
  assert.equal(form.querySelector('[name="when"]').value, '2026-07-01T12:30');
});

console.log(`[${zone}] ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
