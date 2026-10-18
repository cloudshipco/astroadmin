# AstroAdmin documentation

AstroAdmin is a content editor for Astro sites. It builds its forms from the
Zod schemas in `src/content.config.ts`, saves to the Markdown and JSON files
the site's `glob()` and `file()` loaders read, and publishes by committing
and pushing with git.

- [Getting started](./getting-started.md): from an Astro site to editing.
- [Requirements](./requirements.md): versions, project layout, startup errors.
- [Schemas and controls](./content-collections.md): which schema shapes
  become which form controls, images, dates and references.
- [Optimised images](./optimised-images.md): rendering `/images/...`
  strings as resized AVIF and WebP with `CmsImage`.
- [Blocks](./blocks.md): page sections from a discriminated union, and the
  component preview.
- [Inline editing](./inline-editing.md): moving text out of templates, and
  `data-aa-field` click-to-edit annotations.
- [Configuration](./configuration.md): `astroadmin.config.js`, environment
  variables, authentication, git and publishing.
- [Deploy adapters](./deploy-adapters.md): publishing without a host that
  builds on push.
- [Doctor](./doctor.md): `npx astroadmin doctor` and each of its checks.

Bugs and questions go to
[GitHub issues](https://github.com/cloudshipco/astroadmin/issues).
