# Getting started

This page takes an Astro site from no content collections to editing in
AstroAdmin. If your site already has `src/content.config.ts`, skip to
[Run AstroAdmin](#run-astroadmin).

## What you need

- [Bun](https://bun.sh). The `astroadmin` command runs under Bun, including
  when you start it with `npx`.
- Astro 6 or later, installed in the site (`npm install` has been run), with
  `astro.config.mjs` or `astro.config.ts` in the project root. AstroAdmin
  runs the site's own copy of Astro and never downloads one.

[Requirements](./requirements.md) has the full list.

## Define your collections

AstroAdmin reads the collections in `src/content.config.ts` and builds a form
from each schema. A minimal config with one Markdown collection and one JSON
list:

```typescript
// src/content.config.ts
import { defineCollection } from 'astro:content';
import { glob, file } from 'astro/loaders';
import { z } from 'astro/zod';

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
  }),
});

const team = defineCollection({
  loader: file('src/content/team.json'),
  schema: z.object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
  }),
});

export const collections = { pages, team };
```

Each `pages` entry is a Markdown file with frontmatter:

```markdown
---
title: Welcome
description: The home page.
---

This is the page body.
```

saved as `src/content/pages/home.md`. A `file()` collection is one JSON file
holding an array, and each item needs an `id`:

```json
[
  { "id": "ada", "name": "Ada", "role": "Engineer" },
  { "id": "grace", "name": "Grace", "role": "Designer" }
]
```

saved as `src/content/team.json`. A page that renders both:

```astro
---
// src/pages/index.astro
import { getCollection, getEntry, render } from 'astro:content';

const page = await getEntry('pages', 'home');
const team = await getCollection('team');
const { Content } = await render(page);
---
<h1>{page.data.title}</h1>
<Content />
<ul>
  {team.map((member) => <li>{member.data.name}, {member.data.role}</li>)}
</ul>
```

Run `npx astro build` once to confirm the site builds before adding the
editor. [Schemas and controls](./content-collections.md) lists which schema
shapes become which form controls.

## Run AstroAdmin

From the project root:

```bash
npx astroadmin dev
```

It checks the project, starts the site's own `astro dev` on the port of the
[preview URL](./configuration.md#preview) (4321 by default; if something is
already listening there it is used as is), then starts the editor on port
4000, or the next free port above it. Both URLs are printed. Stopping
AstroAdmin stops the Astro it started. Useful options:

| Option | Effect |
|---|---|
| `--port <port>` / `-p` | Editor port (default `ASTROADMIN_PORT`, then `PORT`, then 4000). |
| `--host <host>` / `-H` | Address to bind (default `localhost`). |
| `--project <path>` | The Astro project (default: the current directory). |
| `--no-astro` | Do not start Astro; you run `astro dev --port <port>` yourself, on the preview URL's port. |

`npx astroadmin start` is the same command under another name.

## Edit

Open the printed URL and sign in with `admin` / `admin`.
[Configuration](./configuration.md#authentication) explains how to change
that before the editor is reachable by anyone else.

Pick an entry from the picker at the top. The form is on the left and the
site, running under `astro dev`, is on the right. Changes save to the entry's
file automatically shortly after you stop typing, and the preview reloads.
There is no save button.

An entry in a collection named `pages` previews at `/<slug>`, and the `home`
entry at `/`. Other collections need a preview route, either detected from a
dynamic page such as `src/pages/blog/[slug].astro` or set in
`astroadmin.config.js`. In the example above `team` is shown on the home page:

```javascript
// astroadmin.config.js
export default {
  preview: {
    routes: {
      team: '/',
    },
  },
};
```

## Publish

Publish commits the changed content and pushes it. Before the push, the
site's own Astro builds that exact commit, and a commit that fails to build
stays local. See [Git and publishing](./configuration.md#git-and-publishing).

## When something is wrong

```bash
npx astroadmin doctor
```

checks the setup, builds the site, and reports problems such as a missing
integration or click-to-edit names that match no field. See
[doctor](./doctor.md).

"Invalid Astro project" at startup means a required file is missing; the
message names it and [requirements](./requirements.md#startup-errors)
explains each one.

If the preview stays blank, look for `[astro]` lines in AstroAdmin's output.
With `--no-astro`, your own dev server must be running at the preview URL.
