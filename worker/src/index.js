// Fox Road petition Worker.
//
// Receives a POST from the petition form, validates, dedupes by SHA-256 of
// the email, and commits a privacy-redacted markdown file to the repo via
// the GitHub Contents API. The plain email is NEVER persisted — only its
// hash. Names and stories are stored only with explicit opt-in flags.
//
// Required environment:
//   GITHUB_TOKEN     (secret) fine-grained PAT scoped to one repo,
//                             Contents: read+write
//   GITHUB_OWNER     (var)    e.g. "websmiths"
//   GITHUB_REPO      (var)    e.g. "potholes"
//   GITHUB_BRANCH    (var)    default "main"
//   ALLOWED_ORIGINS  (var)    space- or comma-separated list of origins

const VALID_ROLES = ["resident", "local", "commuter", "business", "other"];

// Timestamps are recorded in the road's local timezone so that filename
// date prefixes and stats groupings reflect lived-experience dates rather
// than UTC. Australia/Sydney observes daylight saving (+10 / +11).
const TZ = "Australia/Sydney";

function toLocalIso(date = new Date()) {
  const opts = { timeZone: TZ };
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      ...opts,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const tzn = new Intl.DateTimeFormat("en-US", {
    ...opts,
    timeZoneName: "longOffset",
  })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName").value;
  const offset = tzn.replace(/^GMT/, "") || "+00:00";
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${offset}`;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = parseOrigins(env.ALLOWED_ORIGINS);
    const originOk = !origin || allowed.includes(origin) || allowed.includes("*");

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: originOk ? 204 : 403,
        headers: originOk ? corsHeaders(origin) : {},
      });
    }
    if (request.method !== "POST") {
      return text("method not allowed", 405, origin, originOk);
    }
    if (!originOk) {
      return text("origin not allowed", 403, origin, false);
    }

    let data;
    try {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        data = await request.json();
      } else {
        const fd = await request.formData();
        data = Object.fromEntries(fd.entries());
      }
    } catch {
      return json({ error: "bad request" }, 400, origin);
    }

    // Honeypot — silently succeed so bots don't learn we filtered.
    if (data._gotcha) {
      return json({ ok: true, dropped: true }, 200, origin);
    }

    const name = String(data.name || "").trim();
    const email = String(data.email || "").trim().toLowerCase();
    const consent = isTruthy(data.consent);
    if (!name) return json({ error: "name required" }, 400, origin);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ error: "valid email required" }, 400, origin);
    }
    if (!consent) {
      return json({ error: "consent required" }, 400, origin);
    }

    const hash = await sha256Hex(email);
    const id = hash.slice(0, 8);

    // Soft dedup against last-published hash list. The list is regenerated
    // by the GitHub Action after each commit, so very fast repeats may slip
    // through; the build script's --stats step also dedupes by hash so the
    // final state is always correct.
    try {
      const known = await fetchExistingHashes(env);
      if (known.includes(hash)) {
        return json({ ok: true, duplicate: true, id }, 200, origin);
      }
    } catch (err) {
      // Failing the hash fetch isn't fatal — the build's --stats step will
      // still dedupe at file generation time.
      console.warn("hash fetch failed:", err.message);
    }

    const role = normalizeRole(data.role);
    const suburb = String(data.location || data.suburb || "").trim();
    const story = String(data.story || "").trim();
    const displayPublicly = isTruthy(data.displayPublicly);
    const storyPublic = isTruthy(data.storyPublic);
    const submittedAt = toLocalIso();
    const filename = `submissions/${submittedAt.slice(0, 10)}-${id}.md`;
    const displayName = displayPublicly
      ? formatPublicName(name)
      : "Anonymous Fox Road resident";

    const body = serializeFrontmatter(
      {
        id,
        submittedAt,
        role,
        suburb,
        emailHash: hash,
        displayName,
        displayPublicly,
        storyPublic,
      },
      storyPublic && story ? `\n${story}\n` : ""
    );

    try {
      await commitToGithub(env, filename, body, `Add petition signature ${id}`);
    } catch (err) {
      return json(
        { error: "commit failed", detail: String(err.message || err).slice(0, 200) },
        502,
        origin
      );
    }

    return json({ ok: true, id }, 200, origin);
  },
};

// ---------- helpers ----------

function parseOrigins(s) {
  return String(s || "")
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(obj, status, origin, ok = true) {
  const headers = { "Content-Type": "application/json" };
  if (ok && origin) Object.assign(headers, corsHeaders(origin));
  return new Response(JSON.stringify(obj), { status, headers });
}

function text(s, status, origin, ok) {
  const headers = { "Content-Type": "text/plain" };
  if (ok && origin) Object.assign(headers, corsHeaders(origin));
  return new Response(s, { status, headers });
}

async function sha256Hex(s) {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isTruthy(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  return ["true", "yes", "y", "on", "1", "checked"].includes(
    String(v).toLowerCase()
  );
}

function normalizeRole(v) {
  const s = String(v || "").trim().toLowerCase();
  return VALID_ROLES.includes(s) ? s : "other";
}

function formatPublicName(raw) {
  const parts = String(raw || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "Anonymous Fox Road resident";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

function serializeFrontmatter(data, body = "") {
  const lines = ["---"];
  for (const [k, v] of Object.entries(data)) {
    if (v == null || v === "") continue;
    if (typeof v === "boolean") lines.push(`${k}: ${v}`);
    else if (typeof v === "string" && /[:#"\n]/.test(v))
      lines.push(`${k}: ${JSON.stringify(v)}`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push("---", "");
  return lines.join("\n") + (body ? body.replace(/\s+$/, "") + "\n" : "");
}

async function fetchExistingHashes(env) {
  const url = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH || "main"}/signatures-hashes.json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "fox-road-petition-worker" },
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`hashes fetch ${res.status}`);
  const data = await res.json();
  return Array.isArray(data && data.hashes) ? data.hashes : [];
}

async function commitToGithub(env, path, content, message) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "fox-road-petition-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      content: base64Utf8(content),
      branch: env.GITHUB_BRANCH || "main",
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`github ${res.status}: ${t.slice(0, 240)}`);
  }
  return res.json();
}

function base64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
