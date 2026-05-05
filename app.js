// Fix Fox Road — gallery + petition app.
// No build step, no dependencies. Reads manifest.json + config.json.

(async function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const [config, manifest, stats, hashes] = await Promise.all([
    fetch("config.json").then((r) => r.json()),
    fetch("manifest.json").then((r) => r.json()),
    fetch("stats.json")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch("signatures-hashes.json")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);

  // ---------- bind config to DOM ----------
  applyConfig(config, manifest);

  // ---------- petition stats + lists ----------
  applyStats(stats);

  // ---------- group items into incidents ----------
  const incidents = groupIntoIncidents(manifest.items);
  let activeFilter = "all";
  renderIncidents(incidents, activeFilter);

  $$(".filter-group button").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".filter-group button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = btn.dataset.filter;
      renderIncidents(incidents, activeFilter);
    });
  });

  // ---------- lightbox ----------
  setupLightbox(manifest.items);

  // ---------- petition form ----------
  setupPetitionForm(config, hashes);

  // ---------- helpers ----------
  function applyConfig(cfg, mf) {
    const loc = cfg.location || {};
    const locationLine = [loc.street, loc.suburb, loc.state]
      .filter(Boolean)
      .join(" · ");
    setBind("locationLine", locationLine);
    setBind("siteName", cfg.siteName);
    setBind("tagline", cfg.tagline);
    setBind("petitionHeadline", cfg.petition && cfg.petition.headline);
    setBind("petitionTarget", cfg.petition && cfg.petition.target);
    document.title = `${cfg.siteName} — community evidence & petition`;

    // asks list
    const asksEl = $('[data-bind="petitionAsks"]');
    if (asksEl && cfg.petition && Array.isArray(cfg.petition.asks)) {
      asksEl.innerHTML = cfg.petition.asks
        .map((a) => `<li>${a}</li>`)
        .join("");
    }

    // contact link
    const contactLink = $("#contactLink");
    if (contactLink && cfg.contact && cfg.contact.email) {
      contactLink.href = `mailto:${cfg.contact.email}?subject=Fix Fox Road petition`;
      contactLink.textContent = cfg.contact.email;
    }

    // build timestamp
    const built = $("#builtAt");
    if (built && mf.generatedAt) {
      built.textContent = formatDate(mf.generatedAt, { dateOnly: true });
    }

    // count
    const countEl = $("#galleryCount");
    if (countEl) {
      const photos = mf.items.filter((i) => i.type === "photo").length;
      const videos = mf.items.filter((i) => i.type === "video").length;
      countEl.textContent = `${photos} photo${photos === 1 ? "" : "s"} · ${videos} video${videos === 1 ? "" : "s"}`;
    }

    // repo link — best-effort guess if not configured
    const repoLink = $("#repoLink");
    if (repoLink && cfg.repoUrl) repoLink.href = cfg.repoUrl;
  }

  function setBind(key, value) {
    if (value == null) return;
    $$(`[data-bind="${key}"]`).forEach((el) => {
      el.innerHTML = value;
    });
  }

  function groupIntoIncidents(items) {
    // Bucket by local date (YYYY-MM-DD). Sort buckets newest first; items within
    // bucket oldest-first so they tell a story chronologically.
    const buckets = new Map();
    for (const item of items) {
      const date = localDate(item.capturedAt) || "unknown";
      if (!buckets.has(date)) buckets.set(date, []);
      buckets.get(date).push(item);
    }
    const ordered = Array.from(buckets.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, items]) => ({
        date,
        items: items.sort((a, b) =>
          String(a.capturedAt).localeCompare(String(b.capturedAt))
        ),
      }));
    return ordered;
  }

  function renderIncidents(incidents, filter) {
    const root = $("#incidents");
    const empty = $("#galleryEmpty");
    root.innerHTML = "";

    let any = false;
    incidents.forEach((inc, i) => {
      const filtered =
        filter === "all" ? inc.items : inc.items.filter((it) => it.type === filter);
      if (!filtered.length) return;
      any = true;

      const photoN = filtered.filter((i) => i.type === "photo").length;
      const videoN = filtered.filter((i) => i.type === "video").length;
      const label = i === 0 ? "Most recent incident" : "Earlier incident";
      const dateLabel = formatDate(inc.date, { dateOnly: true });

      const section = document.createElement("section");
      section.className = "incident";
      section.innerHTML = `
        <header class="incident-head">
          <span class="incident-date">${dateLabel}</span>
          <span class="incident-meta">${label} · ${photoN} photo${photoN === 1 ? "" : "s"}, ${videoN} video${videoN === 1 ? "" : "s"}</span>
        </header>
        <div class="tile-grid"></div>
      `;
      const grid = $(".tile-grid", section);
      filtered.forEach((item) => grid.appendChild(buildTile(item)));
      root.appendChild(section);
    });

    empty.classList.toggle("hidden", any);
  }

  function buildTile(item) {
    const btn = document.createElement("button");
    btn.className = "tile";
    btn.dataset.id = item.id;
    btn.type = "button";
    const time = formatDate(item.capturedAt, { timeOnly: true });
    const thumb = item.type === "video" ? item.poster : item.thumb;
    btn.innerHTML = `
      <img src="${thumb}" alt="${item.type === "video" ? "Video frame" : "Pothole photo"} captured ${time}" loading="lazy" />
      ${item.type === "video" ? videoOverlay(item.duration) : ""}
      ${time ? `<span class="tile-time">${time}</span>` : ""}
    `;
    btn.addEventListener("click", () => openLightbox(item.id));
    return btn;
  }

  function videoOverlay(duration) {
    const d = formatDuration(duration);
    return `
      <span class="tile-badge video">▶ ${d}</span>
      <span class="tile-play" aria-hidden="true">
        <svg viewBox="0 0 56 56" fill="none">
          <circle cx="28" cy="28" r="26" fill="rgba(0,0,0,0.55)" stroke="white" stroke-width="2"/>
          <path d="M22 18 L40 28 L22 38 Z" fill="white"/>
        </svg>
      </span>
    `;
  }

  function formatDuration(sec) {
    if (!sec || !isFinite(sec)) return "";
    const s = Math.round(sec);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m ? `${m}:${String(r).padStart(2, "0")}` : `0:${String(r).padStart(2, "0")}`;
  }

  // Robust local-date extraction. Inputs we may receive:
  //   "2026-05-05T08:23:27"          (no tz, treat as local)
  //   "2026-05-05T08:28:55+1000"     (offset)
  //   "2026-05-04T22:28:55.000000Z"  (UTC)
  function localDate(s) {
    if (!s) return null;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/);
    if (!m) return null;
    const [, y, mo, d, hh, mm, ss, tz] = m;
    if (!tz) return `${y}-${mo}-${d}`;
    const dt = new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}${normTz(tz)}`);
    if (isNaN(dt)) return `${y}-${mo}-${d}`;
    return dt.toLocaleDateString("en-CA"); // YYYY-MM-DD
  }

  function normTz(tz) {
    if (tz === "Z") return "Z";
    // turn "+1000" into "+10:00"
    const m = tz.match(/^([+-])(\d{2}):?(\d{2})$/);
    return m ? `${m[1]}${m[2]}:${m[3]}` : tz;
  }

  function formatDate(s, opts = {}) {
    if (!s) return "";
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?/);
    if (!m) return s;
    const [, y, mo, d, hh, mm, _ss, tz] = m;
    if (opts.dateOnly) {
      return new Date(`${y}-${mo}-${d}T00:00:00`).toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    }
    if (opts.timeOnly && hh) {
      // Construct a date in local-tz semantics: prefer using offset if present.
      const iso = tz ? `${y}-${mo}-${d}T${hh}:${mm}:00${normTz(tz)}` : `${y}-${mo}-${d}T${hh}:${mm}:00`;
      const dt = new Date(iso);
      if (!isNaN(dt))
        return dt.toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        });
      return `${hh}:${mm}`;
    }
    return s;
  }

  // ---------- lightbox ----------
  function setupLightbox(allItems) {
    const dlg = $("#lightbox");
    const stage = $("#lbStage");
    const meta = $("#lbMeta");
    let currentList = allItems;
    let currentIdx = 0;

    window.openLightbox = (id) => {
      currentList = filteredCurrentList(allItems);
      const idx = currentList.findIndex((it) => it.id === id);
      if (idx === -1) return;
      currentIdx = idx;
      render();
      if (typeof dlg.showModal === "function") dlg.showModal();
      else dlg.setAttribute("open", "");
    };

    dlg.addEventListener("click", (e) => {
      const action = e.target.closest("[data-action]")?.dataset.action;
      if (action === "close") close();
      else if (action === "prev") step(-1);
      else if (action === "next") step(1);
      else if (e.target === dlg) close();
    });

    document.addEventListener("keydown", (e) => {
      if (!dlg.open) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    });

    function close() {
      stage.innerHTML = "";
      if (typeof dlg.close === "function") dlg.close();
      else dlg.removeAttribute("open");
    }

    function step(dir) {
      currentIdx = (currentIdx + dir + currentList.length) % currentList.length;
      render();
    }

    function render() {
      const it = currentList[currentIdx];
      stage.innerHTML = "";
      if (it.type === "video") {
        const v = document.createElement("video");
        v.src = it.src;
        v.poster = it.poster || "";
        v.controls = true;
        v.autoplay = true;
        v.playsInline = true;
        v.preload = "metadata";
        stage.appendChild(v);
      } else {
        const img = document.createElement("img");
        img.src = it.src;
        img.alt = "Pothole photograph";
        stage.appendChild(img);
      }
      const time = formatDate(it.capturedAt, { timeOnly: true });
      const date = formatDate(it.capturedAt, { dateOnly: true });
      const gps =
        it.gps && it.gps.lat
          ? ` · <a href="https://www.google.com/maps?q=${it.gps.lat},${it.gps.lon}" target="_blank" rel="noopener">${it.gps.lat.toFixed(4)}, ${it.gps.lon.toFixed(4)}</a>`
          : "";
      const dur = it.type === "video" && it.duration ? ` · ${formatDuration(it.duration)}` : "";
      meta.innerHTML = `<strong>${date}${time ? ` · ${time}` : ""}</strong>${dur}${gps} · <span>${currentIdx + 1} / ${currentList.length}</span>`;
    }
  }

  function filteredCurrentList(allItems) {
    const f = $(".filter-group button.active")?.dataset.filter || "all";
    return f === "all" ? allItems : allItems.filter((i) => i.type === f);
  }

  // ---------- petition stats panel ----------
  function applyStats(stats) {
    if (!stats || stats.total == null) return;
    const panel = $("#petitionStats");
    if (panel) {
      $("#statTotal").textContent = stats.total.toLocaleString();
      $("#statPlural").textContent = stats.total === 1 ? "" : "s";

      const roles = stats.byRole || {};
      const roleLabels = {
        resident: "Fox Road residents",
        local: "Local (nearby) residents",
        commuter: "Commuters",
        business: "Local businesses",
        other: "Other",
      };
      const rolesEl = $("#statRoles");
      rolesEl.innerHTML = "";
      Object.entries(roleLabels).forEach(([key, label]) => {
        const n = roles[key] || 0;
        if (!n) return;
        const li = document.createElement("li");
        li.innerHTML = `<strong>${n}</strong> ${label}`;
        rolesEl.appendChild(li);
      });

      $("#statUpdated").textContent = formatDate(stats.generatedAt, {
        dateOnly: true,
      });
      panel.classList.toggle("hidden", stats.total === 0);
    }

    // Public signatories (only those who consented)
    const sigBox = $("#publicSignatories");
    const sigList = $("#publicNamesList");
    if (sigBox && sigList && Array.isArray(stats.publicNames) && stats.publicNames.length) {
      sigList.innerHTML = "";
      const roleShort = {
        resident: "Fox Rd",
        local: "Local",
        commuter: "Commuter",
        business: "Business",
        other: "",
      };
      stats.publicNames.forEach((s) => {
        const li = document.createElement("li");
        const tag = roleShort[s.role] || "";
        li.innerHTML = `${escapeHtml(s.name)}${tag ? `<span class="role-tag">${tag}</span>` : ""}`;
        sigList.appendChild(li);
      });
      sigBox.classList.remove("hidden");
    }

    // Public stories
    const storyBox = $("#publicStories");
    const storyList = $("#publicStoriesList");
    if (storyBox && storyList && Array.isArray(stats.publicStories) && stats.publicStories.length) {
      storyList.innerHTML = "";
      stats.publicStories.forEach((s) => {
        const li = document.createElement("li");
        const date = formatDate(s.at, { dateOnly: true });
        const suburb = s.suburb ? `, ${escapeHtml(s.suburb)}` : "";
        li.innerHTML = `${escapeHtml(s.body)}<span class="story-attr">— <strong>${escapeHtml(s.name)}</strong>${suburb} · ${date}</span>`;
        storyList.appendChild(li);
      });
      storyBox.classList.remove("hidden");
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // SHA-256 hex of a normalized email — must match petition.mjs.
  async function hashEmail(email) {
    const norm = String(email || "").trim().toLowerCase();
    if (!norm || !crypto.subtle) return null;
    const data = new TextEncoder().encode(norm);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // ---------- petition form ----------
  function setupPetitionForm(cfg, hashesData) {
    const form = $("#petitionForm");
    const status = $("#formStatus");
    if (!form) return;

    const knownHashes = new Set(
      (hashesData && Array.isArray(hashesData.hashes) && hashesData.hashes) || []
    );
    const alreadyEl = $("#alreadySigned");
    const emailInput = form.querySelector('input[name="email"]');
    let emailIsAlreadySigned = false;

    // Soft client-side dedup hint. Run on blur; if the typed email matches a
    // known hash, surface a friendly "you've already signed" notice. The user
    // can still submit if they really want to (we don't block).
    if (emailInput && knownHashes.size) {
      emailInput.addEventListener("blur", async () => {
        const value = emailInput.value;
        if (!value) {
          alreadyEl?.classList.add("hidden");
          emailIsAlreadySigned = false;
          return;
        }
        const h = await hashEmail(value);
        emailIsAlreadySigned = h ? knownHashes.has(h) : false;
        if (alreadyEl) alreadyEl.classList.toggle("hidden", !emailIsAlreadySigned);
      });
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      status.className = "form-status";
      status.textContent = "";

      const fd = new FormData(form);
      // honeypot — silently succeed if filled
      if (fd.get("_gotcha")) {
        showOk("Thanks — your signature has been recorded.");
        form.reset();
        return;
      }
      if (!fd.get("name") || !fd.get("email") || !fd.get("consent")) {
        showErr("Please fill in your name, email and tick the consent box.");
        return;
      }

      // Normalize the optional booleans to "yes"/"no" for whatever the
      // endpoint receives (Formspree, mailto body, etc).
      const normalized = new FormData();
      for (const [k, v] of fd.entries()) {
        if (k === "displayPublicly" || k === "storyPublic") continue;
        normalized.append(k, v);
      }
      normalized.append("displayPublicly", fd.get("displayPublicly") ? "yes" : "no");
      normalized.append("storyPublic", fd.get("storyPublic") ? "yes" : "no");

      const endpoint = cfg.petition && cfg.petition.endpoint;
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending…";

      try {
        if (endpoint) {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { Accept: "application/json" },
            body: normalized,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          showOk("Thank you — your signature has been received.");
          form.reset();
          alreadyEl?.classList.add("hidden");
        } else {
          // No endpoint configured: fall back to mailto so submissions are not lost.
          const to = (cfg.contact && cfg.contact.email) || "";
          const subject = encodeURIComponent("Fox Road petition — new signature");
          const lines = ["[Fox Road petition signature]", ""];
          for (const [k, v] of normalized.entries()) {
            if (k.startsWith("_")) continue;
            const display = String(v).replace(/\n/g, "\n  ");
            lines.push(`${k}: ${display}`);
          }
          lines.push(
            "",
            "(This email is the petition signature. Send it as-is to register your support.)"
          );
          const body = encodeURIComponent(lines.join("\n"));
          window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
          showOk(
            "Opening your email app — please hit Send to register your signature."
          );
        }
      } catch (err) {
        showErr("Sorry, something went wrong. Please try again or email us directly.");
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Add my signature";
      }
    });

    function showOk(msg) {
      status.className = "form-status ok";
      status.textContent = msg;
    }
    function showErr(msg) {
      status.className = "form-status err";
      status.textContent = msg;
    }
  }
})();
