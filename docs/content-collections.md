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

An existing entry is always saved back to its own file, and a new one gets
the extension its loader pattern matches (`.md` first, then `.mdx`, then
`.json`). Writes are atomic (a temporary file, then a rename), so the dev
server never reads a half written file. A save changes only what the editor
changed: keys keep their order, untouched values and `file()` entries keep
their formatting, YAML comments stay, and an unquoted date stays unquoted.
Every Markdown and MDX entry has an editor for the body, including one whose
schema has blocks.

A change to `src/content.config.ts` is picked up while AstroAdmin runs;
reload the editor tab to see it. On a VM or network mount that does not
deliver file change events, restart AstroAdmin instead.

## Which control a field gets

The control depends on the field's type and, for strings, on its name.
Every row below was rendered from this schema:

```typescript
// src/content.config.ts
import { defineCollection, reference } from 'astro:content';
import { glob, file } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: ({ image }) => z.object({
    title: z.string(),
    summary: z.string().optional(),
    order: z.number().int().min(0).default(0),
    featured: z.boolean().default(false),
    category: z.enum(['news', 'guides']),
    publishDate: z.date(),
    cover: image(),
    coverAlt: z.string().optional(),
    heroImage: z.string().optional(),
    tags: z.array(z.string()).default([]),
    links: z.array(z.object({
      label: z.string(),
      url: z.string(),
    })).default([]),
    seo: z.object({
      title: z.string().optional(),
      description: z.string().optional(),
    }).default({}),
    featuredQuote: reference('testimonials').optional(),
    related: z.array(reference('posts')).default([]),
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
| `order: z.number().int()` | Whole-number input; `.min()` and `.max()` apply |
| `featured: z.boolean()` | Checkbox |
| `category: z.enum([...])` | Drop-down list |
| `publishDate: z.date()` | Date picker (see [dates](#dates)) |
| `cover: image()` | Image picker that saves a path Astro can import (see [images](#images)) |
| `heroImage: z.string()` | Image picker that saves a `/images/...` path |
| `tags: z.array(z.string())` | A list of text inputs that can be added to, removed and reordered |
| `links: z.array(z.object({...}))` | A list of cards; each opens a form for the item |
| `seo: z.object({...})` | The nested fields, grouped under a heading |
| `featuredQuote: reference('testimonials')` | A picker of one `testimonials` entry (see [references](#references)) |
| `related: z.array(reference('posts'))` | A picker of several `posts` entries |
| `testimonialIds: z.array(z.string())` | A picker of several `testimonials` entries, found by name |
| `z.literal(...)` | Nothing visible; the value is kept on save |
| `z.discriminatedUnion(...)` in an array | A block editor (see [blocks](./blocks.md)) |

Labels come from field names: `heroImage` is shown as "Hero Image". Choose
names an editor will understand.

### Optional text fields

Let an optional text field accept an empty string: write
`z.string().trim().optional()` (or just `z.string().optional()`), not
`z.string().min(1).optional()`, and treat `""` and a missing value the same
in your templates (`{entry.data.caption && ...}`).

An editor who empties a text field leaves `""` in the form. For a field of
the entry itself, an optional `""` is saved as not set. For a field inside a
block, the `""` is saved as it is: optional does not prove that `""` and a
missing value mean the same thing to your site (a `.default()` fills a
missing value in, and a template or a refinement can tell the two apart). So
a block field written as `.min(1).optional()` fails your schema once an
editor empties it. The save still goes through, but the editor is told the
site cannot be published, and the only fix open to them is to type
something.

### Text fields

A string field is a one-line input when any of these holds:

- its name is, or ends with, `title`, `heading`, `name`, `label`, `text`,
  `link`, `href`, `url`, `website`, `email`, `phone`, `slug`, `value`,
  `number`, `alt`, `author`, `role`, `position`, `company`, `organisation`
  (or `organization`), `location`, `city`, `country`, `tag` or `category`;
- it is an identifier: `id`, or a name ending in `Id` or `_id`;
- it is an email address or URL (`z.email()`, `z.url()`), which also gets
  the browser's checking for that format;
- it has a `.max()` under 100.

Every other string is a text area. A name containing `description`,
`content` or `subheading` is always a text area, and so is any field
described as one:

```typescript
title: z.string().describe('textarea'),
```

A field whose name contains `color` or `colour` gets a colour picker.

### Dates

`z.date()` and `z.coerce.date()` fields get a date picker, and so does a
string field whose name ends in `date` (`pubDate`), `createdAt`,
`updatedAt`, `publishedAt` or `modifiedAt`.

In frontmatter, a date picked for a `z.date()` or `z.coerce.date()` field is
saved as an unquoted YAML date (`publishDate: 2026-01-15`), which Astro reads
as a `Date`. A value that has a time of day (`2026-01-15T09:30:00Z`) keeps it
while the day is left alone; the picker edits only the day. A quoted date
stays a quoted string. Use `z.coerce.date()`, which accepts a quoted date,
in a JSON entry (JSON has no date type) and for a date inside a nested
object, list item or block, where a newly picked date is saved quoted.

### Images

An `image()` field gets the image picker whatever its name. The picker can
choose from the image library or upload a new file. The file is stored in
`src/content/assets/images/` and the field is saved as a path relative to
the entry's file, which is what `image()` needs: `../assets/images/hero.jpg`
for `src/content/posts/first-post.md`, `../../assets/images/hero.jpg` for
`src/content/posts/2024/first-post.md`. Choosing an image from
`public/images/` copies it into that folder first. If your config sets
`git.paths`, include `src/content/` (or that folder) so Publish commits the
images; the default does.

A plain `z.string()` field gets the image picker when its name is, or ends
with, `image`, `photo`, `logo`, `icon`, `avatar`, `thumbnail`, `banner`,
`background` or `src`. Its uploads go to `public/images/`, and the field is
saved as `/images/<file>`, which the site serves from `public/`.

The picker also offers an alt text box, saved next to the image as
`<field>Alt` (`coverAlt` for `cover`). Declare that field in the schema,
as above, or Astro leaves it out of `entry.data`. When it is declared
the picker's own alt box is hidden and the declared field is shown instead.

A list of objects that each have a `src` (`z.array(z.object({ src, alt }))`)
is edited as a gallery.

### References

`reference('testimonials')` is a picker of one entry of that collection and
saves the entry's id; `z.array(reference('posts'))` is a picker of several.
Astro turns each id into `{ collection, id }`, which `getEntry` and
`getEntries` accept.

A list of strings named `<name>Ids` is also a picker, when a collection named
`<name>s`, `<name>`, `<name>es` or, for a name ending in `y`, its `ies`
plural (`categoryIds` for `categories`) is declared. Otherwise it is a plain
list of text inputs. Here the site looks the ids up itself:

```astro
---
import { getEntries, getEntry } from 'astro:content';

const post = await getEntry('posts', 'first-post');
const featured = post.data.featuredQuote && await getEntry(post.data.featuredQuote);
const quotes = await getEntries(
  post.data.testimonialIds.map((id) => ({ collection: 'testimonials', id })),
);
---
{featured && <blockquote>{featured.data.quote}</blockquote>}
{quotes.map((quote) => <blockquote>{quote.data.quote}</blockquote>)}
```

## Validation

A save always writes the file, even when the entry does not match its
schema; the editor marks the fields that are wrong, including a required
`image()` left empty. Publishing is stricter:
the site's own Astro build must accept the content before anything is pushed.
See [Git and publishing](./configuration.md#git-and-publishing).
