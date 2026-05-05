# Fox Road petition Worker

A tiny Cloudflare Worker that turns petition form submissions into commits
in this repo. The site form POSTs to it; the Worker writes a redacted
markdown file to `submissions/`; a GitHub Action regenerates `stats.json`;
Cloudflare Pages auto-redeploys.

## What it does on each POST

1. Reads the form fields (name, email, role, suburb, story, two opt-in
   booleans, consent).
2. Rejects on missing required fields, invalid email, missing consent, or
   if the honeypot is filled.
3. SHA-256 hashes the lowercased+trimmed email.
4. Fetches `signatures-hashes.json` from the repo. If the new hash is
   already there, returns `{ ok: true, duplicate: true }` and does NOT
   commit a duplicate file.
5. Otherwise commits `submissions/YYYY-MM-DD-<id>.md` via the GitHub
   Contents API. The file contains:
   - the email **hash** only (never the plain email)
   - the role and suburb (used for stats)
   - `displayName`: the redacted form (`"J. Smith"`) only if the signer
     ticked the public-name checkbox; otherwise
     `"Anonymous Fox Road resident"`
   - the story body **only if** the signer ticked the share-story
     checkbox

## One-time deploy

You'll need a free Cloudflare account (you already have one — same
account that runs Pages) and a fine-grained GitHub Personal Access Token.

### 1. Create the GitHub token

Go to **https://github.com/settings/personal-access-tokens/new** and create
a *fine-grained* PAT with:

- **Resource owner:** `websmiths`
- **Repository access:** *Only select repositories* → `websmiths/potholes`
- **Repository permissions:**
  - **Contents:** *Read and write*
  - **Metadata:** *Read-only* (auto-included)
- **Expiration:** 1 year is fine; rotate it then.

Copy the token. You won't see it again.

### 2. Install Wrangler and log in

```bash
cd worker
npm install
npx wrangler login
```

This opens a browser tab; authorise Wrangler against the same Cloudflare
account that hosts the Pages project.

### 3. Set the GitHub token as a Worker secret

```bash
npx wrangler secret put GITHUB_TOKEN
# paste the token from step 1 when prompted, then Enter
```

### 4. Deploy the Worker

```bash
npx wrangler deploy
```

Wrangler will print a URL like:

```
https://fox-road-petition.<your-subdomain>.workers.dev
```

Copy that URL.

### 5. Wire the site to the Worker

Edit `../config.json` at the repo root:

```json
"petition": {
  "endpoint": "https://fox-road-petition.<your-subdomain>.workers.dev",
  ...
}
```

Then commit and push:

```bash
cd ..
git add config.json
git commit -m "Wire petition form to Cloudflare Worker"
git push
```

Cloudflare Pages auto-redeploys within ~60 seconds. The form will now
submit inline (no more `mailto:` fallback).

## Tailing logs

```bash
cd worker
npx wrangler tail
```

Live-streams `console.log` and any errors from your Worker. Useful when
debugging form submissions.

## Updating allowed origins

If you add a custom domain (e.g. `fixfoxroad.org`), edit
`worker/wrangler.toml`:

```toml
ALLOWED_ORIGINS = "https://potholes.pages.dev https://fixfoxroad.org"
```

Then `npx wrangler deploy` again. Origins not on the list will get a 403.

## Rotating the GitHub token

```bash
npx wrangler secret put GITHUB_TOKEN
# paste the new token, old one is replaced atomically
```

No re-deploy needed.

## Costs

Cloudflare Workers free tier: 100,000 requests/day. A petition POST is
~2 requests including the preflight. Even a viral run won't come close to
the cap. GitHub Contents API: 5,000 requests/hour against an authenticated
PAT — orders of magnitude beyond what's needed here.
