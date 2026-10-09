# Inline editing

Two things make a page editable in place:

1. Its content lives in a content collection, so the form can edit it.
   [Moving content out of templates](#moving-content-out-of-templates) covers
   that step.
2. Its templates are annotated for click-to-edit, so a click on text in the
   preview opens the right control, and focusing a control outlines its text
   in the preview. [Click-to-edit in the preview](#click-to-edit-in-the-preview)
   covers the attributes and the traps.

## Moving content out of templates

Text written straight into an `.astro` file can only be changed by editing
code. To make it editable, move it into an entry and have the template read
the entry. Keep the markup and styling in the template; only the words,
links and images move.

Take an about page with a heading, an introduction and a list of people.
Add a schema for it (or extend an existing `pages` collection):

```typescript
// src/content.config.ts
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({
    title: z.string(),
    intro: z.string(),
    team: z.array(z.object({
      name: z.string(),
      role: z.string(),
    })).default([]),
  }),
});

export const collections = { pages };
```

Move the text into `src/content/pages/about.md`:

```markdown
---
title: About us
intro: Founded in 2020, we build websites.
team:
  - name: Ada
    role: Engineer
  - name: Grace
    role: Designer
---
```

and read it in the template, which keeps its own markup:

```astro
---
// src/pages/about.astro
import { getEntry } from 'astro:content';

const page = await getEntry('pages', 'about');
const { title, intro, team } = page.data;
---
<section>
  <h1 data-aa-field="title">{title}</h1>
  <p data-aa-field="intro">{intro}</p>
</section>
<section>
  <h2>Our team</h2>
  {team.map((member) => (
    <div>
      <h3 data-aa-field="team">{member.name}</h3>
      <p data-aa-field="team">{member.role}</p>
    </div>
  ))}
</section>
```

Build the site before and after and compare the pages: the output should be
the same apart from the `data-aa-field` attributes. In AstroAdmin the entry
appears as `pages` / `about` and previews at `/about`. Convert one page at a
time.

## Click-to-edit in the preview

The editor's preview links to the sidebar in both directions:

- Preview to editor: clicking an element that carries `data-aa-field`
  focuses, scrolls to and briefly flashes the control that attribute names.
- Editor to preview: clicking a control outlines the element annotated
  with its name, and clicking a block's header outlines the block.

Nothing here changes how the site looks. The attributes are plain `data-*`
attributes, and the script that reads them is injected by the
`astroadmin()` integration only into the dev server the editor previews, never
into a production build. A site with no annotations still works; clicks in its
preview just do nothing.

`astroadmin doctor` checks most of what follows on the built site
([docs](./doctor.md)).

### Field names

The value of `data-aa-field` is the editor control's form name, exactly:

| What it edits | `data-aa-field` |
|---|---|
| A top-level field | `headline` |
| A nested field | `hero.title` |
| A field of a block | `blocks[2].heading` |
| A list of objects (see [Arrays](#arrays)) | `blocks[1].items` |
| One string in a list of strings | `credentials[2]` |
| A field of an item in a list of one-property objects | `points[0].text` |
| A Markdown entry's body | `body` |

Only controls have names. A nested object (`hero`), a whole block
(`blocks[2]`), a list of strings (`credentials`) and a single item of a list
edited as cards (`blocks[1].items[0]`) are not controls, so annotating one
does nothing.

A field inside a block is qualified with the block's index: `blocks[2].text`,
not `text`. In a template that maps over blocks, build the name from the
index:

```astro
{blocks.map((block, i) => (
  <section data-block-index={i}>
    <h2 data-aa-field={`blocks[${i}].heading`}>{block.heading}</h2>
  </section>
))}
```

A wrong name fails silently: the click is sent, the editor finds no control
with that name, and nothing happens. The doctor's `click-to-edit-names` check
reports names that match no field.

### Arrays

A list of objects (two or more properties each) is edited as a list of
cards with ONE named control, `blocks[1].items`. There is no control per item
or per item field: `blocks[1].items[0].title` names nothing. Annotate each
item's text with the list's name; a click scrolls to and flashes the list,
and the editor opens items from there.

```astro
{block.items.map((item) => (
  <article>
    <h3 data-aa-field={`blocks[${i}].items`}>{item.title}</h3>
    <p data-aa-field={`blocks[${i}].items`}>{item.body}</p>
  </article>
))}
```

A list of strings does get a control per item, so annotate each with its
own index: `credentials[2]`.

The list's control (like an image picker's) is a hidden input, which cannot
take focus. For those fields a click scrolls to and flashes the visible group
without focusing anything. That is the intended behaviour, not a bug.

### Blocks: `data-block-index`

When an editor clicks a block's header, the preview outlines the element whose
`data-block-index` is that block's index. Blocks are picked by position
among the page's `[data-block-index]` elements, not by the attribute's value,
so the attribute must go on:

- exactly one root element per rendered block,
- in the same order as the block list,
- with none nested inside another.

An element with the `hidden` attribute still takes a position (it is in the
page), so a hidden block root must still be in order. Content of a
`<template>` or `<noscript>` is not in the page and takes none.

Without any `data-block-index` on the page, the preview guesses by counting
top-level `<section>` elements, which goes wrong as soon as one block renders
as a `<figure>` or a `<div>`, or renders nothing. Every block after it is then
off by one, and nothing reports it except the doctor's `block-index` check.

### Cards from other entries

An annotation always means a field of the entry open in the editor, so a card
showing ANOTHER entry's text (services listed on the home page, say) cannot be
clicked to edit that entry yet. Leave such cards unannotated: a `title` on a
card would focus the open entry's `title`. Marking a card with
`data-aa-entry` is not supported yet; the doctor warns about it.

### Links

A click inside a link that navigates (`<a href>`, `<area href>`) belongs to
the link: the preview follows it and no field is focused. So:

- An element that contains a link can be annotated (since 1.5.0). A
  Markdown body with links in it, or a hero section with a button in it,
  focuses its field when clicked anywhere except on the link.
- An annotation on a link, or on an element inside one, can never fire.
  Annotate the text beside the link instead, and edit link labels from the
  sidebar. The doctor's `click-to-edit-links` check reports these.

Before 1.5.0 a click on a link inside an annotated element focused the field
and then navigated away, so sites avoided annotating anything that held a
link. That workaround is no longer needed.

### Components must pass the attribute on

A wrapper component that destructures a fixed list of props and renders its
own root element drops `data-aa-field`: it compiles,
renders nothing, and fails no test. Spread the rest of the props onto the root:

```astro
---
const { title, ...attrs } = Astro.props;
---
<h2 class="section-title" {...attrs}>{title}</h2>
```

The doctor measures the built HTML, so it sees an attribute a component
dropped.

### What cannot be annotated

- Media under a full-size overlay. An `<img>` covered by a text layer or a
  gradient never receives the click. Annotate the overlay (or the section),
  and nearer annotations inside it still win.
- Fields rendered only in `<head>`: a page `title`, SEO and Open Graph
  fields. Nothing there can be clicked; edit them from the sidebar. The doctor
  leaves them out of coverage.

### Keep template comments out of the markup

Two kinds of comment in a template change the output, so a comment added while
annotating can change how the site looks:

- Tailwind's class scanner reads comments. A comment containing a utility
  name ("hidden", "fixed", "block", "grid") makes Tailwind generate that class,
  and the stylesheet changes.
- Astro ships HTML comments. A `<!-- -->` comment in a template is sent to
  every visitor, and a `{/* */}` line between elements can add whitespace that
  shifts inline content.

Put explanations in the component's frontmatter (the `---` fence), which never
reaches the output.

### Verifying

1. Run the doctor from the site's directory. It builds the site and checks
   block indexes, coverage, names and links on the built
   HTML:

   ```bash
   npx astroadmin doctor
   ```

2. Prove the annotations are visually inert. Build the site before and
   after annotating, strip the attributes from both, and diff. Any difference
   left is a change a visitor would see (a stylesheet that changed because of
   a comment, extra whitespace):

   ```bash
   git worktree add ../site-before <commit-before-annotating>
   ln -s "$PWD/node_modules" ../site-before/node_modules
   (cd ../site-before && bun --no-install --bun node_modules/.bin/astro build --outDir /tmp/aa-before)
   bun --no-install --bun node_modules/.bin/astro build --outDir /tmp/aa-after
   find /tmp/aa-before /tmp/aa-after -name '*.html' -exec perl -pi -e 's/ data-(aa-field|block-index)="[^"]*"//g' {} +
   diff -r /tmp/aa-before /tmp/aa-after && echo "annotations are inert"
   ```

   Asset file names carry a hash of their content, so a stylesheet that
   changed shows up as a differing file name as well as differing content.
   Remove the worktree afterwards with `git worktree remove ../site-before`.

3. Click through the preview in the editor: a click on each kind of
   annotated element should focus its control, and a click on a link should
   navigate without focusing anything.

