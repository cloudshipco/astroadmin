# Best Practices for Editable Sites

This guide covers how to structure your Astro site for the best editing experience with AstroAdmin.

## Core Principle: Separate Content from Code

The key to a good editing experience is separating **what editors change** from **how it looks**:

| Content (Editable) | Code (Developer) |
|-------------------|------------------|
| Text, images, links | HTML structure |
| Page sections | CSS styling |
| Feature lists | Component logic |
| Testimonials | Animations |

Editors should never need to understand HTML, CSS, or Astro syntax.

## Choosing Your Structure

### Simple Pages

For pages with fixed layouts (about, contact, privacy policy):

```typescript
const pages = defineCollection({
  type: 'data',
  schema: z.object({
    title: z.string(),
    metaDescription: z.string(),
    heroTitle: z.string(),
    heroSubtitle: z.string().optional(),
    content: z.string(), // Main body text
  }),
});
```

**Best for:** Marketing pages, legal pages, simple landing pages.

### Block-Based Pages

For pages where editors control the layout:

```typescript
const pages = defineCollection({
  type: 'data',
  schema: z.object({
    title: z.string(),
    metaDescription: z.string(),
    blocks: z.array(blockSchema),
  }),
});
```

**Best for:** Home pages, landing pages, flexible marketing sites.

See [Block-Based Editing](./blocks.md) for full setup.

### Separate Collections

For content that's reused across pages or has many entries:

```typescript
// Standalone collections
const testimonials = defineCollection({
  type: 'data',
  schema: z.array(z.object({
    quote: z.string(),
    author: z.string(),
  })),
});

const team = defineCollection({
  type: 'data',
  schema: z.array(z.object({
    name: z.string(),
    role: z.string(),
    bio: z.string(),
    photo: z.string(),
  })),
});
```

**Best for:** Testimonials, team members, FAQs, pricing tiers, blog posts.

## Field Design

### Use Clear Field Names

Field names become labels in the editor:

```typescript
// Good - clear labels
schema: z.object({
  heroTitle: z.string(),        // "Hero Title"
  heroSubtitle: z.string(),     // "Hero Subtitle"
  ctaButtonText: z.string(),    // "Cta Button Text"
})

// Avoid - confusing labels
schema: z.object({
  h1: z.string(),               // "H1" - unclear
  txt: z.string(),              // "Txt" - cryptic
  btn: z.string(),              // "Btn" - abbreviation
})
```

### Group Related Fields

Use nested objects to group related fields:

```typescript
schema: z.object({
  // SEO fields grouped together
  seo: z.object({
    title: z.string(),
    description: z.string(),
    ogImage: z.string().optional(),
  }),

  // Hero section grouped
  hero: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    backgroundImage: z.string(),
  }),
})
```

### Provide Helpful Defaults

Pre-populate fields where sensible:

```typescript
schema: z.object({
  buttonText: z.string().default('Learn More'),
  buttonUrl: z.string().default('/contact'),
  showTestimonials: z.boolean().default(true),
})
```

### Make Optional Fields Optional

Don't require fields that might be empty:

```typescript
schema: z.object({
  title: z.string(),                    // Required - always needed
  subtitle: z.string().optional(),      // Optional - not every page has one
  buttonText: z.string().optional(),    // Optional - CTA might not be needed
})
```

### Use Enums for Choices

When a field has limited options, use enums:

```typescript
schema: z.object({
  // Dropdown with options
  layout: z.enum(['default', 'wide', 'narrow']),
  theme: z.enum(['light', 'dark']),
  alignment: z.enum(['left', 'center', 'right']).default('center'),
})
```

## What Should Be Editable?

### Make Editable

- Headlines and body text
- Images and their alt text
- Button text and URLs
- Feature lists and descriptions
- Testimonials and quotes
- Contact information
- Social media links
- SEO metadata

### Keep in Code

- Layout structure and grid
- Colors and typography (use themes)
- Animations and transitions
- Navigation structure (usually)
- Footer links (unless frequently changed)
- Component styling

### Gray Area (Depends on Client)

- Number of columns in a grid
- Section visibility toggles
- Color variants (light/dark sections)
- Image positions (left/right)

## Site Architecture Examples

### Marketing Site

```
src/content/
├── config.ts
├── pages/
│   ├── home.json      # Block-based home page
│   ├── about.json     # Simple schema
│   └── contact.json   # Simple schema
├── blog/
│   ├── post-1.md      # Markdown with frontmatter
│   └── post-2.md
├── team/
│   └── members.json   # Array of team members
└── settings/
    └── site.json      # Global settings (name, logo, social)
```

### E-commerce Site

```
src/content/
├── config.ts
├── pages/
│   └── home.json      # Block-based landing
├── products/
│   ├── product-1.json
│   └── product-2.json
├── categories/
│   └── all.json       # Array of categories
└── settings/
    ├── site.json      # Branding
    └── shipping.json  # Shipping info
```

### Portfolio Site

```
src/content/
├── config.ts
├── pages/
│   ├── home.json
│   └── about.json
├── projects/
│   ├── project-1.md   # Case studies with body text
│   └── project-2.md
├── testimonials/
│   └── quotes.json    # Client testimonials
└── settings/
    └── site.json
```

## Common Patterns

### Global Settings Collection

Create a settings collection for site-wide content:

```typescript
const settings = defineCollection({
  type: 'data',
  schema: z.object({
    siteName: z.string(),
    tagline: z.string().optional(),
    logo: z.string(),
    email: z.string().email(),
    phone: z.string().optional(),
    address: z.string().optional(),
    social: z.array(z.object({
      platform: z.enum(['twitter', 'instagram', 'linkedin', 'facebook']),
      url: z.string().url(),
    })),
  }),
});
```

### Reusable Content Arrays

For content used in multiple places:

```typescript
// testimonials/quotes.json - used on home and about pages
const testimonials = defineCollection({
  type: 'data',
  schema: z.array(z.object({
    quote: z.string(),
    author: z.string(),
    company: z.string().optional(),
    featured: z.boolean().default(false), // Show on home page
  })),
});
```

### Blog with Categories

```typescript
const blog = defineCollection({
  type: 'content', // Markdown files
  schema: z.object({
    title: z.string(),
    excerpt: z.string(),
    publishDate: z.date(),
    category: z.enum(['news', 'tutorials', 'updates']),
    featured: z.boolean().default(false),
    coverImage: z.string().optional(),
  }),
});
```

## Checklist

Before launching, verify:

- [ ] All user-facing text is in content collections
- [ ] Images have alt text fields
- [ ] SEO fields (title, description) exist for all pages
- [ ] Field names are clear and descriptive
- [ ] Optional fields are marked optional
- [ ] Sensible defaults are provided
- [ ] Preview works correctly in AstroAdmin
- [ ] Editors can't break the layout

## Next Steps

- [Content Collections](./content-collections.md) - Schema field reference
- [Block-Based Editing](./blocks.md) - Flexible page layouts
- [Inline Editing](./inline-editing.md) - Converting existing pages
- [Configuration](./configuration.md) - Customize AstroAdmin
