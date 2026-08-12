/**
 * Pure text transforms for the Markdown body toolbar.
 *
 * No DOM: each function takes the textarea value and the current selection
 * (start/end indices) and returns `{ value, selStart, selEnd }` — the new value
 * and the selection to restore. The DOM layer (markdown-toolbar.js) reads the
 * selection, calls one of these, writes back, and re-selects. Keeping the logic
 * here means it is unit-testable under plain `bun` with no browser, the same way
 * form-generator is tested.
 */

/** Toggle an inline wrapper (e.g. `**` bold, `*` italic) around the selection. */
export function wrapInline(value, start, end, marker) {
  const sel = value.slice(start, end);
  const m = marker.length;

  // `*` is one LAYER of a possibly longer run: `*`=italic, `**`=bold,
  // `***`=bold+italic. A run of `*` is the italic layer iff it is ODD, so toggle
  // by parity — this keeps italic idempotent over bold (`**cat**` <->
  // `***cat***`) instead of mistaking the `*` of `**` for our own wrapper,
  // whether the markers are just OUTSIDE the selection or selected with the
  // text. Backticks are NOT layered, so they use the plain exact-match toggle
  // below (not parity); a single-backtick span toggles off in one click, a rare
  // double-backtick span in two (one delimiter char removed per click).
  if (marker === '*') {
    const ch = marker;
    // A run the selection itself contains (author selected the markers).
    let inLeft = 0;
    while (sel[inLeft] === ch) inLeft++;
    let inRight = 0;
    while (sel[sel.length - 1 - inRight] === ch) inRight++;
    if (sel.length >= 2 && Math.min(inLeft, inRight) % 2 === 1) {
      const inner = sel.slice(1, -1);
      const value2 = value.slice(0, start) + inner + value.slice(end);
      return { value: value2, selStart: start, selEnd: start + inner.length };
    }
    // Otherwise the run just outside the selection.
    let left = 0;
    while (value[start - 1 - left] === ch) left++;
    let right = 0;
    while (value[end + right] === ch) right++;
    if (Math.min(left, right) % 2 === 1) {
      const value2 = value.slice(0, start - 1) + sel + value.slice(end + 1);
      return { value: value2, selStart: start - 1, selEnd: end - 1 };
    }
    const value2 = value.slice(0, start) + marker + sel + marker + value.slice(end);
    return { value: value2, selStart: start + 1, selEnd: end + 1 };
  }

  // Multi-char marker (`**` bold). Author selected including the markers → unwrap.
  if (sel.length >= 2 * m && sel.startsWith(marker) && sel.endsWith(marker)) {
    const inner = sel.slice(m, -m);
    const value2 = value.slice(0, start) + inner + value.slice(end);
    return { value: value2, selStart: start, selEnd: start + inner.length };
  }
  // Already wrapped just outside the selection → unwrap.
  if (
    start - m >= 0 &&
    value.slice(start - m, start) === marker &&
    value.slice(end, end + m) === marker
  ) {
    const value2 = value.slice(0, start - m) + sel + value.slice(end + m);
    return { value: value2, selStart: start - m, selEnd: end - m };
  }

  // Wrap. Empty selection → caret lands between the markers.
  const value2 = value.slice(0, start) + marker + sel + marker + value.slice(end);
  return { value: value2, selStart: start + m, selEnd: end + m };
}

/**
 * A blank line for list/heading purposes: empty, whitespace-only, or a bare
 * CRLF `\r` (lines are split on `\n`, so a CRLF blank keeps a trailing `\r`).
 * Trimming covers all three without disturbing the original line endings.
 */
function isBlank(line) {
  return line.trim() === '';
}

/** Range of full lines the selection touches: [lineStart, lineEnd) exclusive of the trailing newline. */
function lineRange(value, start, end) {
  // A non-empty selection ending exactly at a line start (right after a `\n`)
  // should NOT pull in the next line — the caret sits at the boundary, it
  // hasn't entered that line. Anchor the end to the last selected character.
  const effectiveEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = value.indexOf('\n', effectiveEnd);
  if (lineEnd === -1) lineEnd = value.length;
  return [lineStart, lineEnd];
}

/**
 * Apply a per-line transform over the selected lines and return the result with
 * the selection to restore. `blankLineForm(bare)` produces the "on" form; a
 * blank line is normally skipped, EXCEPT when the whole selection is blank (an
 * empty body or a single empty line) — there the marker must still apply, or the
 * button appears to do nothing. When only-blank, the caret collapses to the end
 * so the author types after the marker rather than replacing it.
 */
function transformLines(value, start, end, mapLine) {
  const [ls, le] = lineRange(value, start, end);
  const lines = value.slice(ls, le).split('\n');
  const onlyBlank = lines.every(isBlank);
  const out = lines.map((l, i) => mapLine(l, onlyBlank, i)).join('\n');
  const value2 = value.slice(0, ls) + out + value.slice(le);
  // Only-blank means we inserted a marker on an empty line: collapse the caret
  // to the end so typing continues the list/heading. Otherwise keep the whole
  // transformed block selected.
  if (onlyBlank) return { value: value2, selStart: ls + out.length, selEnd: ls + out.length };
  return { value: value2, selStart: ls, selEnd: ls + out.length };
}

/** Toggle a static line prefix (`> ` quote, `- ` bullet) on every selected line. */
export function toggleLinePrefix(value, start, end, prefix) {
  const [ls, le] = lineRange(value, start, end);
  const lines = value.slice(ls, le).split('\n');
  const onlyBlank = lines.every(isBlank);
  const allPrefixed = !onlyBlank && lines.every((l) => isBlank(l) || l.startsWith(prefix));
  return transformLines(value, start, end, (l) => {
    if (isBlank(l) && !onlyBlank) return l; // skip blanks inside a mixed selection
    if (allPrefixed) return l.slice(prefix.length);
    return l.startsWith(prefix) ? l : prefix + l; // don't double an existing prefix
  });
}

/** Set (or clear) a heading level on the selected lines. Re-clicking the same level clears it. */
export function setHeading(value, start, end, level) {
  const marker = '#'.repeat(level) + ' ';
  const headingRe = /^#{1,6} /;
  const [ls, le] = lineRange(value, start, end);
  const lines = value.slice(ls, le).split('\n');
  const onlyBlank = lines.every(isBlank);
  const allThisLevel = !onlyBlank && lines.every((l) => isBlank(l) || l.startsWith(marker));
  return transformLines(value, start, end, (l) => {
    if (isBlank(l) && !onlyBlank) return l;
    const bare = l.replace(headingRe, ''); // normalise any existing heading level
    return allThisLevel ? bare : marker + bare;
  });
}

/** Toggle an ordered list on the selected lines, numbering from 1. */
export function toggleOrderedList(value, start, end) {
  const orderedRe = /^\d+\. /;
  const [ls, le] = lineRange(value, start, end);
  const lines = value.slice(ls, le).split('\n');
  const onlyBlank = lines.every(isBlank);
  const allNumbered = !onlyBlank && lines.every((l) => isBlank(l) || orderedRe.test(l));
  let n = 0;
  return transformLines(value, start, end, (l) => {
    if (isBlank(l) && !onlyBlank) return l;
    if (allNumbered) return l.replace(orderedRe, '');
    n += 1;
    return `${n}. ${l.replace(orderedRe, '')}`; // strip any existing number before renumbering
  });
}

/**
 * Fence the selected line(s) as a code block, or unfence them if they sit inside
 * one. Works on whole lines (so the ``` markers land on their own line rather
 * than mid-text) and pairs fence lines document-wide, so a caret anywhere in a
 * multi-line block toggles the whole block off instead of nesting a new fence.
 *
 * Known minor limitations (documented, uncommon in practice): an UNCLOSED
 * opening fence (odd number of `` ``` `` lines) isn't paired, so a caret below it
 * wraps rather than toggling; and a selection spanning TWO separate fenced
 * blocks wraps both rather than merging/unfencing them. Both produce awkward but
 * recoverable markup, not data loss.
 */
export function codeBlock(value, start, end) {
  const fenceLine = /^```\r?$/; // a whole line that is just a fence (LF or CRLF)
  const lines = value.split('\n');
  // Char offset of each line start, to map positions <-> line indices.
  const lineStart = [];
  { let pos = 0; for (const l of lines) { lineStart.push(pos); pos += l.length + 1; } }
  const lineAt = (pos) => {
    for (let i = lines.length - 1; i >= 0; i--) if (pos >= lineStart[i]) return i;
    return 0;
  };
  // A selection ending exactly at a line start hasn't entered that line.
  const effEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const firstLine = lineAt(start);
  const lastLine = lineAt(effEnd);

  // Fence lines pair up in document order (open, close, open, close, …).
  const fences = [];
  lines.forEach((l, i) => { if (fenceLine.test(l)) fences.push(i); });
  for (let p = 0; p + 1 < fences.length; p += 2) {
    const open = fences[p];
    const close = fences[p + 1];
    // The selection lies within this block (inclusive of its fence lines) → off.
    if (firstLine >= open && lastLine <= close) {
      const kept = [...lines.slice(0, open), ...lines.slice(open + 1, close), ...lines.slice(close + 1)];
      let value2 = kept.join('\n');
      // Only when the closing fence was at EOF did the last inner line keep the
      // CRLF `\r` that separated it from that fence — drop just that orphan (not
      // an unrelated trailing `\r` further down the document).
      if (close === lines.length - 1 && value2.endsWith('\r')) value2 = value2.slice(0, -1);
      // Reselect the former inner content, excluding the trailing CRLF `\r` that
      // separated it from the closing fence (internal CRLFs are kept).
      let inner = lines.slice(open + 1, close).join('\n');
      if (inner.endsWith('\r')) inner = inner.slice(0, -1);
      const selStart = Math.min(lineStart[open], value2.length); // inner starts where `open` was
      return { value: value2, selStart, selEnd: Math.min(selStart + inner.length, value2.length) };
    }
  }

  // Not inside a block → wrap the selected lines. Line-aligned, so the fences
  // land on their own lines.
  const ls = lineStart[firstLine];
  const le = lineStart[lastLine] + lines[lastLine].length;
  const inside = value.slice(ls, le);
  const block = '```\n' + inside + '\n```';
  const value2 = value.slice(0, ls) + block + value.slice(le);
  const innerStart = ls + 4; // after "```\n"
  return { value: value2, selStart: innerStart, selEnd: innerStart + inside.length };
}

/**
 * Insert a link. Selection becomes the label; caret lands on the URL so the
 * author can type it. If a url is supplied it is inserted and the label selected.
 */
export function insertLink(value, start, end, url = '') {
  const label = value.slice(start, end) || 'link text';
  const snippet = `[${label}](${url})`;
  const value2 = value.slice(0, start) + snippet + value.slice(end);
  if (url) {
    // Select the label for quick replacement.
    return { value: value2, selStart: start + 1, selEnd: start + 1 + label.length };
  }
  // Caret inside the empty parens.
  const caret = start + label.length + 3; // '[' + label + ']('
  return { value: value2, selStart: caret, selEnd: caret };
}

/**
 * Insert an image. `![alt](url)`. If alt is empty the caret selects the word
 * `alt` so the author can type alt text (accessibility); the site also renders
 * from a real src, so url is always supplied by the image library.
 */
export function insertImage(value, start, end, url, alt = '') {
  const altText = alt || 'alt';
  const snippet = `![${altText}](${url})`;
  const value2 = value.slice(0, start) + snippet + value.slice(end);
  if (alt) {
    const caret = start + snippet.length;
    return { value: value2, selStart: caret, selEnd: caret };
  }
  // Select the placeholder alt word.
  return { value: value2, selStart: start + 2, selEnd: start + 2 + altText.length };
}
