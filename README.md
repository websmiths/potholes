# Fix Fox Road

A community-run static site documenting the deteriorating state of Fox Road,
Rosebank (NSW), and collecting signatures for a repair petition.

The site is intentionally simple: plain HTML / CSS / JS, no build framework,
no runtime dependencies. Hosted on GitHub Pages.

## Layout

```
artwork/         Source photos & videos (gitignored — too heavy)
media/           Web-optimised JPG/MP4 + thumbs/posters (committed)
build.mjs        Reads artwork/, writes media/ and manifest.json
manifest.json    Generated catalogue (date, GPS, dimensions, paths)
config.json      Site copy: location, council, petition asks, contact
index.html       Page structure
styles.css       Visual design
app.js           Gallery, lightbox, petition submit
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

The site groups items into "incidents" by capture date, so as you add new
batches over time they appear as separate dated sections — building up a
record of the road's decline and any patch-and-fail cycles.

## Required tools

- `magick` (ImageMagick 7) — for HEIC → JPG and EXIF extraction
- `ffmpeg` / `ffprobe` — for MOV → MP4 and metadata
- `node` (any recent version)

On macOS:

```bash
brew install imagemagick ffmpeg
```

## Configuring the petition

The petition form posts to whatever endpoint you set in `config.json`:

```json
"petition": {
  "endpoint": "https://formspree.io/f/XXXXXXX",
  ...
}
```

Recommended: a free [Formspree](https://formspree.io/) form. Sign up, create a
form, paste the endpoint URL into `config.json`. Submissions are emailed to
you. No backend required.

If `endpoint` is empty, the form falls back to `mailto:` using
`contact.email` so signatures are not silently lost.

## Local preview

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

Or any other static file server.

## Deployment (GitHub Pages)

1. Push to `main` on https://github.com/websmiths/potholes
2. Repo Settings → Pages → Source: `main` / `(root)` → Save
3. Site will publish at `https://websmiths.github.io/potholes/`

If you'd like a custom domain (e.g. `fixfoxroad.org`), add a `CNAME` file with
the domain in it and configure DNS to point at GitHub Pages.

## License

Photos and videos: © their respective contributors, all rights reserved by
default. Code (build script, HTML/CSS/JS): MIT (see `LICENSE`).
