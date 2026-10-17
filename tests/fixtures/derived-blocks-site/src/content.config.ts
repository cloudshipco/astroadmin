// Derived on 2026-10-17 from the content config of a real client site (unnamed:
// this repository is public): its shared field types, every block and its pages
// collection, as the site wrote them, with comments removed and four example
// strings in descriptions made generic. Used by tests/block-reveal.test.js.
import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";
import { YOUTUBE_URL_MESSAGE, isLocalPosterPath, youtubeVideoId } from "./lib/youtube";
const text = z.string().trim().min(1);
const isSafeHref = (value) => /^\/(?!\/)/.test(value) || value.startsWith("#") || /^https?:\/\//i.test(value) || /^mailto:/i.test(value);
const href = text.refine(isSafeHref, {
  message: "Link must start with /, #, mailto:, http:// or https://"
});
const optionalText = z.string().trim();
const optionalHref = z.string().trim().refine((value) => value === "" || isSafeHref(value), {
  message: "Link must start with /, #, mailto:, http:// or https://"
});
const richText = z.object({
  type: z.literal("richText"),
  body: text.describe("textarea \u2014 one paragraph per blank line. Markdown links allowed.")
});
const heading = z.object({
  type: z.literal("heading"),
  kicker: z.string().optional().describe("Small label above the heading"),
  text
});
const bulletList = z.object({
  type: z.literal("bulletList"),
  heading: z.string().optional(),
  intro: z.string().optional().describe("textarea"),
  items: z.array(text.describe("textarea")).min(1)
});
const steps = z.object({
  type: z.literal("steps"),
  heading: z.string().optional(),
  intro: z.string().optional().describe("textarea"),
  steps: z.array(
    z.object({
      title: text,
      body: text.describe("textarea")
    })
  ).min(1)
});
const featureGrid = z.object({
  type: z.literal("featureGrid"),
  heading: z.string().optional(),
  intro: z.string().optional().describe("textarea"),
  items: z.array(
    z.object({
      title: text,
      body: text.describe("textarea"),
      href: optionalHref.optional().describe("Optional link, e.g. /services"),
      linkLabel: optionalText.optional()
    })
  ).min(1)
});
const quote = z.object({
  type: z.literal("quote"),
  quote: text.describe("textarea"),
  attribution: text,
  role: z.string().optional(),
  image: z.string().optional().describe("Path under /public, e.g. /images/portrait.jpg"),
  imageAlt: z.string().optional()
});
const imageBand = z.object({
  type: z.literal("imageBand"),
  image: text.describe("Path under /public, e.g. /images/hero.jpg"),
  alt: z.string().describe("Leave blank only if the image is purely decorative"),
  caption: z.string().optional()
});
const video = z.object({
  type: z.literal("video"),
  url: text.refine((value) => youtubeVideoId(value) !== null, { message: YOUTUBE_URL_MESSAGE }).describe("YouTube link, e.g. https://www.youtube.com/watch?v=\u2026"),
  title: text.describe('What the video is, read out by screen readers, e.g. "A walk round the studio"'),
  caption: optionalText.optional().describe("Optional line shown under the video"),
  posterImage: optionalText.refine(isLocalPosterPath, { message: "Upload the poster image here, or leave blank for a plain panel" }).optional().describe("Still shown before the video plays. Leave blank for a plain panel with the title")
});
const cta = z.object({
  type: z.literal("cta"),
  heading: text,
  body: z.string().optional().describe("textarea"),
  label: text,
  href
});
const block = z.discriminatedUnion("type", [
  richText,
  heading,
  bulletList,
  steps,
  featureGrid,
  quote,
  imageBand,
  video,
  cta
]);
const pages = defineCollection({
  loader: glob({ base: "src/content/pages", pattern: "**/*.json" }),
  schema: z.object({
    title: text.describe("Short name, used for the browser tab and internal links"),
    slug: z.string().regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Slug must be lowercase words separated by hyphens"
    ).describe("URL path without slashes"),
    navLabel: optionalText.optional().describe("Leave blank to keep it out of the top nav"),
    navOrder: z.number().optional(),
    kicker: optionalText.optional(),
    headline: optionalText.optional().describe("textarea"),
    standfirst: optionalText.optional().describe("textarea \u2014 short intro under the headline"),
    introImage: optionalText.optional().describe("e.g. placeholder:portrait or /images/intro.jpg"),
    introImageAlt: optionalText.optional(),
    seoTitle: optionalText.optional(),
    seoDescription: optionalText.optional().describe("textarea"),
    blocks: z.array(block)
  })
});
export const collections = { pages };
