// Petition signature handling: reading markdown submissions, importing from
// Formspree CSV exports, and computing aggregated stats.
//
// Privacy contract:
//   - Plain emails NEVER appear in any committed file.
//   - SHA-256 hash of normalized email is the only persisted identifier.
//   - Names appear publicly only if signer ticked "displayPublicly".
//   - Story bodies appear publicly only if signer ticked "storyPublic".

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const VALID_ROLES = new Set(["resident", "local", "commuter", "business", "other"]);
const PUBLIC_STORIES_LIMIT = 12;
const PUBLIC_NAMES_LIMIT = 200;

// ---------- email hashing ----------

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function hashEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  return createHash("sha256").update(norm).digest("hex");
}

// Short id derived from hash — used for filenames and public IDs.
export function shortId(hash) {
  return hash.slice(0, 8);
}

// ---------- frontmatter ----------

// Tiny YAML-flavoured frontmatter parser. We control the writer, so we only
// need to handle the simple key: value form we produce ourselves.
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: content };
  const data = {};
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value === "true") value = true;
    else if (value === "false") value = false;
    data[key] = value;
  }
  return { data, body: m[2] || "" };
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

// ---------- CSV parsing (RFC-4180-ish) ----------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;
  const t = text.replace(/^﻿/, ""); // strip BOM
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQuotes) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      cur += c;
    }
  }
  if (cur !== "" || row.length) {
    row.push(cur);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => {
      o[h] = (r[i] ?? "").trim();
    });
    return o;
  });
}

// Case-insensitive header lookup tolerant of Formspree's "natural" column names.
function pickField(row, ...candidates) {
  const keys = Object.keys(row);
  for (const cand of candidates) {
    const norm = cand.toLowerCase().replace(/[^a-z0-9]/g, "");
    const match = keys.find(
      (k) => k.toLowerCase().replace(/[^a-z0-9]/g, "") === norm
    );
    if (match && row[match] !== "") return row[match];
  }
  return "";
}

function asBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v || "")
    .trim()
    .toLowerCase();
  return ["true", "yes", "y", "1", "on", "checked"].includes(s);
}

function normalizeRole(v) {
  const s = String(v || "")
    .trim()
    .toLowerCase();
  if (VALID_ROLES.has(s)) return s;
  if (/resident.*fox/i.test(v)) return "resident";
  if (/local|nearby/i.test(v)) return "local";
  if (/commute|road user/i.test(v)) return "commuter";
  if (/business/i.test(v)) return "business";
  return "other";
}

// ---------- submission I/O ----------

export function loadSubmissions(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => {
      const { data, body } = parseFrontmatter(
        readFileSync(join(dir, f), "utf8")
      );
      return { ...data, body: body.trim(), filename: f };
    })
    .filter((s) => s.emailHash);
}

export function existingHashSet(submissions) {
  return new Set(submissions.map((s) => s.emailHash));
}

function submissionToFile(sub) {
  const data = {
    id: sub.id,
    submittedAt: sub.submittedAt,
    role: sub.role,
    suburb: sub.suburb || "",
    emailHash: sub.emailHash,
    displayName: sub.displayName,
    displayPublicly: sub.displayPublicly,
    storyPublic: sub.storyPublic,
  };
  const body = sub.storyPublic && sub.story ? `\n${sub.story}\n` : "";
  return serializeFrontmatter(data, body);
}

function dateForFilename(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

// ---------- import ----------

export function runImport(csvPath, submissionsDir) {
  if (!existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`);
  }
  mkdirSync(submissionsDir, { recursive: true });
  const text = readFileSync(csvPath, "utf8");
  const rows = parseCsv(text);
  const existing = loadSubmissions(submissionsDir);
  const existingHashes = existingHashSet(existing);

  let added = 0;
  let skippedDup = 0;
  let skippedInvalid = 0;
  let skippedNoConsent = 0;

  for (const row of rows) {
    const email = pickField(row, "email", "Email", "email_address");
    const name = pickField(row, "name", "fullname", "full name");
    const consent = asBool(
      pickField(row, "consent", "I consent", "agree", "agreement")
    );
    if (asBool(pickField(row, "_gotcha", "_honeypot"))) {
      skippedInvalid++;
      continue;
    }
    if (!email || !name) {
      skippedInvalid++;
      continue;
    }
    if (!consent) {
      skippedNoConsent++;
      continue;
    }
    const hash = hashEmail(email);
    if (existingHashes.has(hash)) {
      skippedDup++;
      continue;
    }
    existingHashes.add(hash);

    const role = normalizeRole(pickField(row, "role", "I am a", "iAmA"));
    const suburb = pickField(row, "location", "suburb", "postcode");
    const story = pickField(row, "story", "your story", "comment");
    const submittedAt =
      pickField(row, "Submitted At", "submittedAt", "created", "timestamp") ||
      new Date().toISOString();
    const displayPublicly = asBool(
      pickField(
        row,
        "displayPublicly",
        "display publicly",
        "show my name",
        "public name",
        "show name"
      )
    );
    const storyPublic = asBool(
      pickField(
        row,
        "storyPublic",
        "share story publicly",
        "share my story",
        "public story"
      )
    );
    const id = shortId(hash);
    const displayName = displayPublicly
      ? formatPublicName(name)
      : "Anonymous Fox Road resident";

    const sub = {
      id,
      submittedAt,
      role,
      suburb,
      emailHash: hash,
      displayName,
      displayPublicly,
      storyPublic,
      story,
    };
    const filename = `${dateForFilename(submittedAt)}-${id}.md`;
    writeFileSync(join(submissionsDir, filename), submissionToFile(sub));
    added++;
    console.log("import:", filename);
  }

  console.log(
    `imported ${added} new (dup ${skippedDup}, no-consent ${skippedNoConsent}, invalid ${skippedInvalid})`
  );
  return { added, skippedDup, skippedNoConsent, skippedInvalid };
}

// ---------- interactive add ----------

export async function runAdd(submissionsDir) {
  mkdirSync(submissionsDir, { recursive: true });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def = "") =>
    new Promise((res) =>
      rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) =>
        res((a ?? "").trim() || def)
      )
    );

  console.log("\nAdd a petition signature (Ctrl-C to cancel)\n");
  const name = await ask("Full name");
  const email = await ask("Email");
  if (!name || !email) {
    console.error("name and email are required");
    rl.close();
    process.exit(1);
  }
  const hash = hashEmail(email);
  const existing = loadSubmissions(submissionsDir);
  if (existingHashSet(existing).has(hash)) {
    console.error(`already signed: a submission exists for that email (${shortId(hash)})`);
    rl.close();
    process.exit(2);
  }

  const roleRaw = await ask("Role (resident/local/commuter/business/other)", "resident");
  const role = normalizeRole(roleRaw);
  const suburb = await ask("Suburb / postcode", "");
  const story = await ask("Story (one line, optional)", "");
  const consent = await ask("They consented to use their info for the petition? (y/N)", "n");
  if (!asBool(consent)) {
    console.error("aborting: explicit consent required");
    rl.close();
    process.exit(3);
  }
  const displayPublicly = asBool(
    await ask("Display their name publicly (J. Smith)? (y/N)", "n")
  );
  const storyPublic = story
    ? asBool(await ask("Share their story publicly? (y/N)", "n"))
    : false;
  rl.close();

  const id = shortId(hash);
  const submittedAt = new Date().toISOString();
  const sub = {
    id,
    submittedAt,
    role,
    suburb,
    emailHash: hash,
    displayName: displayPublicly
      ? formatPublicName(name)
      : "Anonymous Fox Road resident",
    displayPublicly,
    storyPublic,
    story,
  };
  const filename = `${dateForFilename(submittedAt)}-${id}.md`;
  writeFileSync(join(submissionsDir, filename), submissionToFile(sub));
  console.log(`wrote submissions/${filename}`);
  return { added: 1 };
}

// "Julian Smith" -> "Julian S." (last-initial form). Honours the consent we
// have to display a name; we still don't publish full surnames.
function formatPublicName(raw) {
  const parts = String(raw || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "Anonymous Fox Road resident";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

// ---------- stats ----------

export function runStats(submissionsDir, statsPath, hashesPath) {
  const subs = loadSubmissions(submissionsDir);

  const byRole = {};
  for (const r of VALID_ROLES) byRole[r] = 0;
  const byMonth = {};
  const publicNames = [];
  const publicStories = [];

  for (const s of subs) {
    const role = normalizeRole(s.role);
    byRole[role] = (byRole[role] || 0) + 1;
    const month = String(s.submittedAt || "").slice(0, 7); // YYYY-MM
    if (month) byMonth[month] = (byMonth[month] || 0) + 1;
    if (asBool(s.displayPublicly)) {
      publicNames.push({
        name: s.displayName,
        role,
        suburb: s.suburb || "",
        at: s.submittedAt,
      });
    }
    if (asBool(s.storyPublic) && s.body) {
      publicStories.push({
        name: s.displayName,
        role,
        suburb: s.suburb || "",
        at: s.submittedAt,
        body: s.body,
      });
    }
  }

  publicNames.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  publicStories.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const stats = {
    generatedAt: new Date().toISOString(),
    total: subs.length,
    byRole,
    byMonth,
    publicNames: publicNames.slice(0, PUBLIC_NAMES_LIMIT),
    publicStories: publicStories.slice(0, PUBLIC_STORIES_LIMIT),
  };
  writeFileSync(statsPath, JSON.stringify(stats, null, 2));

  const hashes = subs.map((s) => s.emailHash).sort();
  writeFileSync(
    hashesPath,
    JSON.stringify(
      { generatedAt: stats.generatedAt, hashes },
      null,
      2
    )
  );

  console.log(`stats: ${subs.length} signature(s) — wrote stats.json + signatures-hashes.json`);
  return stats;
}
