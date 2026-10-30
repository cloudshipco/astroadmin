/**
 * The crop view: show a preview <img> cropped to a stored crop (#82), in CSS,
 * without touching the file. Shared by the image field's preview and the
 * library's grid thumbnails, so a crop set in the library is seen at once
 * rather than after Publish.
 *
 * With a crop, the <img> is moved into a window (`[data-crop-window]`, a div
 * put where the image was) the shape of the crop region, and sized from the
 * crop's percentages of the original: width 100/crop.width of the window,
 * left -crop.x/crop.width of it, the same for height and top, so the window
 * shows exactly the region. The window's shape needs the picture's own
 * proportions, read from the loaded <img> (`naturalWidth`), so an image still
 * loading is cropped when it has loaded. The container (the preview, the grid
 * cell) clips and carries `data-cropped`, which the CSS captions "Cropped";
 * how the window fits the container (contained in the field preview, covering
 * the square grid cell) is the container's CSS, in ui/input.css.
 *
 * With no crop, nothing is added: a preview that was never cropped keeps the
 * DOM its renderer produced, and one that was cropped gets its <img> back
 * where it was, with the window, the attribute and the inline style removed.
 * Positions are set as style properties, never interpolated into markup.
 */

export const CROPPED_ATTRIBUTE = 'data-cropped';
export const CROP_WINDOW_ATTRIBUTE = 'data-crop-window';
/** The window's aspect ratio (crop region width over height), read by the CSS. */
const ASPECT_PROPERTY = '--crop-aspect';
/** The inline properties the view sets on the <img>, removed when the crop goes. */
const IMAGE_PROPERTIES = ['width', 'height', 'left', 'top'];

/** @type {WeakMap<HTMLImageElement, () => void>} the load listener waiting on each image */
const pendingLoads = new WeakMap();

/** A percentage the listing gave: a finite number from 0 to 100. */
export function isPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** A crop as the server stores it: percentages of the original, with a size. */
export function isCrop(crop) {
  return Boolean(crop) && typeof crop === 'object'
    && isPercent(crop.x) && isPercent(crop.y) && isPercent(crop.width) && isPercent(crop.height)
    && crop.width > 0 && crop.height > 0;
}

/**
 * Show `image` cropped to `crop` inside `container`, or whole for no crop.
 * @param {HTMLElement} container - the element that clips (the field's
 *   preview, the grid cell); the image is inside it
 * @param {HTMLImageElement} image - the preview image
 * @param {object|null|undefined} crop - the stored crop, or none
 */
export function showCropView(container, image, crop) {
  cancelPendingLoad(image);
  if (!isCrop(crop)) {
    clearCropView(container, image);
    return;
  }
  if (!(image.complete && image.naturalWidth > 0)) {
    // Not loaded (or a new src loading): size the window once it is. Until
    // then the image is shown as it is; an image that fails to load stays so.
    const onLoad = () => {
      pendingLoads.delete(image);
      if (image.naturalWidth > 0) showCropView(container, image, crop);
    };
    pendingLoads.set(image, onLoad);
    image.addEventListener('load', onLoad, { once: true });
    return;
  }
  const cropWindow = windowFor(container, image);
  const regionWidth = image.naturalWidth * crop.width / 100;
  const regionHeight = image.naturalHeight * crop.height / 100;
  cropWindow.style.setProperty(ASPECT_PROPERTY, String(regionWidth / regionHeight));
  // 'important': a thumbnail variant sizes its <img> with !important rules
  image.style.setProperty('width', `${10000 / crop.width}%`, 'important');
  image.style.setProperty('height', `${10000 / crop.height}%`, 'important');
  image.style.setProperty('left', `${-crop.x / crop.width * 100}%`, 'important');
  image.style.setProperty('top', `${-crop.y / crop.height * 100}%`, 'important');
  container.setAttribute(CROPPED_ATTRIBUTE, '');
}

/** The container's crop window, made around the image on first use. */
function windowFor(container, image) {
  const existing = image.parentElement;
  if (existing !== container && existing?.hasAttribute(CROP_WINDOW_ATTRIBUTE)) return existing;
  const cropWindow = container.ownerDocument.createElement('div');
  cropWindow.className = 'crop-window';
  cropWindow.setAttribute(CROP_WINDOW_ATTRIBUTE, '');
  image.parentNode.insertBefore(cropWindow, image);
  cropWindow.appendChild(image);
  return cropWindow;
}

/** Put the image back as it was rendered: no window, attribute or inline style. */
function clearCropView(container, image) {
  const cropWindow = image.parentElement;
  if (cropWindow && cropWindow !== container && cropWindow.hasAttribute(CROP_WINDOW_ATTRIBUTE)) {
    cropWindow.parentNode.insertBefore(image, cropWindow);
    cropWindow.remove();
  }
  container.removeAttribute(CROPPED_ATTRIBUTE);
  for (const property of IMAGE_PROPERTIES) image.style.removeProperty(property);
  if (image.getAttribute('style') === '') image.removeAttribute('style');
}

function cancelPendingLoad(image) {
  const pending = pendingLoads.get(image);
  if (!pending) return;
  image.removeEventListener('load', pending);
  pendingLoads.delete(image);
}
