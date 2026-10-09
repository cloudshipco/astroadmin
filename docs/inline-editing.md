# Inline Editing

Two things make a page editable in place:

1. **Its content lives in a content collection**, so the sidebar can edit it.
   [Converting template pages](#converting-template-pages) below covers moving
   hardcoded `.astro` content into collections.
2. **Its templates are annotated for click-to-edit**, so a click on text in
   the preview opens the right control, and focusing a control outlines its
   text in the preview. [Click-to-edit in the preview](#click-to-edit-in-the-preview)
   covers the attributes and the traps.

## Converting template pages

This part explains how to convert your Astro pages from hardcoded template files to content collections that can be edited through AstroAdmin's sidebar.

### Understanding the Difference

#### Template Pages (Static)

Template pages are `.astro` files in `src/pages/` with hardcoded content:

```astro
---
// src/pages/index.astro
import Layout from '../layouts/Layout.astro';
---

<Layout>
  <h1>Welcome to Our Site</h1>
  <p>This is hardcoded content that requires code changes to edit.</p>
</Layout>
```

**Limitations:**
- Requires code access to edit content
- Changes need deployment
- No admin interface

#### Content Collections (Editable)

Content collections store your content in JSON or Markdown files with a defined schema:

```typescript
// src/content/config.ts
import { defineCollection, z } from 'astro:content';

const pages = defineCollection({
  type: 'data',
  schema: z.object({
    title: z.string(),
    description: z.string(),
  }),
});

export const collections = { pages };
```

```json
// src/content/pages/home.json
{
  "title": "Welcome to Our Site",
  "description": "This content can be edited in AstroAdmin!"
}
```

**Benefits:**
- Edit through AstroAdmin sidebar
- Live preview while editing
- No code changes needed
- Schema validation

### Step-by-Step Conversion

#### Step 1: Identify Your Content

Look at your template page and identify what content should be editable:

```astro
---
// src/pages/about.astro - BEFORE
---
<Layout>
  <section class="hero">
    <h1>About Our Company</h1>
    <p>Founded in 2020, we build amazing things.</p>
  </section>
  <section class="team">
    <h2>Our Team</h2>
    <!-- team members hardcoded here -->
  </section>
</Layout>
```

Editable content: title, description, team members.

#### Step 2: Define the Schema

Create a content collection schema that matches your content structure:

```typescript
// src/content/config.ts
import { defineCollection, z } from 'astro:content';

const pages = defineCollection({
  type: 'data',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    team: z.array(z.object({
      name: z.string(),
      role: z.string(),
      image: z.string().optional(),
    })).optional(),
  }),
});

export const collections = { pages };
```

#### Step 3: Create the Content File

Move your content to a JSON file:

```json
// src/content/pages/about.json
{
  "title": "About Our Company",
  "description": "Founded in 2020, we build amazing things.",
  "team": [
    { "name": "Jane Doe", "role": "CEO" },
    { "name": "John Smith", "role": "CTO" }
  ]
}
```

#### Step 4: Update Your Template

Modify your page to read from the content collection:

```astro
---
// src/pages/about.astro - AFTER
import { getEntry } from 'astro:content';
import Layout from '../layouts/Layout.astro';

const page = await getEntry('pages', 'about');
const { title, description, team } = page.data;
---
<Layout>
  <section class="hero">
    <h1>{title}</h1>
    <p>{description}</p>
  </section>
  {team && (
    <section class="team">
      <h2>Our Team</h2>
      {team.map(member => (
        <div class="team-member">
          <h3>{member.name}</h3>
          <p>{member.role}</p>
        </div>
      ))}
    </section>
  )}
</Layout>
```

#### Step 5: Verify in AstroAdmin

1. Run `npx astroadmin dev`
2. Select "pages" > "about" from the dropdown
3. Edit your content in the sidebar
4. See changes live in the preview

### Common Patterns

#### Simple Text Page

**Schema:**
```typescript
const pages = defineCollection({
  type: 'data',
  schema: z.object({
    title: z.string(),
    content: z.string(),
  }),
});
```

#### Page with Hero and Features

**Schema:**
```typescript
const pages = defineCollection({
  type: 'data',
  schema: z.object({
    hero: z.object({
      title: z.string(),
      subtitle: z.string().optional(),
      image: z.string().optional(),
    }),
    features: z.array(z.object({
      title: z.string(),
      description: z.string(),
      icon: z.string().optional(),
    })),
  }),
});
```

#### Page with Blocks (Flexible Layouts)

For pages with varying sections, use discriminated unions:

```typescript
const blockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hero'),
    title: z.string(),
    subtitle: z.string().optional(),
  }),
  z.object({
    type: z.literal('text'),
    content: z.string(),
  }),
  z.object({
    type: z.literal('gallery'),
    images: z.array(z.object({
      src: z.string(),
      alt: z.string(),
    })),
  }),
]);

const pages = defineCollection({
  type: 'data',
  schema: z.object({
    title: z.string(),
    blocks: z.array(blockSchema),
  }),
});
```

See [Content Collections](./content-collections.md) for more schema examples.

### Tips

#### Keep Your Layouts

Don't move layout/styling code to content. Content collections should only contain _content_, not markup:

```typescript
// Good: just the data
schema: z.object({
  title: z.string(),
  buttonText: z.string(),
  buttonUrl: z.string(),
})

// Bad: including HTML/markup in content
schema: z.object({
  heroHtml: z.string(), // Don't do this
})
```

#### Use Descriptive Field Names

AstroAdmin generates labels from field names. Use clear names:

```typescript
// Clear field names
schema: z.object({
  heroTitle: z.string(),        // Shows as "Hero Title"
  ctaButtonText: z.string(),    // Shows as "Cta Button Text"
})
```

#### Start Small

Convert one page at a time. Start with simple pages before tackling complex ones with blocks.

## Click-to-edit in the preview

The editor's preview links to the sidebar in both directions:

- **Preview to editor.** Clicking an element that carries `data-aa-field`
  focuses, scrolls to and briefly flashes the control that attribute names.
- **Editor to preview.** Clicking a control outlines the element annotated
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

A list of **objects** (two or more properties each) is edited as a list of
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

A list of **strings** does get a control per item, so annotate each with its
own index: `credentials[2]`.

The list's control (like an image picker's) is a hidden input, which cannot
take focus. For those fields a click scrolls to and flashes the visible group
without focusing anything. That is the intended behaviour, not a bug.

### Blocks: `data-block-index`

When an editor clicks a block's header, the preview outlines the element whose
`data-block-index` is that block's index. Blocks are picked by **position**
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

The editor edits one entry at a time, and an unqualified `data-aa-field` means
a field of the entry the page is for. A page often also shows cards from
OTHER entries: a services collection listed on the home page, testimonials,
projects. To make those clickable, put `data-aa-entry` on the card (or any
ancestor of the annotated elements):

```astro
---
const services = await getCollection('services');
---
<ul>
  {services.map((service) => (
    <li data-aa-entry={`services/${service.id}`}>
      <h3 data-aa-field="title">{service.data.title}</h3>
      <p data-aa-field="summary">{service.data.summary}</p>
      <a href={`/services/${service.id}`}>Read more</a>
    </li>
  ))}
</ul>
```

The rules (since 1.4.9):

- The value is `<collection>/<slug>`, with the slug the editor uses for the
  entry (its id, as listed in the editor's entry picker). A collection name has
  no slash, so everything after the first slash is the slug, and nested slugs
  (`articles/2024/first-post`, a file in a subfolder) work.
- An annotated element belongs to the nearest `data-aa-entry` on itself or an
  ancestor. With none, it belongs to the page's own entry, exactly as before.
- Inside a card, `data-aa-field` names the control **in that entry**: `title`,
  not anything qualified by the page.
- Clicking a card's annotation opens that entry in the editor and focuses the
  field. The preview stays on the page you clicked, so you keep editing the
  card where it is shown: a save refreshes the preview on that page, and
  focusing one of the entry's controls outlines that card (not the page's own
  element of the same name, nor another entry's card).
- The editor treats the open entry as a card for as long as the preview shows
  a page that entry does not own. Follow the card's link to the entry's own
  page and it is the page's entry again: saves refresh that page, and its
  controls outline the page's own elements. Go to any other page and saves
  refresh that page; nothing returns the preview to the page the card was on.
- While a card's entry is open, clicking an unqualified annotation goes back to
  the page's own entry and focuses that field. The page is matched without the
  preview's base path or a locale prefix (`/site/`, `/fr/`). On a page with no
  entry of its own (a template page), such a click does nothing, rather than
  focus a field of the card's entry.
- A reference to an entry that does not exist does nothing. The doctor warns
  about it, and counts a card's annotations toward that entry's coverage.

### Links

A click inside a link that navigates (`<a href>`, `<area href>`) belongs to
the link: the preview follows it and no field is focused. So:

- An element that **contains** a link can be annotated (since 1.4.9). A
  Markdown body with links in it, or a hero section with a button in it,
  focuses its field when clicked anywhere except on the link.
- An annotation **on** a link, or on an element **inside** one, can never fire.
  Annotate the text beside the link instead, and edit link labels from the
  sidebar. The doctor's `click-to-edit-links` check reports these.

Before 1.4.9 a click on a link inside an annotated element focused the field
and then navigated away, so sites avoided annotating anything that held a
link. That workaround is no longer needed.

### Components must pass the attribute on

A wrapper component that destructures a fixed list of props and renders its
own root element drops `data-aa-field` (and `data-aa-entry`): it compiles,
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

- **Media under a full-size overlay.** An `<img>` covered by a text layer or a
  gradient never receives the click. Annotate the overlay (or the section),
  and nearer annotations inside it still win.
- **Fields rendered only in `<head>`**: a page `title`, SEO and Open Graph
  fields. Nothing there can be clicked; edit them from the sidebar. The doctor
  leaves them out of coverage.

### Keep template comments out of the markup

Two kinds of comment in a template change the output, so a comment added while
annotating can change how the site looks:

- **Tailwind's class scanner reads comments.** A comment containing a utility
  name ("hidden", "fixed", "block", "grid") makes Tailwind generate that class,
  and the stylesheet changes.
- **Astro ships HTML comments.** A `<!-- -->` comment in a template is sent to
  every visitor, and a `{/* */}` line between elements can add whitespace that
  shifts inline content.

Put explanations in the component's frontmatter (the `---` fence), which never
reaches the output.

### Verifying

1. **Run the doctor** from the site's directory. It builds the site and checks
   block indexes, coverage, names, entry references and links on the built
   HTML:

   ```bash
   bunx astroadmin doctor
   ```

2. **Prove the annotations are visually inert.** Build the site before and
   after annotating, strip the attributes from both, and diff. Any difference
   left is a change a visitor would see (a stylesheet that changed because of
   a comment, extra whitespace):

   ```bash
   git worktree add ../site-before <commit-before-annotating>
   ln -s "$PWD/node_modules" ../site-before/node_modules
   (cd ../site-before && bun --no-install --bun node_modules/.bin/astro build --outDir /tmp/aa-before)
   bun --no-install --bun node_modules/.bin/astro build --outDir /tmp/aa-after
   find /tmp/aa-before /tmp/aa-after -name '*.html' -exec perl -pi -e 's/ data-(aa-field|aa-entry|block-index)="[^"]*"//g' {} +
   diff -r /tmp/aa-before /tmp/aa-after && echo "annotations are inert"
   ```

   Asset file names carry a hash of their content, so a stylesheet that
   changed shows up as a differing file name as well as differing content.
   Remove the worktree afterwards with `git worktree remove ../site-before`.

3. **Click through the preview** in the editor: a click on each kind of
   annotated element should focus its control, and a click on a link should
   navigate without focusing anything.

## Next Steps

- [Content Collections](./content-collections.md) - Schema field types
- [Configuration](./configuration.md) - Customize AstroAdmin
- [Doctor](./doctor.md) - Check a site's click-to-edit coverage
