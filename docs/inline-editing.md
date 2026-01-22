# Converting Template Pages to Inline Editing

This guide explains how to convert your Astro pages from hardcoded template files to content collections that can be edited through AstroAdmin's sidebar.

## Understanding the Difference

### Template Pages (Static)

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

### Content Collections (Editable)

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

## Step-by-Step Conversion

### Step 1: Identify Your Content

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

### Step 2: Define the Schema

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

### Step 3: Create the Content File

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

### Step 4: Update Your Template

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

### Step 5: Verify in AstroAdmin

1. Run `npx astroadmin dev`
2. Select "pages" > "about" from the dropdown
3. Edit your content in the sidebar
4. See changes live in the preview

## Common Patterns

### Simple Text Page

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

### Page with Hero and Features

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

### Page with Blocks (Flexible Layouts)

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

## Tips

### Keep Your Layouts

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

### Use Descriptive Field Names

AstroAdmin generates labels from field names. Use clear names:

```typescript
// Clear field names
schema: z.object({
  heroTitle: z.string(),        // Shows as "Hero Title"
  ctaButtonText: z.string(),    // Shows as "Cta Button Text"
})
```

### Start Small

Convert one page at a time. Start with simple pages before tackling complex ones with blocks.

## Next Steps

- [Content Collections](./content-collections.md) - Schema field types
- [Configuration](./configuration.md) - Customize AstroAdmin
