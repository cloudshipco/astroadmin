/**
 * `astroadmin/image-service`: Astro's sharp image service with a
 * non-destructive `crop` transform option (#82), for the crop an editor
 * draws in the admin's image library and CmsImage reads from
 * `public/images/.metadata.json`. A site enables it in astro.config.mjs:
 *
 *   image: { service: { entrypoint: 'astroadmin/image-service' } }
 *
 * `crop` is `{ x, y, width, height }`, percentages of the ORIGINAL image
 * (as displayed, i.e. after EXIF rotation), with `x + width <= 100` and
 * `y + height <= 100`. Every other option, and every transform without a
 * crop, is the parent's unchanged:
 *
 * - `validateOptions`: the parent's, then the crop's shape; an invalid crop
 *   is an error naming the field, never dropped (a stored crop that was
 *   silently ignored would ship the uncropped photo).
 * - `getURL` / `parseURL`: `crop=x,y,width,height` on the dev `/_image` URL
 *   (the dev endpoint calls parseURL then transform directly, so a
 *   malformed value parses as no crop).
 * - `propertiesToHash`: the parent's plus `crop`, so a build emits one file
 *   per crop (Astro keys generated images by this hash).
 * - `getHTMLAttributes`: the parent's result without `crop` (the parent
 *   spreads unknown options onto the <img>).
 * - `supportsCrop: true`: the marker CmsImage reads from the service Astro
 *   loaded, so a site that names this service by another spelling (a local
 *   re-export, an absolute path) is recognised.
 * - `transform`: with a crop, the source is opened as the parent opens it
 *   (every page, `pages: -1`), rotated (EXIF) and the crop's pixels are
 *   extracted from each frame, rounded from the percentages against the
 *   ROTATED frame size (`cropPixels`, which CmsImage uses for the same
 *   numbers), encoded losslessly (a WebP for an animated image, which keeps
 *   its frames and delays; else a PNG, at 16 bits for a 16-bit source) and
 *   handed to the parent's transform, which resizes and encodes as it does
 *   any source. sharp is the SITE's, resolved as the parent resolves it
 *   (`import('sharp')`), lazily.
 */
import sharpService from 'astro/assets/services/sharp';
import { baseService } from 'astro/assets';
import { CROP_SIDES, cropPixels, parseCrop } from './crop.js';

export { cropPixels, parseCrop };

function parseCropParam(text) {
  if (typeof text !== 'string') return undefined;
  const parts = text.split(',');
  if (parts.length !== CROP_SIDES.length) return undefined;
  const value = {};
  CROP_SIDES.forEach((side, index) => {
    value[side] = parts[index] === '' ? NaN : Number(parts[index]);
  });
  return parseCrop(value);
}

let sharp;
/** The site's sharp, as the parent loads it. */
async function loadSharp() {
  if (!sharp) {
    sharp = (await import('sharp')).default;
    sharp.cache(false);
  }
  return sharp;
}

const service = {
  ...sharpService,
  /**
   * The capability CmsImage checks on the LOADED service
   * (`getConfiguredImageService()`), whatever spelling the site's
   * `image.service.entrypoint` used: a local re-export or an absolute path
   * is this same service, and must not fail the build as "another service".
   */
  supportsCrop: true,
  propertiesToHash: [...(sharpService.propertiesToHash ?? baseService.propertiesToHash), 'crop'],

  validateOptions(options, imageConfig, logger) {
    const validated = sharpService.validateOptions(options, imageConfig, logger);
    if (validated.crop === undefined || validated.crop === null) {
      delete validated.crop;
      return validated;
    }
    const crop = parseCrop(validated.crop);
    if (crop === undefined) {
      const src = typeof validated.src === 'object' ? validated.src.src : validated.src;
      throw new Error(
        `astroadmin/image-service: the crop for "${src}" must be {x, y, width, height}, ` +
          `percentages with x + width <= 100 and y + height <= 100; got ${JSON.stringify(validated.crop)}.`,
      );
    }
    validated.crop = crop;
    return validated;
  },

  getURL(options, imageConfig, logger) {
    const url = sharpService.getURL(options, imageConfig, logger);
    const crop = parseCrop(options.crop);
    if (crop === undefined || url === options.src) return url;
    const param = new URLSearchParams({ crop: CROP_SIDES.map((side) => String(crop[side])).join(',') });
    return `${url}${url.includes('?') ? '&' : '?'}${param}`;
  },

  parseURL(url, imageConfig, logger) {
    const transform = sharpService.parseURL(url, imageConfig, logger);
    if (!transform) return transform;
    const crop = parseCropParam(url.searchParams.get('crop'));
    if (crop !== undefined) transform.crop = crop;
    return transform;
  },

  getHTMLAttributes(options, imageConfig, logger) {
    const { crop: _crop, ...attributes } = sharpService.getHTMLAttributes(options, imageConfig, logger);
    return attributes;
  },

  async transform(inputBuffer, transformOptions, config, logger) {
    // An SVG is served as its own bytes by the parent (format 'svg'): a crop
    // would rasterise it first and the PNG would be served as SVG, so the
    // crop is ignored for it, as it is for any image with none.
    if (transformOptions.crop === undefined || transformOptions.crop === null || transformOptions.format === 'svg') {
      return sharpService.transform(inputBuffer, transformOptions, config, logger);
    }
    const crop = parseCrop(transformOptions.crop);
    if (crop === undefined) {
      throw new Error(`astroadmin/image-service: invalid crop ${JSON.stringify(transformOptions.crop)} for "${transformOptions.src}".`);
    }
    const sharpImport = await loadSharp();
    // Opened as the parent opens its input: every page of an animated image
    // (`pages: -1`), not just the first.
    const source = sharpImport(inputBuffer, { failOn: 'none', pages: -1, limitInputPixels: config.service.config.limitInputPixels });
    const { width, height, pages, pageHeight, orientation, depth, space } = await source.metadata();
    // With every page read, `height` is all the frames stacked; each frame is `pageHeight`.
    const frameHeight = pages > 1 && pageHeight ? pageHeight : height;
    if (!width || !frameHeight) {
      throw new Error(`astroadmin/image-service: could not read the size of "${transformOptions.src}" to crop it.`);
    }
    // `metadata()` reports the stored size; `rotate()` (no angle) applies the
    // EXIF orientation, which swaps the sides for orientations 5-8, as
    // Astro's ImageMetadata does. rotate() before extract() makes the
    // extract region relative to the rotated image (and, on an animated
    // image, relative to each frame: sharp extracts from every page).
    const rotatedSize = (orientation ?? 0) >= 5 ? { width: frameHeight, height: width } : { width, height: frameHeight };
    const box = cropPixels(crop, rotatedSize.width, rotatedSize.height);
    let pipeline = source.rotate().extract(box);
    if (pages > 1) {
      // The lossless intermediate of an animated image is a WebP, which keeps
      // its frames, loop and delays (PNG has no pages). The parent then
      // handles it as it does any animated source.
      pipeline = pipeline.webp({ lossless: true });
    } else {
      // PNG, lossless; `png()` writes 8 bits unless the pipeline ends in a
      // 16-bit interpretation, so a 16-bit source (rgb16 or grey16) is kept
      // at 16 for the parent's resize. The values survive rotate/extract
      // exactly (measured: every sample equal, not 8-bit scaled).
      if (depth === 'ushort') pipeline = pipeline.toColourspace(space === 'grey16' ? 'grey16' : 'rgb16');
      pipeline = pipeline.png({ compressionLevel: 0 });
    }
    const cropped = await pipeline.toBuffer();
    const { crop: _crop, ...rest } = transformOptions;
    return sharpService.transform(cropped, rest, config, logger);
  },
};

export default service;
