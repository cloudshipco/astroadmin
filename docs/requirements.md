# Requirements

AstroAdmin requires a specific project structure to work. This page details all requirements.

## System Requirements

| Requirement | Minimum Version |
|-------------|-----------------|
| Bun | 1.0.0 (runs AstroAdmin) |
| Astro | 5.0.0 in the default files mode (legacy collections and `glob()`/`file()` loaders both parse); 6.0.0 if you opt into the shelved DB store |
| Zod | 3.20.0+ (zod 4 supported; Astro 6 ships zod 4) |

## Project Structure

AstroAdmin expects this directory structure:

```
your-astro-site/
├── astro.config.mjs        # or astro.config.ts
├── src/
│   ├── content.config.ts   # Collection schemas (required)
│   └── content/
│       ├── pages/          # Example collection folder
│       │   ├── home.md
│       │   └── about.md
│       └── blog/           # Another collection
│           ├── first-post.md
│           └── second-post.md
├── public/
│   └── images/             # Image upload destination (optional)
└── package.json
```

## Required Files

### 1. Astro Config

You must have either `astro.config.mjs` or `astro.config.ts` in your project root. This tells AstroAdmin it's an Astro project.

### 2. Collection Config

You must have a collection config file at one of these paths:
- `src/content.config.ts` (most common)
- `src/content.config.mts`
- `src/content.config.js`
- `src/content.config.mjs`

This file must export a `collections` object. With Astro's `glob()` loader:

```typescript
// src/content.config.ts
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
  }),
});

export const collections = { pages };
```

Legacy (pre-loader) collections defined with `type: 'content'` are also
understood; they resolve to `src/content/<collection>/`.

## Validation Errors

When you run `npx astroadmin dev`, it validates your project. Here's what each error means:

### "Missing src/content.config.ts (Content Collections not set up)"

**Cause:** No content config file found at the paths above.

**Fix:** create `src/content.config.ts` exporting your collections. See
[Content Collections](./content-collections.md).

### "No astro.config.mjs or astro.config.ts found"

**Cause:** You're not in an Astro project root, or the config file is missing.

**Fix:** Run AstroAdmin from your Astro project directory:
```bash
cd /path/to/your-astro-site
npx astroadmin dev
```

Or specify the project path:
```bash
npx astroadmin dev --project /path/to/your-astro-site
```

## Content File Formats

AstroAdmin supports these file formats:

| Format | Extension | Use Case |
|--------|-----------|----------|
| Markdown | `.md` | Pages, blog posts with body content |
| MDX | `.mdx` | Markdown with components |
| JSON | `.json` | Data-only collections (no body) |

## Optional Features

These are not required but enhance AstroAdmin:

### Image Uploads

For image uploads, ensure `public/images/` exists:
```bash
mkdir -p public/images
```

### Git Integration

AstroAdmin can commit changes to Git. Ensure your project is a Git repository:
```bash
git init
```

### Live Preview

For live preview, run the Astro dev server:
```bash
npm run dev  # Default: http://localhost:4321
```

## Peer Dependencies

If you install AstroAdmin as a project dependency (not just npx), add these peer dependencies:

```json
{
  "dependencies": {
    "astroadmin": "^1.1.0"
  },
  "peerDependencies": {
    "astro": ">=5.0.0",
    "zod": ">=3.20.0"
  }
}
```

## Next Steps

- [Content Collections](./content-collections.md) - How to set up schemas
- [Configuration](./configuration.md) - Customize AstroAdmin
