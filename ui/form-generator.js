/**
 * Form Generator
 * Auto-generates forms from schema definitions
 * Supports blocks (discriminated unions) with type-based fields
 */

/**
 * Generate a form from schema
 */
export function generateForm(schema, data = {}) {
  const formHtml = [];
  const hiddenHtml = [];

  for (const [fieldName, fieldSchema] of Object.entries(schema.properties || {})) {
    const value = data[fieldName];

    // Hidden fields are rendered as hidden inputs to preserve data
    if (fieldSchema.hidden) {
      if (value !== undefined && value !== null) {
        // For objects, serialize as JSON with special data attribute
        if (typeof value === 'object') {
          const escapedValue = JSON.stringify(value).replace(/"/g, '&quot;');
          hiddenHtml.push(`<input type="hidden" name="${fieldName}" value="${escapedValue}" data-json="true">`);
        } else {
          const escapedValue = String(value).replace(/"/g, '&quot;');
          hiddenHtml.push(`<input type="hidden" name="${fieldName}" value="${escapedValue}">`);
        }
      }
      continue;
    }

    const fieldHtml = generateField(fieldName, fieldSchema, value);
    formHtml.push(fieldHtml);
  }

  // Add hidden fields at the start
  return hiddenHtml.join('\n') + '\n' + formHtml.join('\n');
}

/**
 * Generate a single field
 */
function generateField(name, schema, value, path = '') {
  const fullPath = path ? `${path}.${name}` : name;
  const id = fullPath.replace(/\./g, '_').replace(/\[/g, '_').replace(/\]/g, '');

  // Handle blocks array (discriminated union)
  if (schema.type === 'array' && schema.blockTypes) {
    return generateBlocksField(name, schema, value, fullPath);
  }

  if (schema.type === 'object') {
    // Nested object
    return `
      <div class="mb-6">
        <fieldset class="nested-fieldset">
          <legend class="text-sm font-semibold text-gray-700 mb-3">${formatLabel(name)}</legend>
          <div class="space-y-4">
            ${Object.entries(schema.properties || {}).map(([key, subSchema]) =>
              generateField(key, subSchema, value?.[key], fullPath)
            ).join('\n')}
          </div>
        </fieldset>
      </div>
    `;
  }

  if (schema.type === 'array') {
    // Regular array of items
    const items = Array.isArray(value) ? value : [];
    return `
      <div class="form-group">
        <label>${formatLabel(name)}</label>
        <div class="array-field" data-field="${fullPath}" data-schema='${JSON.stringify(schema.items || {})}'>
          ${items.map((item, index) => `
            <div class="array-item" data-index="${index}">
              ${generateArrayItem(fullPath, schema.items, item, index)}
              <button type="button" class="btn btn-danger btn-sm remove-array-item">Remove</button>
            </div>
          `).join('\n')}
          <button type="button" class="btn btn-secondary btn-sm add-array-item" data-field="${fullPath}">
            Add ${formatLabel(name)}
          </button>
        </div>
      </div>
    `;
  }

  if (schema.type === 'boolean') {
    return `
      <div class="form-group">
        <label class="checkbox-label">
          <input
            type="checkbox"
            name="${fullPath}"
            id="${id}"
            class="rounded border-gray-300 text-primary-500 focus:ring-primary-500"
            ${value ? 'checked' : ''}
          >
          <span class="text-sm text-gray-700">${formatLabel(name)}</span>
        </label>
      </div>
    `;
  }

  if (schema.type === 'number') {
    return `
      <div class="form-group">
        <label for="${id}" class="form-label">${getFieldLabel(name, schema)} ${schema.required ? '<span class="text-red-500">*</span>' : ''}</label>
        <input
          type="number"
          name="${fullPath}"
          id="${id}"
          value="${value ?? schema.default ?? ''}"
          class="form-input"
          ${schema.min !== undefined ? `min="${schema.min}"` : ''}
          ${schema.max !== undefined ? `max="${schema.max}"` : ''}
          ${schema.placeholder ? `placeholder="${escapeHtml(schema.placeholder)}"` : ''}
          ${schema.required ? 'required' : ''}
        >
      </div>
    `;
  }

  // Handle enum/select
  if (schema.enum) {
    return `
      <div class="form-group">
        <label for="${id}" class="form-label">${getFieldLabel(name, schema)}</label>
        <select name="${fullPath}" id="${id}" class="form-input">
          ${schema.enum.map(opt => `
            <option value="${opt}" ${value === opt ? 'selected' : ''}>${formatLabel(opt)}</option>
          `).join('')}
        </select>
      </div>
    `;
  }

  // Check if this is an image field
  if (isImageField(name, schema)) {
    return generateImageField(name, schema, value, fullPath, id);
  }

  // Check if this is a color field
  if (isColorField(name, schema)) {
    return generateColorField(name, schema, value, fullPath, id);
  }

  // Default: string input
  const inputType = schema.format === 'email' ? 'email' :
                    schema.format === 'url' ? 'url' :
                    schema.format === 'date' ? 'date' : 'text';

  // Large text field for long content
  if (schema.multiline || name.toLowerCase().includes('description') || name.toLowerCase().includes('content')) {
    return `
      <div class="form-group">
        <label for="${id}" class="form-label">${getFieldLabel(name, schema)} ${schema.required ? '<span class="text-red-500">*</span>' : ''}</label>
        <textarea
          name="${fullPath}"
          id="${id}"
          rows="4"
          class="form-input"
          ${schema.placeholder ? `placeholder="${escapeHtml(schema.placeholder)}"` : ''}
          ${schema.required ? 'required' : ''}
        >${escapeHtml(value ?? '')}</textarea>
      </div>
    `;
  }

  return `
    <div class="form-group">
      <label for="${id}" class="form-label">${getFieldLabel(name, schema)} ${schema.required ? '<span class="text-red-500">*</span>' : ''}</label>
      <input
        type="${inputType}"
        name="${fullPath}"
        id="${id}"
        value="${escapeHtml(value ?? '')}"
        class="form-input"
        ${schema.placeholder ? `placeholder="${escapeHtml(schema.placeholder)}"` : ''}
        ${schema.required ? 'required' : ''}
      >
    </div>
  `;
}

/**
 * Generate blocks field (array with discriminated union)
 */
function generateBlocksField(name, schema, value, fullPath) {
  const blocks = Array.isArray(value) ? value : [];
  const blockTypes = schema.blockTypes || {};
  const availableTypes = Object.keys(blockTypes);

  return `
    <div class="form-group blocks-container" data-field="${fullPath}">
      <div class="blocks-header">
        <label class="form-label">${formatLabel(name)}</label>
        <div class="blocks-actions">
          <select id="add-block-type" class="form-input form-input-sm">
            <option value="">Add block...</option>
            ${availableTypes.map(type => `
              <option value="${type}">${formatBlockType(type)}</option>
            `).join('')}
          </select>
          <button type="button" class="btn btn-primary btn-sm add-block-btn" data-field="${fullPath}">
            Add
          </button>
        </div>
      </div>

      <div class="blocks-list" data-field="${fullPath}" data-block-types='${JSON.stringify(blockTypes)}'>
        ${blocks.map((block, index) => generateBlockItem(fullPath, blockTypes, block, index)).join('\n')}
      </div>
    </div>
  `;
}

/**
 * Generate a single block item
 */
function generateBlockItem(arrayPath, blockTypes, block, index) {
  const blockType = block?.type;
  const blockSchema = blockTypes[blockType];
  const path = `${arrayPath}[${index}]`;

  if (!blockSchema) {
    return `
      <div class="block-item block-item-error" data-index="${index}" data-type="${blockType || 'unknown'}">
        <div class="block-header">
          <span class="block-type-badge">Unknown: ${blockType}</span>
        </div>
        <p class="text-red-500">Unknown block type</p>
      </div>
    `;
  }

  const blockFields = generateBlockFields(path, blockSchema.properties, block);

  return `
    <div class="block-item" data-index="${index}" data-type="${blockType}" draggable="true">
      <div class="block-header toggle-block-header">
        <span class="block-drag-handle" title="Drag to reorder">⋮⋮</span>
        <span class="block-type-badge block-type-${blockType}">${formatBlockType(blockType)}</span>
        <span class="block-preview-text">${getBlockPreview(block)}</span>
        <span class="block-expand-icon">▶</span>
      </div>
      <div class="block-body">
        <input type="hidden" name="${path}.type" value="${blockType}">
        ${blockFields}
        <div class="block-footer">
          <button type="button" class="btn btn-sm btn-danger remove-block" onclick="event.stopPropagation()">Delete Section</button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Generate fields for a block based on its schema
 */
function generateBlockFields(path, properties, data) {
  if (!properties) return '';

  return Object.entries(properties)
    .filter(([key]) => key !== 'type') // Skip the type field (it's hidden)
    .map(([key, schema]) => generateField(key, schema, data?.[key], path))
    .join('\n');
}

/**
 * Get a preview text for a block
 */
function getBlockPreview(block) {
  if (!block) return '';

  // Try common fields for preview
  const previewFields = ['heading', 'title', 'content', 'description', 'name'];
  for (const field of previewFields) {
    if (block[field]) {
      const text = String(block[field]);
      return text.length > 50 ? text.substring(0, 50) + '...' : text;
    }
  }

  return '';
}

/**
 * Generate array item fields
 */
function generateArrayItem(arrayPath, itemSchema, value, index) {
  const path = `${arrayPath}[${index}]`;

  if (itemSchema?.type === 'object') {
    return `
      <div class="array-item-fields">
        ${Object.entries(itemSchema.properties || {}).map(([key, schema]) =>
          generateField(key, schema, value?.[key], path)
        ).join('\n')}
      </div>
    `;
  }

  // Simple array (strings, numbers, etc.)
  return `
    <input
      type="text"
      name="${path}"
      value="${escapeHtml(value ?? '')}"
      class="array-item-input form-input"
      placeholder="Enter value..."
    >
  `;
}

/**
 * Check if a field is an image field based on name and schema
 */
function isImageField(name, schema) {
  // Field names that indicate an image
  const imageFieldNames = ['image', 'logo', 'ogImage', 'src', 'icon', 'avatar', 'photo', 'thumbnail', 'banner', 'background'];
  const lowerName = name.toLowerCase();

  // Check if field name matches common image field patterns
  if (imageFieldNames.some(imgName => lowerName === imgName.toLowerCase() || lowerName.endsWith(imgName.toLowerCase()))) {
    return true;
  }

  // Check if schema explicitly marks it as image
  if (schema.format === 'image' || schema.widget === 'image') {
    return true;
  }

  return false;
}

/**
 * Generate an image picker field
 */
function generateImageField(name, schema, value, fullPath, id) {
  const hasValue = value && value.trim();
  const previewClass = hasValue ? '' : 'hidden';
  const placeholderClass = hasValue ? 'hidden' : '';

  return `
    <div class="form-group">
      <label for="${id}" class="form-label">${getFieldLabel(name, schema)} ${schema.required ? '<span class="text-red-500">*</span>' : ''}</label>
      <div class="image-picker" data-field="${fullPath}">
        <div class="image-picker-preview ${previewClass}" data-preview>
          <img src="${escapeHtml(value || '')}" alt="Preview" class="image-picker-img" data-preview-img>
          <button type="button" class="image-picker-clear" data-clear title="Clear image">&times;</button>
        </div>
        <div class="image-picker-placeholder ${placeholderClass}" data-placeholder>
          <span class="image-picker-icon">📷</span>
          <span>No image selected</span>
        </div>
        <div class="image-picker-actions">
          <button type="button" class="btn btn-sm btn-secondary image-picker-browse" data-browse>
            Browse Library
          </button>
          <button type="button" class="btn btn-sm btn-secondary image-picker-upload" data-upload>
            Upload New
          </button>
        </div>
        <input
          type="hidden"
          name="${fullPath}"
          id="${id}"
          value="${escapeHtml(value || '')}"
          class="image-picker-input"
          ${schema.required ? 'required' : ''}
        >
        <input
          type="text"
          class="form-input image-picker-url"
          style="margin-top: 0.5rem;"
          value="${escapeHtml(value || '')}"
          placeholder="/images/filename.jpg or https://..."
          data-url-input
        >
      </div>
    </div>
  `;
}

/**
 * Check if a field is a color field based on name and schema
 */
function isColorField(name, schema) {
  const lowerName = name.toLowerCase();

  // Check if field name contains color-related terms
  if (lowerName.includes('color') || lowerName.includes('colour') || lowerName.includes('background')) {
    return true;
  }

  // Check if schema explicitly marks it as color
  if (schema.format === 'color' || schema.widget === 'color') {
    return true;
  }

  return false;
}

/**
 * Generate a color picker field
 */
function generateColorField(name, schema, value, fullPath, id) {
  // Convert named colors or other formats to hex for the picker
  const colorValue = value || '';

  return `
    <div class="form-group">
      <label for="${id}" class="form-label">${getFieldLabel(name, schema)} ${schema.required ? '<span class="text-red-500">*</span>' : ''}</label>
      <div class="color-picker-wrapper">
        <input
          type="color"
          id="${id}_picker"
          value="${colorToHex(colorValue) || '#ffffff'}"
          class="color-picker-input"
          data-target="${id}"
        >
        <input
          type="text"
          name="${fullPath}"
          id="${id}"
          value="${escapeHtml(colorValue)}"
          class="form-input color-picker-text"
          placeholder="#ffffff or color name"
          ${schema.required ? 'required' : ''}
        >
        ${colorValue ? `<button type="button" class="color-picker-clear" data-clear-color="${id}" title="Clear color">&times;</button>` : ''}
      </div>
    </div>
  `;
}

/**
 * Convert color value to hex (best effort)
 */
function colorToHex(color) {
  if (!color) return '';

  // Already hex
  if (color.startsWith('#')) {
    // Expand shorthand (#fff -> #ffffff)
    if (color.length === 4) {
      return '#' + color[1] + color[1] + color[2] + color[2] + color[3] + color[3];
    }
    return color;
  }

  // Named colors - common ones
  const namedColors = {
    'white': '#ffffff',
    'black': '#000000',
    'red': '#ff0000',
    'green': '#008000',
    'blue': '#0000ff',
    'yellow': '#ffff00',
    'orange': '#ffa500',
    'purple': '#800080',
    'pink': '#ffc0cb',
    'gray': '#808080',
    'grey': '#808080',
    'transparent': '#ffffff',
  };

  const lowerColor = color.toLowerCase();
  if (namedColors[lowerColor]) {
    return namedColors[lowerColor];
  }

  // Default to white if we can't parse
  return '#ffffff';
}

/**
 * Format field name into readable label
 */
function formatLabel(name) {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, str => str.toUpperCase())
    .trim();
}

/**
 * Get label for a field (uses schema.label if provided, otherwise formats the name)
 */
function getFieldLabel(name, schema) {
  return schema.label || formatLabel(name);
}

/**
 * Format block type into readable label
 */
function formatBlockType(type) {
  const labels = {
    hero: 'Hero Section',
    features: 'Features Grid',
    sectionHeader: 'Section Header',
    richText: 'Rich Text',
    textImage: 'Text + Image',
    stats: 'Statistics',
    testimonials: 'Testimonials',
    gallery: 'Image Gallery',
    cta: 'Call to Action',
    organizations: 'Organizations',
    seo: 'SEO & Page Info',
  };
  return labels[type] || formatLabel(type);
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Extract form data into object matching schema structure
 */
export function extractFormData(formElement) {
  const formData = new FormData(formElement);
  const data = {};

  // First, handle JSON hidden fields separately
  formElement.querySelectorAll('input[type="hidden"][data-json="true"]').forEach(input => {
    try {
      data[input.name] = JSON.parse(input.value);
    } catch (e) {
      console.error('Failed to parse JSON field:', input.name, e);
      data[input.name] = input.value;
    }
  });

  for (const [key, value] of formData.entries()) {
    // Skip JSON fields already processed
    const input = formElement.querySelector(`[name="${key}"]`);
    if (input?.dataset?.json === 'true') continue;

    setNestedValue(data, key, value);
  }

  // Convert checkbox values
  formElement.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
    setNestedValue(data, checkbox.name, checkbox.checked);
  });

  // Clean up empty optional string values in blocks
  cleanEmptyValues(data);

  return data;
}

/**
 * Remove empty string values from objects (they clutter the YAML)
 * Preserves empty strings if the field is required (has value in original)
 */
function cleanEmptyValues(obj) {
  if (Array.isArray(obj)) {
    obj.forEach(item => cleanEmptyValues(item));
  } else if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (value === '') {
        // Remove empty string values
        delete obj[key];
      } else if (typeof value === 'object') {
        cleanEmptyValues(value);
        // Remove empty objects
        if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
          delete obj[key];
        }
      }
    }
  }
}

/**
 * Set nested value in object using dot notation and array brackets
 */
function setNestedValue(obj, path, value) {
  const keys = path.split(/\.|\[|\]/).filter(Boolean);
  let current = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const nextKey = keys[i + 1];

    if (!isNaN(nextKey)) {
      // Next key is array index
      if (!Array.isArray(current[key])) {
        current[key] = [];
      }
      current = current[key];
    } else {
      // Next key is object property
      if (current[key] === undefined || current[key] === null) {
        current[key] = {};
      }
      current = current[key];
    }
  }

  const lastKey = keys[keys.length - 1];

  // Convert numeric strings to numbers for number fields
  if (value !== '' && !isNaN(value) && !isNaN(parseFloat(value))) {
    // Keep as string if it looks like a string (has leading zeros, etc.)
    if (!/^0\d/.test(value)) {
      const num = parseFloat(value);
      if (Number.isInteger(num)) {
        current[lastKey] = parseInt(value, 10);
      } else {
        current[lastKey] = num;
      }
      return;
    }
  }

  current[lastKey] = value;
}

/**
 * Setup event listeners for dynamic form elements
 */
export function setupFormHandlers(formElement, onBlockChange) {
  // Add block
  formElement.addEventListener('click', (e) => {
    if (e.target.classList.contains('add-block-btn')) {
      const container = e.target.closest('.blocks-container');
      const select = container.querySelector('#add-block-type');
      const blockType = select.value;

      if (!blockType) {
        // Visual feedback instead of silent failure
        select.focus();
        select.classList.add('shake');
        setTimeout(() => select.classList.remove('shake'), 500);
        return;
      }

      const blocksList = container.querySelector('.blocks-list');
      const blockTypes = JSON.parse(blocksList.dataset.blockTypes || '{}');
      const fieldPath = blocksList.dataset.field;
      const index = blocksList.querySelectorAll('.block-item').length;

      // Use createEmptyBlock to populate defaults (prevents schema validation errors)
      const blockSchema = blockTypes[blockType];
      const newBlock = createEmptyBlock(blockType, blockSchema);
      const blockHtml = generateBlockItem(fieldPath, blockTypes, newBlock, index);

      // Add to DOM
      blocksList.insertAdjacentHTML('beforeend', blockHtml);

      // Get the newly added block and expand it
      const newBlockEl = blocksList.lastElementChild;
      newBlockEl.classList.remove('collapsed');
      const icon = newBlockEl.querySelector('.block-expand-icon');
      if (icon) icon.textContent = '▼';

      // Focus first input and scroll into view
      const firstInput = newBlockEl.querySelector('input:not([type="hidden"]), textarea');
      if (firstInput) {
        firstInput.focus();
        firstInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      // Reset select
      select.value = '';

      // Trigger change callback (saves and refreshes preview)
      if (onBlockChange) onBlockChange();
    }
  });

  // Remove block
  formElement.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-block')) {
      const blockItem = e.target.closest('.block-item');
      if (confirm('Delete this block?')) {
        blockItem.remove();
        reindexBlocks(formElement);
        if (onBlockChange) onBlockChange();
      }
    }
  });

  // Toggle block collapse - clicking anywhere on header
  formElement.addEventListener('click', (e) => {
    const header = e.target.closest('.toggle-block-header');
    if (header && !e.target.closest('.block-actions') && !e.target.closest('.block-drag-handle')) {
      const blockItem = header.closest('.block-item');
      blockItem.classList.toggle('collapsed');
      const icon = blockItem.querySelector('.block-expand-icon');
      if (icon) {
        icon.textContent = blockItem.classList.contains('collapsed') ? '▶' : '▼';
      }
    }
  });

  // Drag and drop for reordering blocks
  let draggedBlock = null;

  formElement.addEventListener('dragstart', (e) => {
    const blockItem = e.target.closest('.block-item');
    if (blockItem) {
      draggedBlock = blockItem;
      blockItem.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    }
  });

  formElement.addEventListener('dragend', (e) => {
    if (draggedBlock) {
      draggedBlock.classList.remove('dragging');
      draggedBlock = null;
      // Remove all drag-over states
      formElement.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    }
  });

  formElement.addEventListener('dragover', (e) => {
    e.preventDefault();
    const blockItem = e.target.closest('.block-item');
    if (blockItem && blockItem !== draggedBlock) {
      e.dataTransfer.dropEffect = 'move';
      // Add visual indicator
      formElement.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      blockItem.classList.add('drag-over');
    }
  });

  formElement.addEventListener('drop', (e) => {
    e.preventDefault();
    const targetBlock = e.target.closest('.block-item');
    if (targetBlock && draggedBlock && targetBlock !== draggedBlock) {
      const blocksList = targetBlock.closest('.blocks-list');
      const blocks = Array.from(blocksList.querySelectorAll('.block-item'));
      const draggedIndex = blocks.indexOf(draggedBlock);
      const targetIndex = blocks.indexOf(targetBlock);

      if (draggedIndex < targetIndex) {
        targetBlock.parentNode.insertBefore(draggedBlock, targetBlock.nextSibling);
      } else {
        targetBlock.parentNode.insertBefore(draggedBlock, targetBlock);
      }

      reindexBlocks(formElement);
      if (onBlockChange) onBlockChange();
    }
    formElement.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  });

  // Add array item (for non-block arrays)
  formElement.addEventListener('click', (e) => {
    if (e.target.classList.contains('add-array-item')) {
      const arrayField = e.target.closest('.array-field');
      const fieldPath = arrayField.dataset.field;
      const itemSchema = JSON.parse(arrayField.dataset.schema || '{}');
      const index = arrayField.querySelectorAll('.array-item').length;

      const newItem = document.createElement('div');
      newItem.className = 'array-item';
      newItem.dataset.index = index;
      newItem.innerHTML = `
        ${generateArrayItem(fieldPath, itemSchema, null, index)}
        <button type="button" class="btn btn-danger btn-sm remove-array-item">Remove</button>
      `;

      arrayField.insertBefore(newItem, e.target);
      if (onBlockChange) onBlockChange();
    }
  });

  // Remove array item
  formElement.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-array-item')) {
      const item = e.target.closest('.array-item');
      item.remove();
      reindexArrayItems(e.target.closest('.array-field'));
      if (onBlockChange) onBlockChange();
    }
  });
}

/**
 * Reindex blocks after reordering
 */
function reindexBlocks(formElement) {
  const blocksList = formElement.querySelector('.blocks-list');
  if (!blocksList) return;

  const fieldPath = blocksList.dataset.field;
  const blocks = blocksList.querySelectorAll('.block-item');

  blocks.forEach((block, newIndex) => {
    block.dataset.index = newIndex;

    // Update all input names within this block
    block.querySelectorAll('input, textarea, select').forEach(input => {
      const name = input.name;
      // Replace the old index with new index
      const newName = name.replace(/\[\d+\]/, `[${newIndex}]`);
      input.name = newName;

      // Update id as well
      if (input.id) {
        input.id = newName.replace(/\./g, '_').replace(/\[/g, '_').replace(/\]/g, '');
      }
    });

    // Update labels
    block.querySelectorAll('label[for]').forEach(label => {
      const forAttr = label.getAttribute('for');
      const newFor = forAttr.replace(/_\d+_/, `_${newIndex}_`);
      label.setAttribute('for', newFor);
    });
  });
}

/**
 * Reindex array items after removal
 */
function reindexArrayItems(arrayField) {
  const fieldPath = arrayField.dataset.field;
  const items = arrayField.querySelectorAll('.array-item');

  items.forEach((item, newIndex) => {
    item.dataset.index = newIndex;

    item.querySelectorAll('input, textarea, select').forEach(input => {
      const name = input.name;
      const newName = name.replace(/\[\d+\]/, `[${newIndex}]`);
      input.name = newName;

      if (input.id) {
        input.id = newName.replace(/\./g, '_').replace(/\[/g, '_').replace(/\]/g, '');
      }
    });
  });
}

/**
 * Create an empty block of a given type
 */
export function createEmptyBlock(blockType, blockSchema) {
  const block = { type: blockType };

  if (blockSchema?.properties) {
    for (const [key, schema] of Object.entries(blockSchema.properties)) {
      if (key === 'type') continue;

      if (schema.default !== undefined) {
        block[key] = schema.default;
      } else if (schema.type === 'array') {
        block[key] = [];
      } else if (schema.type === 'object') {
        block[key] = {};
      } else if (schema.type === 'number') {
        block[key] = schema.default ?? 0;
      } else if (schema.type === 'boolean') {
        block[key] = schema.default ?? false;
      } else {
        block[key] = '';
      }
    }
  }

  return block;
}
