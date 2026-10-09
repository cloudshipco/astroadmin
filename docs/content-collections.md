# Schemas and editor controls

AstroAdmin builds its forms from the collections exported by
`src/content.config.ts`. This page covers how it reads that file, where it
writes entries, and which control each kind of field gets. It assumes the
current content API: loaders from `astro/loaders` and `z` from `astro/zod`.
The pre-Astro 6 form (`src/content/config.ts`, `type: 'content'`) is not
supported.

## How collections are read

AstroAdmin bundles `src/content.config.ts` and evaluates it, so the schema it
sees is the one Astro uses. A schema written as a function
(`schema: ({ image }) => z.object(...)`) is called too.

| Loader | Where entries live | Written as |
|---|---|---|
| `glob({ pattern, base })` | One file per entry under `base` | Frontmatter plus body for `.md`/`.mdx`, plain JSON for `.json` |
| `file('path/to/x.json')` | One JSON array, one object per entry | The array, rewritten in place; each object needs an `id` |

An existing entry is always saved back to its own file. Writes are atomic
(a temporary file, then a rename), so the dev server never reads a half
written file. Markdown and MDX entries also have an editor for the body.

## Which control a field gets

The control depends on the field's type and, for strings, on its name.
Every row below was rendered from this schema:

```typescript
// src/content.config.ts
import { defineCollection } from 'astro:content';
import { glob, file } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    summary: z.string().optional(),
    order: z.number().default(0),
    featured: z.boolean().default(false),
    category: z.enum(['news', 'guides']),
    publishDate: z.coerce.date(),
    heroImage: z.string().optional(),
    heroImageAlt: z.string().optional(),
    tags: z.array(z.string()).default([]),
    links: z.array(z.object({
      label: z.string(),
      url: z.string(),
    })).default([]),
    seo: z.object({
      title: z.string().optional(),
      description: z.string().optional(),
    }).default({}),
    testimonialIds: z.array(z.string()).default([]),
  }),
});

const testimonials = defineCollection({
  loader: file('src/content/testimonials.json'),
  schema: z.object({
    id: z.string(),
    quote: z.string(),
    author: z.string(),
  }),
});

export const collections = { posts, testimonials };
```

| Field | Control |
|---|---|
| `title: z.string()` | One-line text input (see [text fields](#text-fields)) |
| `summary: z.string()` | Multi-line text area |
| `order: z.number()` | Number input; `.min()` and `.max()` carry over |
| `featured: z.boolean()` | Checkbox |
| `category: z.enum([...])` | Drop-down list |
| `publishDate: z.coerce.date()` | Date picker (see [dates](#dates)) |
| `heroImage: z.string()` | Image picker with upload (see [images](#images)) |
| `tags: z.array(z.string())` | A list of text inputs that can be added to, removed and reordered |
| `links: z.array(z.object({...}))` | A list of cards; each opens a form for the item |
| `seo: z.object({...})` | The nested fields, grouped under a heading |
| `testimonialIds: z.array(z.string())` | A picker of `testimonials` entries (see [references](#references)) |
| `z.literal(...)` | Nothing visible; the value is kept on save |
| `z.discriminatedUnion(...)` in an array | A block editor (see [blocks](./blocks.md)) |

Labels come from field names: `heroImage` is shown as "Hero Image". Choose
names an editor will understand.

### Text fields

A string field is a one-line input when its name is, or ends with, `title`,
`heading`, `name`, `label`, `text`, `link`, `href`, `url`, `value`, `number`
or `alt`, or when it has a `.max()` under 100. Every other string
is a text area. A name containing `description`, `content` or `subheading`
is always a text area, and so is any field described as one:

```typescript
title: z.string().describe('textarea'),
```

A field whose name contains `color` or `colour` gets a colour picker.

### Dates

A field gets a date picker when its name ends in `date` (`date`, `pubDate`,
`publishDate`), `createdAt`, `updatedAt`, `publishedAt` or `modifiedAt`. Other date fields are edited as text.

The picker saves the date as text (`'2026-01-15'`). Declare date fields with
`z.coerce.date()`, which accepts that; `z.date()` rejects a quoted date in
frontmatter, and a date in a JSON file is always a string.

### Images

A string field gets the image picker when its name is, or ends with, `image`,
`photo`, `logo`, `icon`, `avatar`, `thumbnail`, `banner`, `background` or
`src`. The picker can choose from the image library or upload a new file.
Uploads go to `public/images/`, and the field is saved as
`/images/<file>`, which the site serves from `public/`.

The picker also offers an alt text box, saved next to the image as
`<field>Alt` (`heroImageAlt` for `heroImage`). Declare that field in the
schema, as above, or Astro leaves it out of `entry.data`. When it is declared
the picker's own alt box is hidden and the declared field is shown instead.

Use `z.string()` for picker fields, not Astro's `image()`. `image()` expects a
path relative to the entry file (`../../assets/hero.png`) and fails the build
on a `/images/...` path, so the first image chosen in the picker would stop
the site building. AstroAdmin's publish check then refuses to push it.

A list of objects that each have a `src` (`z.array(z.object({ src, alt }))`)
is edited as a gallery.

### References

An array of strings named `<singular>Ids` is a list of entries from the
collection `<singular>s`: `testimonialIds` picks from `testimonials`,
`pageIds` from `pages`. The collection name must be lower case and end in
`s`. The entries' ids are stored, and the site looks them up:

```astro
---
import { getEntries, getEntry } from 'astro:content';

const post = await getEntry('posts', 'first-post');
const quotes = await getEntries(
  post.data.testimonialIds.map((id) => ({ collection: 'testimonials', id })),
);
---
{quotes.map((quote) => <blockquote>{quote.data.quote}</blockquote>)}
```

Astro's `reference()` helper is not supported: AstroAdmin cannot read a
content config that uses it, and then no collection can be edited.

## Validation

A save always writes the file, even when the entry does not match its
schema; the editor marks the fields that are wrong. Publishing is stricter:
the site's own Astro build must accept the content before anything is pushed.
See [Git and publishing](./configuration.md#git-and-publishing).
