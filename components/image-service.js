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
 * - `transform`: with a crop, the source is rotated (EXIF) and the crop's
 *   pixels are extracted, rounded from the percentages against the ROTATED
 *   size (`cropPixels`, which CmsImage uses for the same numbers), encoded
 *   losslessly (PNG) and handed to the parent's transform, which resizes and
 *   encodes as it does any source. sharp is the SITE's, resolved as the
 *   parent resolves it (`import('sharp')`), lazily.
 */
import sharpService from 'astro/assets/services/sharp';
import { baseService } from 'astro/assets';

const CROP_SIDES = ['x', 'y', 'width', 'height'];

/** The crop as `{x, y, width, height}` numbers, or undefined when `value` is not one. */
export function parseCrop(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const crop = {};
  for (const side of CROP_SIDES) {
    const number = value[side];
    if (typeof number !== 'number' || !Number.isFinite(number)) return undefined;
    crop[side] = number;
  }
  if (crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0) return undefined;
  if (crop.x + crop.width > 100 || crop.y + crop.height > 100) return undefined;
  return crop;
}

/**
 * The crop in pixels of an image `width` x `height` (its displayed size):
 * each percentage rounded, the box held inside the image (a rounded left
 * plus a rounded width can run one past the edge) and at least one pixel.
 */
export function cropPixels(crop, width, height) {
  const left = Math.min(Math.round((crop.x / 100) * width), width - 1);
  const top = Math.min(Math.round((crop.y / 100) * height), height - 1);
  return {
    left,
    top,
    width: Math.max(1, Math.min(Math.round((crop.width / 100) * width), width - left)),
    height: Math.max(1, Math.min(Math.round((crop.height / 100) * height), height - top)),
  };
}

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
    if (transformOptions.crop === undefined || transformOptions.crop === null) {
      return sharpService.transform(inputBuffer, transformOptions, config, logger);
    }
    const crop = parseCrop(transformOptions.crop);
    if (crop === undefined) {
      throw new Error(`astroadmin/image-service: invalid crop ${JSON.stringify(transformOptions.crop)} for "${transformOptions.src}".`);
    }
    const sharpImport = await loadSharp();
    const source = sharpImport(inputBuffer, { failOn: 'none', limitInputPixels: config.service.config.limitInputPixels });
    const { width, height, orientation } = await source.metadata();
    if (!width || !height) {
      throw new Error(`astroadmin/image-service: could not read the size of "${transformOptions.src}" to crop it.`);
    }
    // `metadata()` reports the stored size; `rotate()` (no angle) applies the
    // EXIF orientation, which swaps the sides for orientations 5-8, as
    // Astro's ImageMetadata does. rotate() before extract() makes the
    // extract region relative to the rotated image.
    const rotatedSize = (orientation ?? 0) >= 5 ? { width: height, height: width } : { width, height };
    const box = cropPixels(crop, rotatedSize.width, rotatedSize.height);
    const cropped = await source.rotate().extract(box).png({ compressionLevel: 0 }).toBuffer();
    const { crop: _crop, ...rest } = transformOptions;
    return sharpService.transform(cropped, rest, config, logger);
  },
};

export default service;
