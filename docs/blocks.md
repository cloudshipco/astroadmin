# Blocks

A block list lets editors build a page from sections: add a hero, then a
feature grid, then testimonials, and reorder them. In the schema it is an
array of a discriminated union keyed on `type`. AstroAdmin shows it as a list
of blocks with an "Add block" menu, one form per block, and drag to reorder.

## Schema

```typescript
// src/content.config.ts
import { defineCollection } from 'astro:content';
import { glob, file } from 'astro/loaders';
import { z } from 'astro/zod';

const blocks = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hero'),
    heading: z.string(),
    subheading: z.string().optional(),
    image: z.string().optional(),
    imageAlt: z.string().optional(),
  }),
  z.object({
    type: z.literal('features'),
    heading: z.string().optional(),
    items: z.array(z.object({
      title: z.string(),
      description: z.string(),
    })).default([]),
  }).meta({ title: 'Feature grid' }),
  z.object({
    type: z.literal('testimonials'),
    heading: z.string().optional(),
    testimonialIds: z.array(z.string()).default([]),
  }),
]);

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({
    title: z.string(),
    blocks: z.array(blocks).default([]),
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

export const collections = { pages, testimonials };
```

The fields inside each block get the same controls as anywhere else (see
[schemas and controls](./content-collections.md)). The `type` literal is not
shown; it is set when the block is added. The block's label in the editor
comes from its type, so `sectionHeader` is shown as "Section header", unless
the block's object sets a title with `.meta({ title: '...' })`, as
`features` does above.

An entry, `src/content/pages/home.md`:

```markdown
---
title: Home
blocks:
  - type: hero
    heading: Build something
    subheading: Start here.
  - type: features
    heading: Why us
    items:
      - title: Fast
        description: Pages are static HTML.
      - title: Simple
        description: Content lives in your repository.
  - type: testimonials
    heading: What people say
    testimonialIds:
      - ada
---
```

## Components

Put one component per block type in `src/components/blocks/`, named after
the type with a `Block` suffix: `hero` is `HeroBlock.astro`, `testimonials`
is `TestimonialsBlock.astro`. Each takes the block as a `block` prop. The
integration's component preview (below) finds components by that name
(`Hero.astro` also works, and case and punctuation are ignored, so
`feature-grid` finds `FeatureGridBlock.astro`); a page can render the
components any way it likes.

```astro
---
// src/components/blocks/HeroBlock.astro
const { block, index } = Astro.props;
---
<section data-block-index={index}>
  <h1 data-aa-field={`blocks[${index}].heading`}>{block.heading}</h1>
  {block.subheading && <p data-aa-field={`blocks[${index}].subheading`}>{block.subheading}</p>}
  {block.image && <img src={block.image} alt={block.imageAlt ?? ''} />}
</section>
```

```astro
---
// src/components/blocks/TestimonialsBlock.astro
import { getEntries } from 'astro:content';

const { block, index } = Astro.props;
const quotes = await getEntries(
  block.testimonialIds.map((id) => ({ collection: 'testimonials', id })),
);
---
<section data-block-index={index}>
  {block.heading && <h2 data-aa-field={`blocks[${index}].heading`}>{block.heading}</h2>}
  {quotes.map((quote) => (
    <blockquote>
      <p>{quote.data.quote}</p>
      <cite>{quote.data.author}</cite>
    </blockquote>
  ))}
</section>
```

The page maps each block to its component:

```astro
---
// src/pages/index.astro
import { getEntry } from 'astro:content';
import HeroBlock from '../components/blocks/HeroBlock.astro';
import FeaturesBlock from '../components/blocks/FeaturesBlock.astro';
import TestimonialsBlock from '../components/blocks/TestimonialsBlock.astro';

const components = {
  hero: HeroBlock,
  features: FeaturesBlock,
  testimonials: TestimonialsBlock,
};

const page = await getEntry('pages', 'home');
---
<main>
  {page.data.blocks.map((block, index) => {
    const Block = components[block.type];
    return <Block block={block} index={index} />;
  })}
</main>
```

`data-block-index` and `data-aa-field` are optional. With them, clicking a
block's header in the editor outlines that block in the preview, and
clicking its text in the preview opens the field.
[Click-to-edit](./inline-editing.md#click-to-edit-in-the-preview) has the
naming rules, and its [Arrays](./inline-editing.md#arrays) section shows how
to annotate the items of a `features` block.

## Previewing a collection that blocks use

`testimonials` has no page of its own. Because the `testimonials` block
refers to it through `testimonialIds` (a `reference()` list works the same
way), AstroAdmin can still preview an entry by rendering that block with
only that entry in it, at `/component-preview/testimonials/<id>`. This
needs:

- the integration in `astro.config.mjs`:

  ```javascript
  import { defineConfig } from 'astro/config';
  import astroadmin from 'astroadmin/integration';

  export default defineConfig({
    integrations: [astroadmin()],
  });
  ```

- the block component at `src/components/blocks/TestimonialsBlock.astro`,
  reading `block.testimonialIds`.

The block the route renders holds only `type` and the reference field, set
to that one id. The component receives it as `block`, and also spread as
props (`Astro.props.testimonialIds`), with `index` 0, so it must cope with
the block's other fields being absent. If the site has
`src/styles/global.css`, the route loads it; any other styles must come from
the component itself.

The route exists only under `astro dev`, never in a production build. If
several block types refer to the same collection, the editor offers a choice
of which to preview. A collection with a page of its own is better served by
a [preview route](./configuration.md#preview), which takes precedence.
