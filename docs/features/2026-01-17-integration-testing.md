# Integration Testing: Third-Party Astro 5 Sites

**Date:** 2026-01-17

## Goal

Validate that AstroAdmin works correctly with third-party Astro 5 sites, ensuring site-agnostic compatibility.

## Test Site

### louisescher/.dev (Astro 5.16.6)

**Repository:** https://github.com/louisescher/.dev (`packages/dotdev`)

**Collections (9 total):**

| Collection | Loader | Schema Highlights |
|------------|--------|-------------------|
| posts | glob (MD/MDX) | images, dates, `reference("tags")` |
| projects | glob (MD/MDX) | images, nested `info[]` array with icons |
| reviews | glob (MD/MDX) | multiple images, rating number |
| other | glob (MD/MDX) | minimal schema |
| tags | file (JSON) | simple id-only |
| quickInfo | file (JSON) | discriminated union icons |
| socials | file (JSON) | icons, URL validation |
| workExperience | file (JSON) | standard text fields |
| music | file (JSON) | images, `z.record()` metadata |

**Why this site is ideal:**
- Uses both `glob` and `file` loaders
- Has `reference()` relationships (posts → tags)
- Discriminated union types (lucide vs simple-icons)
- Nested object arrays with complex schemas
- `z.record()` dynamic key-value schema
- Multiple image fields per collection

## Issues Found & Fixed

### 1. Astro 5 Config Location

**Problem:** Astro 5 moved the content config from `src/content/config.ts` to `src/content.config.ts`.

**Fix:** Added Astro 5 config paths to `schema-parser.js`:
```javascript
const possiblePaths = [
  // Astro 5+ locations (check first)
  path.join(projectRoot, 'src/content.config.ts'),
  path.join(projectRoot, 'src/content.config.mts'),
  // Astro 4.x legacy locations
  path.join(projectRoot, 'src/content/config.ts'),
  // ...
];
```

### 2. Missing astro/loaders Module

**Problem:** Astro 5 uses `import { file, glob } from "astro/loaders"` which esbuild couldn't resolve.

**Fix:** Added `ASTRO_LOADERS_SHIM` virtual module:
```javascript
const ASTRO_LOADERS_SHIM = `
export const file = (filePath) => ({
  _type: 'file',
  _filePath: filePath,
});

export const glob = (options) => ({
  _type: 'glob',
  _base: options.base,
  _pattern: options.pattern,
});
`;
```

### 3. Schema Functions Not Evaluated

**Problem:** Schemas like `schema: ({ image }) => z.object({...})` were not being called.

**Fix:** Detect function schemas and call with mock helpers:
```javascript
const imageHelper = () => z.string().describe('Image path');
if (typeof zodSchema === 'function') {
  zodSchema = zodSchema({ image: imageHelper });
}
```

### 4. File-Based Collections Not Detected

**Problem:** `getCollectionNames()` only scanned directories, missing file-based collections.

**Fix:** Changed to get collection names from parsed schemas (source of truth) with directory fallback.

### 5. File Collection CRUD Operations

**Problem:** Content API only handled directory-based (glob) collections.

**Fix:** Added complete file collection support in `content.js`:
- `readFileCollectionEntry()` - Read entry from JSON array
- `writeFileCollectionEntry()` - Update/create entry in JSON array
- `deleteFileCollectionEntry()` - Remove entry from JSON array
- `fileCollectionEntryExists()` - Check if entry exists

### 6. Preview Routes Not Detected

**Problem:** No automatic mapping from collections to preview URLs.

**Fix:** Created `server/utils/routes.js` to auto-detect routes:
- Scans `src/pages/` for dynamic routes like `[slug].astro`
- Maps param names to collections (e.g., `[post].astro` → posts collection)
- Supports both singular and plural matching
- User config overrides auto-detected routes

Auto-detected routes for test site:
```
posts -> /blog/{slug}
projects -> /projects/{slug}
reviews -> /review/{slug}
```

### 7. Array Item UI Improvements

**Problem:** Simple array items had inconsistent styling with complex arrays.

**Fix:** Updated simple arrays to use card-style layout matching Testimonials:
- Drag handle on the left
- Content in the middle
- Trash icon on the right (instead of x button)

## Files Changed

### Server
- `server/utils/schema-parser.js` - Astro 5 config paths, loaders shim, schema function evaluation
- `server/utils/collections.js` - Schema-based collection detection, file collection entries
- `server/utils/content.js` - File-based collection CRUD operations
- `server/utils/routes.js` - **NEW** - Route auto-detection from pages directory
- `server/api/collections.js` - Added previewRoute to collection metadata

### UI
- `ui/dashboard.js` - Use previewRoute for preview URLs, block selector for component preview
- `ui/form-generator.js` - Card-style array items with drag handles and trash icons
- `ui/input.css` - Updated array item styles to match card layout
- `ui/styles.css` - Rebuilt from input.css

## Testing Commands

```bash
# Clone test site (in integration/ which is gitignored)
cd integration
gh repo clone louisescher/.dev dotdev-site
cd dotdev-site/packages/dotdev
npm install

# Create local database (site uses Turso)
echo 'TURSO_DATABASE_URL=file:local.db' > .env
# Seed with: npx drizzle-kit push

# Run AstroAdmin
cd /path/to/astroadmin
npm run dev

# Run test site (separate terminal)
cd integration/dotdev-site/packages/dotdev
npm run dev
```

## Verification Checklist

- [x] Admin dashboard loads without errors
- [x] All 9 collections appear in sidebar
- [x] Glob collections (posts, projects, reviews, other) load entries
- [x] File collections (tags, quickInfo, socials, workExperience, music) load entries
- [x] Forms render appropriate inputs for each field type
- [x] Preview routes auto-detected for posts, projects, reviews
- [x] Array items have consistent card-style UI

## Future Improvements

1. **Discriminated unions** - quickInfo uses `z.union()` for icons, needs better UI
2. **`z.record()` fields** - music.metadata allows arbitrary keys, needs key-value editor
3. **Reference field resolution** - Show actual tag names instead of IDs in posts editor
4. **Additional test sites** - Test with astro-paper, astro-theme-cactus for edge cases
