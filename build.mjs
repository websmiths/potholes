#!/usr/bin/env node
// Converts /artwork/*.HEIC and /artwork/*.MOV into web-ready assets
// and writes manifest.json. Idempotent: skips files whose outputs are
// up to date relative to the source mtime.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { extname, join, basename } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const SRC = join(ROOT, "artwork");
const OUT = join(ROOT, "media");
const DIRS = {
  photos: join(OUT, "photos"),
  thumbs: join(OUT, "thumbs"),
  videos: join(OUT, "videos"),
  posters: join(OUT, "posters"),
};
for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true });

const PHOTO_MAX = 1800;
const POSTER_MAX = 1280;
const THUMB_MAX = 800;
const JPG_QUALITY = 82;
const VIDEO_MAX_H = 720;
const VIDEO_FPS = 25;
const VIDEO_CRF = 28;

// Source filenames to skip (e.g. accidental duplicates). Edit and re-run.
const EXCLUDE = new Set([]);

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")}\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function shStr(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

function needsRebuild(src, ...outs) {
  const sm = statSync(src).mtimeMs;
  for (const o of outs) {
    if (!existsSync(o)) return true;
    if (statSync(o).mtimeMs < sm) return true;
  }
  return false;
}

// ImageMagick EXIF rationals like "28/1,38/1,4689/100" -> decimal degrees
function dmsToDecimal(dms, ref) {
  if (!dms) return null;
  const parts = dms.split(",").map((p) => {
    const [n, d] = p.split("/").map(Number);
    return d ? n / d : n;
  });
  const [deg = 0, min = 0, sec = 0] = parts;
  const sign = ref === "S" || ref === "W" ? -1 : 1;
  return sign * (deg + min / 60 + sec / 3600);
}

function readImageMeta(file) {
  const out = shStr("magick", [
    "identify",
    "-format",
    "%w|%h|%[EXIF:DateTimeOriginal]|%[EXIF:GPSLatitudeRef]|%[EXIF:GPSLatitude]|%[EXIF:GPSLongitudeRef]|%[EXIF:GPSLongitude]|%[EXIF:Orientation]",
    file,
  ]).trim();
  const [w, h, dt, latRef, lat, lonRef, lon, orient] = out.split("|");
  const width = Number(w);
  const height = Number(h);
  // EXIF DateTimeOriginal: "YYYY:MM:DD HH:MM:SS" — treat as local time, no TZ available.
  let captured = null;
  if (dt) {
    const m = dt.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (m) captured = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  }
  const latitude = dmsToDecimal(lat, latRef);
  const longitude = dmsToDecimal(lon, lonRef);
  // After auto-orient the swapped dimensions matter; report post-orient size.
  const rotated = ["5", "6", "7", "8"].includes(orient);
  return {
    width: rotated ? height : width,
    height: rotated ? width : height,
    capturedAt: captured,
    gps: latitude != null && longitude != null ? { lat: latitude, lon: longitude } : null,
  };
}

function readVideoMeta(file) {
  const out = shStr("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_entries",
    "format=duration:format_tags=creation_time,com.apple.quicktime.creationdate,com.apple.quicktime.location.ISO6709:stream=width,height,codec_type",
    file,
  ]);
  const data = JSON.parse(out);
  const v = (data.streams || []).find((s) => s.codec_type === "video") || {};
  const tags = (data.format && data.format.tags) || {};
  // Prefer Apple's local-tz creationdate ("2026-05-05T08:28:55+1000"), fallback to UTC.
  const captured = tags["com.apple.quicktime.creationdate"] || tags.creation_time || null;
  let gps = null;
  const iso = tags["com.apple.quicktime.location.ISO6709"];
  if (iso) {
    // e.g. "-28.6490+153.3830+205.932/"
    const m = iso.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
    if (m) gps = { lat: Number(m[1]), lon: Number(m[2]) };
  }
  return {
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    duration: Number(data.format && data.format.duration) || 0,
    capturedAt: captured,
    gps,
  };
}

function convertPhoto(src, idBase) {
  const photo = join(DIRS.photos, `${idBase}.jpg`);
  const thumb = join(DIRS.thumbs, `${idBase}.jpg`);
  if (needsRebuild(src, photo)) {
    sh("magick", [
      src,
      "-auto-orient",
      "-strip",
      "-resize",
      `${PHOTO_MAX}x${PHOTO_MAX}>`,
      "-quality",
      String(JPG_QUALITY),
      "-interlace",
      "Plane",
      photo,
    ]);
    console.log("photo:", basename(photo));
  }
  if (needsRebuild(src, thumb)) {
    sh("magick", [
      src,
      "-auto-orient",
      "-strip",
      "-resize",
      `${THUMB_MAX}x${THUMB_MAX}^`,
      "-gravity",
      "center",
      "-extent",
      `${THUMB_MAX}x${THUMB_MAX}`,
      "-quality",
      "80",
      "-interlace",
      "Plane",
      thumb,
    ]);
    console.log("thumb:", basename(thumb));
  }
  return { photo, thumb };
}

function convertVideo(src, idBase) {
  const mp4 = join(DIRS.videos, `${idBase}.mp4`);
  const poster = join(DIRS.posters, `${idBase}.jpg`);
  if (needsRebuild(src, mp4)) {
    sh("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      src,
      "-vf",
      `scale=-2:'min(${VIDEO_MAX_H},ih)':flags=lanczos,format=yuv420p`,
      "-r",
      String(VIDEO_FPS),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      String(VIDEO_CRF),
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-movflags",
      "+faststart",
      mp4,
    ]);
    console.log("video:", basename(mp4));
  }
  if (needsRebuild(src, poster)) {
    sh("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      "0.5",
      "-i",
      src,
      "-frames:v",
      "1",
      "-vf",
      `scale=-2:'min(${POSTER_MAX},ih)'`,
      "-q:v",
      "4",
      poster,
    ]);
    console.log("poster:", basename(poster));
  }
  return { mp4, poster };
}

function rel(p) {
  return p.replace(ROOT, "").replace(/^\/+/, "");
}

function idFor(name) {
  // fox-road-potholes_3159.HEIC -> 3159
  const m = name.match(/_(\w+)\.[^.]+$/);
  return m ? m[1] : name.replace(/\.[^.]+$/, "");
}

const items = [];
const files = readdirSync(SRC)
  .filter((f) => /\.(heic|jpg|jpeg|png|mov|mp4)$/i.test(f))
  .filter((f) => !EXCLUDE.has(f))
  .sort();

for (const name of files) {
  const src = join(SRC, name);
  const ext = extname(name).toLowerCase();
  const id = idFor(name);
  try {
    if (ext === ".heic" || ext === ".jpg" || ext === ".jpeg" || ext === ".png") {
      const meta = readImageMeta(src);
      const { photo, thumb } = convertPhoto(src, id);
      items.push({
        id,
        type: "photo",
        src: rel(photo),
        thumb: rel(thumb),
        width: meta.width,
        height: meta.height,
        capturedAt: meta.capturedAt,
        gps: meta.gps,
        sourceName: name,
      });
    } else if (ext === ".mov" || ext === ".mp4") {
      const meta = readVideoMeta(src);
      const { mp4, poster } = convertVideo(src, id);
      items.push({
        id,
        type: "video",
        src: rel(mp4),
        poster: rel(poster),
        width: meta.width,
        height: meta.height,
        duration: meta.duration,
        capturedAt: meta.capturedAt,
        gps: meta.gps,
        sourceName: name,
      });
    }
  } catch (err) {
    console.error("FAILED", name, err.message);
  }
}

// Sort: oldest first (newest incidents render first in UI via JS).
items.sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));

// Prune orphans: any file in media/ whose id is not present in the manifest.
const liveIds = new Set(items.map((i) => i.id));
let pruned = 0;
for (const dir of Object.values(DIRS)) {
  for (const name of readdirSync(dir)) {
    const id = name.replace(/\.[^.]+$/, "");
    if (!liveIds.has(id)) {
      unlinkSync(join(dir, name));
      console.log("prune:", join(basename(dir), name));
      pruned++;
    }
  }
}
if (pruned) console.log(`pruned ${pruned} orphan(s)`);

const manifest = {
  generatedAt: new Date().toISOString(),
  count: items.length,
  items,
};
writeFileSync(join(ROOT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`manifest: ${items.length} items`);
