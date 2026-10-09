# astroadmin doctor

Several AstroAdmin features only work when the site's templates and setup
cooperate. Click-to-edit needs `data-aa-field` on the right elements; the
publish check needs a repository layout it can reproduce. When either is
missing, nothing breaks loudly: a click in the preview just does nothing, or
the first publish on a new host fails. `astroadmin doctor` checks for these
problems and reports each one with a link to the section below that explains
it.

Every check names the AstroAdmin version that added the feature it checks.
When you upgrade, a check marked with a newer version than you had is a
feature your site may not use yet.

## Running it

```bash
bunx astroadmin doctor
```

From the site's directory, or name it:

```bash
bunx astroadmin doctor --project ../site-a
```

| Option | Effect |
|---|---|
| `--project <path>` | The Astro project to check (default: the current directory). |
| `--build <distDir>` | Check an existing build instead of building. Without it, the site is built into a temporary directory with the site's own installed Astro, which is deleted afterwards (see [build-runs](#build-runs)). A directory that is missing or holds no HTML pages fails `build-runs`. |
| `--json` | Print the report as JSON on stdout (progress goes to stderr), for CI or a dashboard that shows several sites at once. |

The exit code is 1 when any check **fails**, otherwise 0. Warnings do not
change the exit code.

Each result is one of:

- **pass**: the feature is set up.
- **warn**: something works less well than it could (missing click-to-edit
  coverage, say). The site still builds and publishes.
- **fail**: something stops publishing or the editor from working.
- **skip**: the check does not apply (the site does not use Astro images, or
  there is no build to read).

Example output, trimmed:

```text
astroadmin doctor 1.4.8 — /srv/sites/site-a

✓ PASS Astro integration (since 0.2.0)
       astroadmin() is in astro.config.mjs.
...
! WARN Click-to-edit coverage (since 1.4.1)
       Click-to-edit reaches 0 of 18 text fields (0%): pages 0/18.
         pages: 1 of 1 entries have gaps, e.g. home on / misses blocks[0].title, ...
       https://github.com/cloudshipco/astroadmin/blob/main/docs/doctor.md#click-to-edit-coverage

8 passed, 2 warnings, 0 failed, 1 skipped.
```

### JSON

```json
{
  "version": "1.4.8",
  "projectRoot": "/srv/sites/site-a",
  "ok": true,
  "counts": { "pass": 8, "warn": 2, "fail": 0, "skip": 1 },
  "results": [
    {
      "id": "click-to-edit-coverage",
      "title": "Click-to-edit coverage",
      "since": "1.4.1",
      "severity": "warn",
      "message": "Click-to-edit reaches 0 of 18 text fields (0%): pages 0/18.",
      "details": ["..."],
      "docs": "https://github.com/cloudshipco/astroadmin/blob/main/docs/doctor.md#click-to-edit-coverage",
      "data": { "totalFields": 18, "coveredFields": 0, "entries": ["..."] }
    }
  ]
}
```

`data`, where present, is the check's raw report (per-entry field lists for
coverage, per-page block indexes for `block-index`).

## In the editor

The editor runs the built-HTML checks (the last four below) after every
publish whose build check passes. It reads the build that check has just made,
so it costs no extra build, and it reads the entries, schemas and routes from
the same commit (the check's worktree), not the live files an autosave may
have changed since. The scan runs in a separate process that is stopped when
it passes its cap of three seconds, so a slow scan cannot hold up the publish.
An error or a timeout only means there is no result this time: it never fails
or holds up the publish. The reason shown for it is short and names no server
path; the full error is in the server log.

When the checks find something, a small notice appears above the editor form,
for example "Click-to-edit covers 0 of 31 text fields on this site. How to
fix". Dismissing it hides it until a later publish gives a different result.
The latest result is also at `GET /api/doctor/latest` (signed in). It is kept
in memory, so after a restart there is no result until the next publish.

To turn the editor's scan off, set `doctor: { enabled: false }` in
`astroadmin.config.js`.

## The checks

### astro-integration

*Since 0.2.0. Fails when missing.*

`astro.config` must import `astroadmin/integration` and call it in
`integrations`. Without it the preview has no click-to-edit, no block focus and
no component previews.

```js
import astroadmin from 'astroadmin/integration';

export default defineConfig({
  integrations: [astroadmin()],
});
```

Only the exported config counts: a call of `astroadmin()` elsewhere in the
file (`const unused = astroadmin()`) does not install it. The check follows
the exported `integrations` through a `defineConfig()` wrapper, a `const`
holding the array (or the whole config), spreads of such arrays (`[...base]`)
and a `const` holding the call (`const admin = astroadmin()`).

The config is parsed, not run, so a config built up dynamically may not be
readable. When `integrations` is something else (a function call, a
condition, a `let`, or a later `...spread` that may replace it) the check
warns that it could not verify it.

### hosted-preview-config

*Since 1.3.0. Warns.*

A hosted editor shows the preview from its own subdomain through a proxy. Vite
refuses requests for hosts it does not know, and its HMR websocket cannot cross
the proxy, so the site needs:

```js
vite: {
  server: {
    allowedHosts: ['.admin.example.com', 'localhost'],
    hmr: false,
  },
},
```

The editor refreshes the preview itself after a save, so nothing is lost by
turning HMR off.

Properties are read the way JavaScript applies them: the last one wins. A
`...spread` or computed key after the setting (or with no plain setting at
all) may change it, so the check warns that it could not verify the value;
one before the setting does not matter.

### committed-lockfile

*Since 1.3.0. Warns.*

A hosted editor installs the site's dependencies with
`bun install --frozen-lockfile`. Without a committed `bun.lock` it installs
whatever versions resolve on the day, which may not be what the site was built
and tested with. The check reads the last commit (`HEAD`), so a lockfile that
is only staged, or a repository with no commits, warns.

### no-submodules

*Since 1.4.8. Fails.*

The publish check builds the exact commit in a throwaway git worktree, and a
worktree does not populate submodules: content kept in one would be checked as
empty. So the publish check refuses a site whose tree has any submodule (a
mode 160000 entry) and nothing is published. Move the content into the
repository.

### no-workspace-links

*Since 1.4.8. Fails.*

If a package in `node_modules` is a link back into the site's own repository
(a workspace package), the publish check's build would read the live,
uncommitted copy of it rather than the commit. The publish check refuses such
sites. This check uses the same detection as the publish check.

### sharp-loads

*Since 1.4.8. Fails when it cannot load; skipped when not needed.*

A site that uses `astro:assets` (or `image()` in a content schema) needs sharp
to build. Since the publish check runs the build on the editor's host, a sharp
that cannot load there (a missing system library, a wrong platform binary)
stops every publish. The check loads sharp from the site, in the same runtime
as the publish check (Bun), and makes a 1x1 image.

### build-runs

*Since 1.4.8. Fails when the build fails.*

The CLI builds the site into a temporary directory (unless `--build` is
given) and fails if the build does, or if it writes no HTML pages. The
built-HTML checks below need that build.

It runs the site's own installed Astro: the `bin` of `node_modules/astro` in
the site's directory, or in a directory above it up to the repository root
(a monorepo with hoisted `node_modules`), with Bun's auto-install turned off.
A site with no Astro installed fails with "astro is not installed": a package
runner such as `bunx` would instead fetch and run whatever Astro the registry
has that day, which is not what the site builds with.

### block-index

*Since 0.2.0. Warns.*

Every rendered block root should carry `data-block-index` with the block's
position in the entry's block list. When an editor focuses a block's control,
the preview highlights the block's element, picked by its POSITION among the
page's `data-block-index` elements (not by the attribute's value). Without
any, the preview guesses, by counting top-level `<section>` elements, and
highlights the wrong one as soon as one block renders as something else (a
`<figure>`, a `<div>`) or renders nothing.

So the check wants exactly `0, 1, ... n-1` in page order for an entry with `n`
blocks: it reports a missing index, a duplicate, an extra root (more roots
than blocks, or an index past the end), a root nested inside another, and
roots out of order. An entry whose page was not built is reported as not
checked, and the check then does not pass. A page whose entry has two block
lists is only checked for the indexes' presence.

```astro
{blocks.map((block, i) => (
  <section data-block-index={i}>...</section>
))}
```

The check compares each entry's block list with the indexes on its built page.
See [Blocks](./inline-editing.md#blocks-data-block-index) for the rules.

### click-to-edit-coverage

*Since 1.4.1. Warns below 80%.*

Clicking an element in the preview focuses the editor control named by the
nearest `data-aa-field` around it. The value is the control's form name:

| Field | `data-aa-field` |
|---|---|
| A top-level field | `headline` |
| A nested field | `hero.title` |
| A field of a block | `blocks[2].heading` (the block's index, then the field) |
| An item list inside a block | `blocks[3].items` (the list's control) |
| A Markdown entry's body | `body` |
| A field of ANOTHER entry shown as a card | `title`, with `data-aa-entry="services/garden-design"` on the card |

The check measures the **built** HTML, not the templates, so it sees what the
preview actually renders, including an attribute a wrapper component dropped.
What a visitor never sees is left out: annotations and text inside
`<template>`, `<noscript>`, `<script>` or `<style>`, or inside an element with
the `hidden` attribute, do not count. `aria-hidden="true"` hides an element
from screen readers only, so it still counts. CSS (`display: none`) is not
evaluated. A page with no `<body>` tag is read as if it had one.

A name counts when it is the name of the editor control the field is edited
through, exactly as the editor's form renders it: the field's own control,
or the one list control that holds it (`blocks[3].items` for every field of
every item). Annotating a nested object (`hero` for `hero.title`) or a whole
block (`blocks[2]`) covers nothing, since neither is a control.
For each entry, it counts the entry's text fields and how many have a matching
`data-aa-field` (themselves, or the list that holds them) where the entry is
shown: on its own page (a `pages` entry at `/<slug>`, or a collection's preview
route), and as a card on any built page whose annotations name it with
`data-aa-entry` (since 1.4.9). A field reached in either place counts. An
annotation qualified with another entry never counts for the page's own
entry, and an entry with no page of its own and no card is not counted at all.

Only text a visitor reads counts. Left out: ids, slugs, links and URLs, image
and alt fields, dates, enums, page metadata (`meta*`, `seo*`, `og*`), fields
no control can focus (a gallery's items), and any field whose text is not
visible on the page outside a link (a page `<title>`, a button label). The
report says how many fields were left out that way.

The check passes only on positive evidence: at least 80% coverage, and every
entry with a page of its own had that page in the build. An entry whose page
was not built is named in the message and keeps the check at a warning. An
entry with no page of its own and no card naming it is listed as on no built
page, and not counted.

Coverage is reported per collection, since the entries of one collection share
a template: a site can have well annotated pages and an FAQ list with none.

The full conventions, with examples, are in
[Click-to-edit in the preview](./inline-editing.md#click-to-edit-in-the-preview).
Three traps the check cannot see directly, worth knowing when annotating:

- **Annotate the element the click lands on.** An annotated `<img>` behind a
  full-size text layer is never reached; annotate the containing section, and
  nearer annotations inside it still win.
- **A wrapper component must pass the attribute on.** A component that renders
  its own root element without spreading its other props drops
  `data-aa-field`. Measuring the build catches this one.
- **A block root that is not a `<section>`** needs `data-block-index` (see
  above).

### click-to-edit-names

*Since 1.4.1. Warns.*

Every `data-aa-field` on a page should name an editor control of an entry
shown on that page (a field the schema declares counts even when the entry
leaves it empty). The controls are the ones the editor's form renders, so
`hero` (a nested object), `credentials` (a list of strings, whose items are
`credentials[0]`...) and `cards[0].title` (an item field of a list edited as
cards, whose control is `cards`) are all reported.
One inside a `data-aa-entry` must name a field of that entry. A name that
matches nothing does nothing when clicked. The usual cause is a block field
annotated without its index (`heading` where the control is
`blocks[2].heading`), or a typo.

Every `data-aa-entry` must name an existing entry as `<collection>/<slug>`,
on any built page, including pages no entry owns (a listing page). A card
naming a renamed or deleted entry does nothing when clicked.

See [Field names](./inline-editing.md#field-names) and
[Cards from other entries](./inline-editing.md#cards-from-other-entries).

### click-to-edit-links

*Since 1.4.1. Warns.*

A click inside a link that navigates (`<a href>`, `<area href>`) belongs to the
link: the preview follows it and no field is focused. So `data-aa-field` on a
link, or on an element inside one, can never fire. Annotate the text beside the
link instead, and leave link labels to be edited from the sidebar.

An annotated element that *contains* a link is fine (since 1.4.9): a click on
the link navigates, and a click anywhere else in the element focuses its
field. A Markdown body with links in it, or a hero section with a button, can
be annotated as a whole.

See [Links](./inline-editing.md#links) in the click-to-edit conventions.

## Adding a check

Checks live in `server/doctor/checks.js`, one entry each:

```js
{
  id: 'my-feature',          // also this page's anchor
  since: '1.5.0',            // the version that added the feature
  phase: 'built',            // 'static', 'build' or 'built'
  title: 'My feature is set up',
  async run(context) {
    // context.projectRoot, context.distDir, context.astroConfig(), context.built()
    return { severity: 'warn', message: '...', details: ['...'] };
  },
}
```

Add a section here with the same id as its heading, and a test that shows the
check going red on a site without the feature.
