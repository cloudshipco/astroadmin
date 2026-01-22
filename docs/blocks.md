# Block-Based Page Editing

This guide explains how to set up a blocks-based content structure that gives editors flexibility to build pages with reusable components.

## What Are Blocks?

Blocks are reusable content sections that editors can add, remove, and reorder. Instead of a fixed page structure, blocks let editors compose pages from a library of components:

- Hero sections
- Text content
- Feature grids
- Testimonials
- Image galleries
- Call-to-action sections
- And more...

AstroAdmin renders blocks as a drag-and-drop editor in the sidebar.

## Setting Up Blocks

### Step 1: Define Block Types

Create a discriminated union schema where each block has a `type` field:

```typescript
// src/content/config.ts
import { defineCollection, z } from 'astro:content';

// Define each block type
const blockSchema = z.discriminatedUnion('type', [
  // Hero block
  z.object({
    type: z.literal('hero'),
    title: z.string(),
    subtitle: z.string().optional(),
    backgroundImage: z.string().optional(),
    buttonText: z.string().optional(),
    buttonUrl: z.string().optional(),
  }),

  // Rich text block
  z.object({
    type: z.literal('text'),
    content: z.string(),
  }),

  // Features grid
  z.object({
    type: z.literal('features'),
    heading: z.string().optional(),
    items: z.array(z.object({
      title: z.string(),
      description: z.string(),
      icon: z.string().optional(),
    })),
  }),

  // Testimonials
  z.object({
    type: z.literal('testimonials'),
    heading: z.string().optional(),
    items: z.array(z.object({
      quote: z.string(),
      author: z.string(),
      role: z.string().optional(),
    })),
  }),

  // Call to action
  z.object({
    type: z.literal('cta'),
    title: z.string(),
    description: z.string().optional(),
    buttonText: z.string(),
    buttonUrl: z.string(),
  }),
]);

// Page collection with blocks
const pages = defineCollection({
  type: 'data',
  schema: z.object({
    title: z.string(),
    metaDescription: z.string().optional(),
    blocks: z.array(blockSchema),
  }),
});

export const collections = { pages };
```

### Step 2: Create Content Files

Create JSON files with your block content:

```json
// src/content/pages/home.json
{
  "title": "Welcome",
  "metaDescription": "Our amazing website",
  "blocks": [
    {
      "type": "hero",
      "title": "Build Something Amazing",
      "subtitle": "Start your journey with us",
      "backgroundImage": "/images/hero.jpg",
      "buttonText": "Get Started",
      "buttonUrl": "/contact"
    },
    {
      "type": "features",
      "heading": "Why Choose Us",
      "items": [
        {
          "title": "Fast",
          "description": "Lightning quick performance"
        },
        {
          "title": "Secure",
          "description": "Enterprise-grade security"
        },
        {
          "title": "Scalable",
          "description": "Grows with your needs"
        }
      ]
    },
    {
      "type": "testimonials",
      "heading": "What People Say",
      "items": [
        {
          "quote": "This product changed everything for us.",
          "author": "Jane Doe",
          "role": "CEO, Acme Inc"
        }
      ]
    },
    {
      "type": "cta",
      "title": "Ready to Start?",
      "description": "Join thousands of happy customers",
      "buttonText": "Sign Up Free",
      "buttonUrl": "/signup"
    }
  ]
}
```

### Step 3: Create Block Components

Create an Astro component for each block type:

```astro
---
// src/components/blocks/Hero.astro
const { title, subtitle, backgroundImage, buttonText, buttonUrl } = Astro.props;
---

<section class="hero" style={backgroundImage ? `background-image: url(${backgroundImage})` : ''}>
  <h1>{title}</h1>
  {subtitle && <p class="subtitle">{subtitle}</p>}
  {buttonText && buttonUrl && (
    <a href={buttonUrl} class="btn">{buttonText}</a>
  )}
</section>
```

```astro
---
// src/components/blocks/Features.astro
const { heading, items } = Astro.props;
---

<section class="features">
  {heading && <h2>{heading}</h2>}
  <div class="features-grid">
    {items.map(item => (
      <div class="feature">
        {item.icon && <span class="icon">{item.icon}</span>}
        <h3>{item.title}</h3>
        <p>{item.description}</p>
      </div>
    ))}
  </div>
</section>
```

```astro
---
// src/components/blocks/Testimonials.astro
const { heading, items } = Astro.props;
---

<section class="testimonials">
  {heading && <h2>{heading}</h2>}
  <div class="testimonials-list">
    {items.map(item => (
      <blockquote>
        <p>"{item.quote}"</p>
        <cite>
          {item.author}
          {item.role && <span class="role">{item.role}</span>}
        </cite>
      </blockquote>
    ))}
  </div>
</section>
```

### Step 4: Create a Block Renderer

Create a component that renders the right block based on type:

```astro
---
// src/components/BlockRenderer.astro
import Hero from './blocks/Hero.astro';
import Text from './blocks/Text.astro';
import Features from './blocks/Features.astro';
import Testimonials from './blocks/Testimonials.astro';
import Cta from './blocks/Cta.astro';

const { block } = Astro.props;

const components = {
  hero: Hero,
  text: Text,
  features: Features,
  testimonials: Testimonials,
  cta: Cta,
};

const Component = components[block.type];
---

{Component ? <Component {...block} /> : <p>Unknown block type: {block.type}</p>}
```

### Step 5: Use in Your Page

```astro
---
// src/pages/index.astro
import { getEntry } from 'astro:content';
import Layout from '../layouts/Layout.astro';
import BlockRenderer from '../components/BlockRenderer.astro';

const page = await getEntry('pages', 'home');
const { title, metaDescription, blocks } = page.data;
---

<Layout title={title} description={metaDescription}>
  {blocks.map(block => (
    <BlockRenderer block={block} />
  ))}
</Layout>
```

## Using AstroAdmin

Once set up, AstroAdmin will:

1. Show a **block editor** in the sidebar
2. Let editors **add new blocks** from a dropdown
3. Allow **drag-and-drop reordering**
4. Expand/collapse blocks for focused editing
5. Show a **live preview** as changes are made

## Tips

### Keep Block Types Focused

Each block should do one thing well:

```typescript
// Good: focused blocks
z.object({ type: z.literal('hero'), ... }),
z.object({ type: z.literal('testimonials'), ... }),

// Avoid: kitchen-sink blocks
z.object({
  type: z.literal('section'),
  variant: z.enum(['hero', 'testimonials', 'features', ...]),
  // lots of optional fields...
})
```

### Use Descriptive Type Names

Block types become labels in AstroAdmin:

```typescript
// Shows as "Hero Section" in the editor
z.object({ type: z.literal('hero'), ... }),

// Shows as "Section Header" in the editor
z.object({ type: z.literal('sectionHeader'), ... }),
```

### Reference Other Collections

Blocks can reference items from other collections:

```typescript
z.object({
  type: z.literal('featuredPosts'),
  heading: z.string(),
  postIds: z.array(z.string()), // IDs of posts to feature
}),
```

Then in your component, fetch the referenced content:

```astro
---
import { getEntry } from 'astro:content';

const { postIds } = Astro.props;
const posts = await Promise.all(
  postIds.map(id => getEntry('posts', id))
);
---
```

### Provide Sensible Defaults

Use `.default()` to pre-populate new blocks:

```typescript
z.object({
  type: z.literal('cta'),
  title: z.string().default('Ready to get started?'),
  buttonText: z.string().default('Contact Us'),
  buttonUrl: z.string().default('/contact'),
}),
```

## Example: Full Page Schema

Here's a complete example with multiple block types:

```typescript
import { defineCollection, z } from 'astro:content';

const blockSchema = z.discriminatedUnion('type', [
  // Hero with background image
  z.object({
    type: z.literal('hero'),
    title: z.string(),
    subtitle: z.string().optional(),
    backgroundImage: z.string().optional(),
    buttonText: z.string().optional(),
    buttonUrl: z.string().optional(),
    overlay: z.boolean().default(true),
  }),

  // Section header (title + optional subtitle)
  z.object({
    type: z.literal('sectionHeader'),
    title: z.string(),
    subtitle: z.string().optional(),
    centered: z.boolean().default(true),
  }),

  // Rich text / markdown content
  z.object({
    type: z.literal('richText'),
    content: z.string(),
  }),

  // Two-column text + image
  z.object({
    type: z.literal('textImage'),
    title: z.string(),
    content: z.string(),
    image: z.string(),
    imageAlt: z.string().optional(),
    imagePosition: z.enum(['left', 'right']).default('right'),
  }),

  // Feature grid (3-4 items)
  z.object({
    type: z.literal('features'),
    heading: z.string().optional(),
    columns: z.number().min(2).max(4).default(3),
    items: z.array(z.object({
      title: z.string(),
      description: z.string(),
      icon: z.string().optional(),
      link: z.string().optional(),
    })),
  }),

  // Testimonial carousel/grid
  z.object({
    type: z.literal('testimonials'),
    heading: z.string().optional(),
    layout: z.enum(['carousel', 'grid']).default('carousel'),
    items: z.array(z.object({
      quote: z.string(),
      author: z.string(),
      role: z.string().optional(),
      avatar: z.string().optional(),
    })),
  }),

  // Stats/numbers section
  z.object({
    type: z.literal('stats'),
    heading: z.string().optional(),
    items: z.array(z.object({
      value: z.string(),
      label: z.string(),
    })),
  }),

  // Call to action banner
  z.object({
    type: z.literal('cta'),
    title: z.string(),
    description: z.string().optional(),
    buttonText: z.string(),
    buttonUrl: z.string(),
    variant: z.enum(['default', 'highlight']).default('default'),
  }),

  // Image gallery
  z.object({
    type: z.literal('gallery'),
    heading: z.string().optional(),
    columns: z.number().min(2).max(4).default(3),
    images: z.array(z.object({
      src: z.string(),
      alt: z.string(),
      caption: z.string().optional(),
    })),
  }),
]);

const pages = defineCollection({
  type: 'data',
  schema: z.object({
    title: z.string(),
    metaDescription: z.string().optional(),
    ogImage: z.string().optional(),
    blocks: z.array(blockSchema),
  }),
});

export const collections = { pages };
```

## Next Steps

- [Content Collections](./content-collections.md) - Schema field types
- [Inline Editing](./inline-editing.md) - Converting from templates
- [Configuration](./configuration.md) - Customize AstroAdmin
