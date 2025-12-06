# AstroAdmin Documentation

AstroAdmin is a visual admin interface for [Astro Content Collections](https://docs.astro.build/en/guides/content-collections/). It auto-generates forms from your Zod schemas, so you can edit content without touching code.

## Quick Links

- [Getting Started](./getting-started.md) - Install and run AstroAdmin
- [Requirements](./requirements.md) - What your Astro project needs
- [Content Collections](./content-collections.md) - Setting up collections for AstroAdmin
- [Configuration](./configuration.md) - Customizing AstroAdmin behavior

## Features

- **Schema-driven forms** - Auto-generates form fields from your Zod schemas
- **Block editor** - Visual editing for discriminated unions (e.g., page builders)
- **Live preview** - See changes in real-time via iframe
- **Image uploads** - Upload and select images with alt text
- **Git integration** - Commit changes directly from the admin
- **Collection management** - Create and delete collection entries

## How It Works

1. Run `npx astroadmin dev` from your Astro project
2. AstroAdmin reads your `src/content/config.ts` schemas
3. It generates a form UI based on your Zod field types
4. Edits are saved as markdown/JSON files in `src/content/`
5. Your Astro site picks up the changes automatically

## Supported Field Types

| Zod Type | Form Widget |
|----------|-------------|
| `z.string()` | Text input |
| `z.string().describe('textarea')` | Textarea |
| `z.number()` | Number input |
| `z.boolean()` | Checkbox |
| `z.date()` | Date picker |
| `z.enum([...])` | Select dropdown |
| `z.array(...)` | Repeatable fields |
| `z.object(...)` | Nested fieldset |
| `z.discriminatedUnion(...)` | Block editor |
| `image()` | Image picker with upload |
| `reference(...)` | Collection reference selector |

## Getting Help

- [GitHub Issues](https://github.com/YOUR_USERNAME/astroadmin/issues) - Report bugs or request features
- [Astro Discord](https://astro.build/chat) - Community support
