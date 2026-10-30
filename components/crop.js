/**
 * The crop an editor draws in the admin's image library (#82), as the
 * metadata file stores it and as the image service and CmsImage read it.
 * Dependency-free on purpose: site-files.js imports it for every CmsImage
 * and CmsVideo render, and must not pull in the sharp image service
 * (image-service.js imports `astro/assets` and the sharp service at module
 * top) for a render that never crops.
 *
 * A crop is `{ x, y, width, height }`, percentages of the ORIGINAL image as
 * displayed (after EXIF rotation), with `x + width <= 100` and
 * `y + height <= 100`.
 */

export const CROP_SIDES = ['x', 'y', 'width', 'height'];

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
