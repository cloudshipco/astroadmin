# Content Collections for AstroAdmin

This guide explains how to set up Astro Content Collections so they work with AstroAdmin.

## What Are Content Collections?

[Content Collections](https://docs.astro.build/en/guides/content-collections/) are Astro's way of organizing and validating content. You define a schema using Zod, and Astro enforces it.

AstroAdmin reads these schemas and generates form fields automatically.

## Minimal Setup

### 1. Create the Content Directory

```bash
mkdir -p src/content/pages
```

### 2. Create the Config File

Create `src/content/config.ts`:

```typescript
import { defineCollection, z } from 'astro:content';

const pages = defineCollection({
  type: 'content',  // Markdown files with frontmatter
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    publishDate: z.date().optional(),
  }),
});

export const collections = { pages };
```

### 3. Create a Content File

Create `src/content/pages/home.md`:

```markdown
---
title: Home Page
description: Welcome to our site
---

This is the page content.
```

### 4. Run AstroAdmin

```bash
npx astroadmin dev
```

You should now see "pages" in the dropdown with "home" as an entry.

## Schema Field Types

AstroAdmin maps Zod types to form widgets:

### Text Fields

```typescript
schema: z.object({
  // Single-line text input
  title: z.string(),

  // Textarea (use describe hint)
  body: z.string().describe('textarea'),

  // With placeholder
  subtitle: z.string().describe('Enter a subtitle'),
})
```

### Numbers and Booleans

```typescript
schema: z.object({
  // Number input
  order: z.number(),

  // Checkbox
  featured: z.boolean(),
  draft: z.boolean().default(false),
})
```

### Dates

```typescript
schema: z.object({
  // Date picker
  publishDate: z.date(),

  // Coerced date (accepts strings)
  updatedAt: z.coerce.date(),
})
```

### Select Dropdowns

```typescript
schema: z.object({
  // Enum creates a dropdown
  status: z.enum(['draft', 'published', 'archived']),

  // With default
  category: z.enum(['news', 'blog', 'tutorial']).default('blog'),
})
```

### Images

```typescript
import { defineCollection, z, image } from 'astro:content';

const pages = defineCollection({
  schema: z.object({
    // Image picker with upload
    heroImage: image().optional(),

    // Alt text is stored as heroImageAlt automatically
  }),
});
```

### Arrays (Repeatable Fields)

```typescript
schema: z.object({
  // Array of strings
  tags: z.array(z.string()),

  // Array of objects
  features: z.array(z.object({
    title: z.string(),
    description: z.string(),
  })),
})
```

### Nested Objects

```typescript
schema: z.object({
  seo: z.object({
    metaTitle: z.string(),
    metaDescription: z.string(),
    ogImage: image().optional(),
  }),
})
```

### References

```typescript
import { defineCollection, z, reference } from 'astro:content';

const posts = defineCollection({
  schema: z.object({
    // Reference to another collection
    author: reference('authors'),

    // Array of references
    relatedPosts: z.array(reference('posts')).optional(),
  }),
});

const authors = defineCollection({
  type: 'data',  // JSON collection
  schema: z.object({
    name: z.string(),
    email: z.string().email(),
  }),
});
```

## Block Editor (Discriminated Unions)

For page builders with multiple block types, use discriminated unions:

```typescript
const blockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hero'),
    title: z.string(),
    subtitle: z.string().optional(),
    backgroundImage: image().optional(),
  }),
  z.object({
    type: z.literal('text'),
    content: z.string().describe('textarea'),
  }),
  z.object({
    type: z.literal('features'),
    heading: z.string(),
    items: z.array(z.object({
      title: z.string(),
      description: z.string(),
      icon: z.string().optional(),
    })),
  }),
  z.object({
    type: z.literal('cta'),
    title: z.string(),
    buttonText: z.string(),
    buttonUrl: z.string(),
  }),
]);

const pages = defineCollection({
  schema: z.object({
    title: z.string(),
    blocks: z.array(blockSchema),
  }),
});
```

AstroAdmin renders this as a block editor where you can:
- Add new blocks
- Remove blocks
- Reorder blocks by drag-and-drop
- Edit each block's fields

## Collection Types

### Content Collections

For markdown/MDX files with frontmatter and body:

```typescript
const blog = defineCollection({
  type: 'content',  // or omit (default)
  schema: z.object({ ... }),
});
```

Files: `src/content/blog/my-post.md`

### Data Collections

For JSON files without body content:

```typescript
const settings = defineCollection({
  type: 'data',
  schema: z.object({ ... }),
});
```

Files: `src/content/settings/site.json`

## Tips

### Optional vs Required

```typescript
// Required - user must fill this in
title: z.string(),

// Optional - can be left empty
subtitle: z.string().optional(),

// Default value - pre-filled but editable
status: z.string().default('draft'),
```

### Field Descriptions

Use `.describe()` to add hints or change the widget:

```typescript
// Shows as hint text under the field
email: z.string().describe('Enter your work email'),

// Changes widget to textarea
bio: z.string().describe('textarea'),
```

### Nullable Fields

```typescript
// Allows null value
deletedAt: z.date().nullable(),
```

## Next Steps

- [Configuration](./configuration.md) - Customize AstroAdmin
- [Astro Content Collections Docs](https://docs.astro.build/en/guides/content-collections/)
