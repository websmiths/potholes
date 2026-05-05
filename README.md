# Fix Fox Road

A community-run static site documenting the deteriorating state of Fox Road,
Rosebank (NSW), and collecting signatures for a repair petition.

The site is intentionally simple: plain HTML / CSS / JS, no build framework,
no runtime dependencies. Deploys as a static site on Cloudflare Pages or
GitHub Pages.

## Layout

```
artwork/                  Source photos & videos (gitignored — too heavy)
media/                    Web-optimised JPG/MP4 + thumbs/posters (committed)
submissions/              One markdown file per petition signature (privacy-redacted)
worker/                   Cloudflare Worker that accepts form POSTs and commits submissions
.github/workflows/        Stats-regeneration action
build.mjs                 Multi-mode CLI: media build, --stats, --add, --import
petition.mjs              Petition logic: hashing, dedup, stats, CSV import
manifest.json             Generated media catalogue
stats.json                Generated petition aggregates (counts, public lists)
signatures-hashes.json    Generated email-hash list for client-side dedup hint
config.json               Site copy: location, council, petition asks, contact
index.html                Page structure
styles.css                Visual design
app.js                    Gallery, lightbox, petition form, stats display
```

## Required tools

- `magick` (ImageMagick 7) — for HEIC → JPG and EXIF extraction
- `ffmpeg` / `ffprobe` — for MOV → MP4 and metadata
- `node` (any recent version)

On macOS:

```bash
brew install imagemagick ffmpeg node
```

## Adding or removing media

The site is fully driven by `manifest.json`. `index.html` is just a shell —
photos and videos are loaded dynamically. You never need to edit HTML to add
or remove items.

**To add:** drop new `.HEIC` / `.MOV` / `.JPG` / `.MP4` files into `artwork/`,
then `node build.mjs`.

**To remove:** delete the source from `artwork/` (or add it to the `EXCLUDE`
set in `build.mjs`), then `node build.mjs`. The build prunes any orphaned
files in `media/` whose source no longer exists.

The build is idempotent — it only re-encodes files whose source is newer
than the output. Photos become `1800px` JPGs + `800px` square thumbs.
Videos become `720p` H.264 MP4s at 25 fps + a `1280px` poster JPG.

After running, commit the changes in `media/` and `manifest.json`.

The site groups items into **incidents** by capture date, so as new batches
are added over time they appear as separate dated sections — building up a
record of the road's decline and the grading-and-undermining cycle.

## Petition: how it works

The petition is a **files-only** system. Every signature is a single
markdown file in `submissions/`. There is no database, no third-party form
service, no API to maintain. The site reads aggregated stats from
`stats.json` (a derived artefact) and displays counts + opt-in public lists.

### Privacy contract

- A signer's plain email **never appears anywhere in this repo**. Only its
  SHA-256 hash is stored, used for deduplication and a soft client-side
  "you've already signed" hint.
- Names appear publicly only if the signer ticked **"Show my name on the
  public list"** at signing time. Even then, only first name and last
  initial are published (e.g. "J. Smith").
- Story bodies appear publicly only if the signer ticked **"Share my story
  publicly"**.
- Suburbs and roles are aggregated for stats but otherwise non-identifying.
- Withdrawing a signature: delete the matching `.md` file (or any whose
  `emailHash` matches the signer) and re-run `node build.mjs --stats`.

### Two ways to receive signatures

**Automated** (default once Worker is deployed):
the form POSTs to a Cloudflare Worker (`worker/`) which commits a
redacted markdown file to `submissions/`. A GitHub Action
(`.github/workflows/petition-stats.yml`) regenerates `stats.json` and
`signatures-hashes.json` and commits them. Cloudflare Pages
auto-redeploys. Total elapsed time signature → live count: ~30–60
seconds. **No manual processing.** See `worker/README.md` for one-time
deploy steps.

**Files-only fallback** (when `config.json → petition.endpoint` is
empty): the form opens a `mailto:` link pre-filled with the signer's
answers. They email it to you. You then:

```bash
node build.mjs --add
# answer 7 prompts (~10 seconds), pasting in name/email/role/etc.
git add submissions/ stats.json signatures-hashes.json
git commit -m "Add signature"
git push
```

The signer's plain email is never stored in either flow — only its hash,
plus their consent-gated display name and consent-gated story.

### Bulk import (optional)

If you ever wire the form up to a service like
[Formspree](https://formspree.io/) by setting
`config.json → petition.endpoint`, you can bulk-import a CSV export:

```bash
node build.mjs --import ~/Downloads/formspree-export.csv
```

The importer skips rows that:

- have no consent ticked,
- have a missing or invalid email,
- duplicate an email already in `submissions/`,
- have the honeypot field filled (likely bot).

It also preserves the per-row consent flags for `displayPublicly` and
`storyPublic`.

### Just regenerate stats

If you edit submissions by hand (e.g. deleting one for withdrawal),
regenerate the derived JSON files:

```bash
node build.mjs --stats
```

## Configuration

Edit `config.json` to set:

- `siteName`, `tagline` — top-of-page copy
- `location.suburb`, `location.council` — wording in the blurb
- `contact.email` — where mailto signatures are sent
- `petition.target` — name of the body the petition addresses
- `petition.headline` — headline above the asks
- `petition.asks[]` — the numbered demands
- `petition.endpoint` — leave blank for files-only/mailto flow; set to a
  Formspree URL to enable inline form submission

## Local preview

The site uses `fetch()` to load `manifest.json`, `config.json`, and
`stats.json`, so it requires an HTTP server (not `file://`):

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deployment

### Cloudflare Pages (recommended)

If the repository is connected to Cloudflare Pages:

- **Build command:** *leave blank* (the site is pre-built and committed).
- **Build output directory:** *leave blank* or `/`.
- **Root directory (advanced):** *leave blank*.
- **Production branch:** `main`.

Every push to `main` auto-deploys. The default URL is something like
`https://potholes.pages.dev`. Custom domains can be attached in the
Cloudflare dashboard under your Pages project's *Custom domains* tab.

### GitHub Pages (alternative)

Settings → Pages → Source: `main` / `(root)` → Save. URL will be
`https://websmiths.github.io/potholes/`.

(Pick *one* of these — running both at once just causes confusion.)

### Custom domain

Either platform supports custom domains. For Cloudflare Pages, add the
domain in the dashboard and Cloudflare handles DNS automatically if the
zone is on Cloudflare. For GitHub Pages, add a `CNAME` file at the repo
root containing the bare domain and configure DNS at your registrar.

## License

Photos and videos: © their respective contributors, all rights reserved by
default. Code (build script, HTML/CSS/JS): MIT (see `LICENSE`).
