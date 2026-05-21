# C-STUDIOS — Astro

Astro rebuild of the C-STUDIOS site, optimized for speed and simplicity.

## Quick start

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # production build → dist/
npm run preview  # preview the production build locally
```

## Project structure

```
c-studios-astro/
├── astro.config.mjs       # Astro config
├── package.json
├── public/
│   ├── images/
│   │   └── references/    # ← put your library image files here
│   └── favicon.ico
├── src/
│   ├── components/
│   │   └── Header.astro   # Global custom menu
│   ├── data/
│   │   └── references.json # Library reference data (117 entries already)
│   ├── layouts/
│   │   └── Layout.astro   # Base HTML wrapper
│   ├── pages/
│   │   ├── index.astro    # Homepage (scaffold — fill in your content)
│   │   └── library.astro  # Full interactive library page
│   └── styles/
│       └── global.css
└── scripts/                          # Build-time + one-off helpers
    ├── csv-to-json.mjs                # Library CSVs → JSON (data sync)
    ├── csv-to-projects.mjs            # projects.csv → projects.json (npm run sync-projects)
    ├── json-to-csv.mjs                # Reverse direction, for editing in a spreadsheet
    ├── compute-colors.mjs             # Dominant RGB per reference image (npm run compute-colors)
    ├── generate-variants.mjs          # Responsive image variants (npm run generate-variants)
    ├── generate-library-thumbs.mjs    # Library thumbnails
    ├── import-library.mjs             # One-off: WordPress library import
    ├── import-library-text.mjs        # One-off: text-category import
    └── import-wp-images.mjs           # One-off: WordPress images import
```

**Active scripts** (wired into npm): `csv-to-json`, `csv-to-projects`,
`compute-colors`, `generate-variants`. **One-off imports** (kept for
reference; not part of the build): `import-library*`, `import-wp-images`,
`generate-library-thumbs`.

## Setup steps after `npm install`

### 1. Add your library images

Copy your image files into `public/images/references/`. The image matcher
expects filenames matching the `filename` column in your CSV (extension
`.jpg`, `.jpeg`, `.png`, or `.webp`).

### 2. Compute reference colors

```bash
npm run compute-colors
```

This reads every image in `public/images/references/`, finds the dominant
RGB color via the `sharp` library, and writes results back into
`src/data/references.json`. Run this once after adding images, or
whenever you add new ones.

### 3. (Optional) Import additional CSVs

If you have separate CSVs for Image, Sound, and Film categories:

```bash
CATEGORY=Image npm run csv-to-json -- ./path/to/Image-CSV.csv
CATEGORY=Sound npm run csv-to-json -- ./path/to/Sound-CSV.csv
CATEGORY=Film  npm run csv-to-json -- ./path/to/Film-CSV.csv
```

Each call appends new references to `src/data/references.json`,
skipping duplicates by title.

### 4. Fill in the homepage sections

Open `src/pages/index.astro`. Each section (Services, Clients, Projects, Info)
has a placeholder paragraph. Replace with the actual content from your
existing site. You can:
- Edit directly in the Astro file (HTML)
- Import images from `public/` (use `<img src="/path/to/img.jpg" />`)
- Style with the existing `.home-section` class or add your own

### 5. Deploy

Recommended: **Cloudflare Pages** (free, fast, automatic image optimization).

```bash
# Install Wrangler CLI (one-time)
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Build + deploy
npm run build
wrangler pages deploy dist --project-name=c-studios
```

After first deploy, in the Cloudflare dashboard:
- Add your domain (`c-studios.co.uk`) to the project
- Point your DNS records to Cloudflare Pages

Alternative: **Netlify** — drag and drop `dist/` into Netlify's dashboard,
or connect your GitHub repo for auto-deploy on push.

## Editing references later

Two options:

**Option A — Edit JSON directly**

Open `src/data/references.json`, add/edit/delete entries, rebuild and redeploy.

**Option B — Add Decap CMS (visual admin)**

Decap CMS gives you a visual editor at `yoursite.com/admin` that commits
changes back to your Git repo. Setup is in the Decap docs:
https://decapcms.org/docs/astro/

## Key differences from WordPress version

- **No WordPress, no Elementor, no plugins** — everything lives in this repo
- **References data is in `src/data/references.json`** — not a database
- **Images are static files** in `public/images/references/` — served via CDN
- **Page load is ~10× faster** — no PHP, no database queries, just HTML+CSS+JS
- **Library colors are pre-computed at build time** via sharp (faster than runtime)

## Customizing the menu

The menu is a single component at `src/components/Header.astro`. To add/remove
links or change the section IDs they scroll to, edit the `<a>` tags there.

## Notes on the library page

The library page (`src/pages/library.astro`) is a single big component that:
- Loads references from `src/data/references.json` at build time
- Inlines them as a JS constant `REFS`
- Renders the interactive cylinder via canvas (1100+ lines of game-loop code)
- All interaction state lives in JS (no server-side rendering needed)

If you want to update the cylinder rendering logic later, edit the `<script>`
block at the bottom of `library.astro`. The structure is preserved from the
WordPress version, so changes should feel familiar.

## Known refactor opportunities

These are tracked but not yet done:

- **Split the monolith pages.** `src/pages/index.astro` (~1800 lines) and
  `src/pages/library.astro` (~1500 lines) bundle HTML, CSS, and a long
  inline `<script is:inline>` block. The scripts can be moved to
  `src/scripts/*.ts` once you can verify in a browser; library.astro's
  script needs a thin shim because it depends on `define:vars={{ referencesJSON }}`.
- **Squash the "Mobile cylinder spacing fix" commits.** Last five commits
  share that message; consider squashing into one with a descriptive message
  before pushing further.
