(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
  const SIZES = { kids: range(16, 40), adult: range(34, 50) };
  // same names and order as COLORS in app/color.py
  const COLORS = {
    black: "#1c1c1c", white: "#ffffff", grey: "#9aa0a6", beige: "#dcc7a1", brown: "#7b4a26", red: "#d0312d",
    pink: "#f29cc0", orange: "#f28c28", yellow: "#f5d03b", green: "#3c9a4c", blue: "#2f6fd1", purple: "#7e57c2",
  };
  const COLOR_NAMES = Object.keys(COLORS);
  const MAX_EDGE = 2048;     // photos are downscaled in the browser before upload
  const JPEG_QUALITY = 0.85;

  // ---------- persisted preferences ----------
  const prefs = (() => {
    try { return Object.assign({ cat: "kids", size: "", grouped: true }, JSON.parse(localStorage.getItem("shoebox") || "{}")); }
    catch { return { cat: "kids", size: "", grouped: true }; }
  })();
  const savePrefs = () => { try { localStorage.setItem("shoebox", JSON.stringify(prefs)); } catch {} };

  // ---------- state ----------
  const state = { shoes: [], cat: "all", size: null, color: null, boxed: false, q: "", grouped: prefs.grouped };
  let draft = null;          // shoe being added/edited
  let retaking = false;
  let sheetInHistory = false; // the open sheet owns a history entry, so Back closes it instead of leaving the app
  const queue = [];          // pending uploads
  const failed = [];
  let uploading = false;

  const el = {
    gallery: $("#gallery"), empty: $("#empty"), count: $("#count"), search: $("#search"),
    catFilter: $("#catFilter"), groupToggle: $("#groupToggle"), boxedToggle: $("#boxedToggle"), sizeStrip: $("#sizeStrip"), colorStrip: $("#colorStrip"),
    addBtn: $("#addBtn"), camera: $("#camera"), queue: $("#queue"),
    sheet: $("#sheet"), preview: $("#preview"), previewAction: $("#previewAction"),
    catPick: $("#catPick"), sizeInput: $("#sizeInput"), halfBtn: $("#halfBtn"),
    sizeGrid: $("#sizeGrid"), colorField: $("#colorField"), colorPick: $("#colorPick"), boxed: $("#boxed"), comment: $("#comment"), foot: $("#sheetFoot"), toast: $("#toast"),
  };

  // ---------- utils ----------
  const sizeNum = (s) => { const n = parseFloat(String(s).replace(",", ".")); return isNaN(n) ? Infinity : n; };
  const bySize = (a, b) => sizeNum(a) - sizeNum(b) || String(a).localeCompare(String(b));
  const catLabel = (c) => (c === "kids" ? "Kids" : "Adult");
  const colorLabel = (c) => c.charAt(0).toUpperCase() + c.slice(1);
  const dot = (c) => {
    const d = document.createElement("span");
    d.className = "dot";
    d.style.background = COLORS[c];
    return d;
  };

  let toastTimer;
  function toast(msg, err = false) {
    el.toast.textContent = msg;
    el.toast.className = "toast" + (err ? " err" : "");
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), err ? 4000 : 1600);
  }

  async function api(method, url, body) {
    const opts = { method };
    if (body instanceof FormData) opts.body = body;
    else if (body) { opts.body = JSON.stringify(body); opts.headers = { "Content-Type": "application/json" }; }
    const res = await fetch(url, opts);
    if (!res.ok) {
      let msg = res.status + " " + res.statusText;
      try { msg = (await res.json()).detail || msg; } catch {}
      throw new Error(msg);
    }
    return res.status === 204 ? null : res.json();
  }

  function resizeImage(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          c.getContext("2d").drawImage(img, 0, 0, w, h); // browsers apply EXIF rotation here
          c.toBlob((b) => { URL.revokeObjectURL(url); resolve(b || file); }, "image/jpeg", JPEG_QUALITY);
        } catch { URL.revokeObjectURL(url); resolve(file); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); }; // let the server try
      img.src = url;
    });
  }

  // ---------- gallery ----------
  function visibleShoes() {
    const q = state.q.trim().toLowerCase();
    return state.shoes.filter((s) =>
      (state.cat === "all" || s.category === state.cat) &&
      (state.size === null || s.size === state.size) &&
      (state.color === null || s.color === state.color) &&
      (!state.boxed || s.boxed) &&
      (!q || s.size.toLowerCase().includes(q) || s.color.includes(q) || (s.comment || "").toLowerCase().includes(q) || catLabel(s.category).toLowerCase().includes(q))
    );
  }

  function tile(s, showSize) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tile";
    b.setAttribute("aria-label", `${catLabel(s.category)} size ${s.size}${s.color ? ", " + s.color : ""}${s.comment ? ", " + s.comment : ""}`);
    b.innerHTML =
      `<img loading="lazy" alt="">` +
      (state.cat === "all" ? `<span class="tag ${s.category}">${catLabel(s.category)}</span>` : "") +
      (showSize ? `<span class="tsize"></span>` : "") +
      (s.comment ? `<span class="note" title="Has a note">i</span>` : "");
    b.querySelector("img").src = s.thumb_url;
    if (showSize) b.querySelector(".tsize").textContent = s.size;
    b.addEventListener("click", () => openEditor({ mode: "edit", ...s }));
    return b;
  }

  // filter strip for one shoe field ("size" or "color"), with counts for the current type filter
  function renderStrip(strip, key, allLabel, order, label) {
    const pool = state.shoes.filter((s) => state.cat === "all" || s.category === state.cat);
    const counts = {};
    pool.forEach((s) => { if (s[key]) counts[s[key]] = (counts[s[key]] || 0) + 1; });
    const values = Object.keys(counts).sort(order);
    if (state[key] !== null && !counts[state[key]]) state[key] = null;

    strip.replaceChildren();
    const mk = (text, value, n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = state[key] === value ? "on" : "";
      b.textContent = text;
      if (key === "color" && value) b.prepend(dot(value));
      if (n !== undefined) { const sm = document.createElement("small"); sm.textContent = n; b.append(sm); }
      b.addEventListener("click", () => { state[key] = state[key] === value ? null : value; render(); });
      return b;
    };
    strip.append(mk(allLabel, null));
    values.forEach((v) => strip.append(mk(label(v), v, counts[v])));
    strip.hidden = values.length === 0;
  }

  function render() {
    renderStrip(el.sizeStrip, "size", "All sizes", bySize, (v) => v);
    renderStrip(el.colorStrip, "color", "All colors", (a, b) => COLOR_NAMES.indexOf(a) - COLOR_NAMES.indexOf(b), colorLabel);
    const list = visibleShoes();
    el.count.textContent = state.shoes.length ? `${list.length} of ${state.shoes.length}` : "";
    el.empty.hidden = state.shoes.length > 0;
    el.gallery.replaceChildren();

    if (state.shoes.length && !list.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "No shoes match this filter.";
      el.gallery.append(p);
      return;
    }

    if (state.grouped) {
      const groups = {};
      list.forEach((s) => (groups[s.size] ||= []).push(s));
      Object.keys(groups).sort(bySize).forEach((sz) => {
        const sec = document.createElement("section");
        sec.className = "group";
        const head = document.createElement("div");
        head.className = "group-head";
        const stamp = document.createElement("span");
        stamp.className = "stamp";
        stamp.innerHTML = "<span>EU</span>";
        stamp.append(document.createTextNode(sz));
        const cnt = document.createElement("span");
        cnt.className = "group-count";
        cnt.textContent = groups[sz].length === 1 ? "1 pair" : `${groups[sz].length} pairs`;
        head.append(stamp, cnt);
        const grid = document.createElement("div");
        grid.className = "grid";
        groups[sz].forEach((s) => grid.append(tile(s, false)));
        sec.append(head, grid);
        el.gallery.append(sec);
      });
    } else {
      const grid = document.createElement("div");
      grid.className = "grid";
      list.forEach((s) => grid.append(tile(s, true)));
      el.gallery.append(grid);
    }
  }

  async function load() {
    try { state.shoes = await api("GET", "/api/shoes"); }
    catch (e) { toast("Could not load shoes: " + e.message, true); }
    render();
  }

  // ---------- filters ----------
  el.search.addEventListener("input", () => { state.q = el.search.value; render(); });
  el.catFilter.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cat]");
    if (!b) return;
    state.cat = b.dataset.cat;
    el.catFilter.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    render();
  });
  const syncGroupBtn = () => {
    el.groupToggle.setAttribute("aria-pressed", String(state.grouped));
    el.groupToggle.textContent = state.grouped ? "✓ Grouped by size" : "Group by size";
  };
  el.groupToggle.addEventListener("click", () => {
    state.grouped = !state.grouped;
    prefs.grouped = state.grouped; savePrefs(); syncGroupBtn(); render();
  });
  syncGroupBtn();
  el.boxedToggle.addEventListener("click", () => {
    state.boxed = !state.boxed;
    el.boxedToggle.setAttribute("aria-pressed", String(state.boxed));
    el.boxedToggle.textContent = state.boxed ? "✓ Boxed" : "Boxed";
    render();
  });

  // ---------- camera ----------
  el.addBtn.addEventListener("click", () => { retaking = false; el.camera.click(); });

  el.camera.addEventListener("change", () => {
    const file = el.camera.files && el.camera.files[0];
    el.camera.value = "";
    if (!file) return;
    if (retaking && draft && draft.mode === "add") {
      setDraftPhoto(file);
      retaking = false;
      return;
    }
    openEditor({ mode: "add", category: prefs.cat, size: prefs.size, comment: "" });
    setDraftPhoto(file);
  });

  function setDraftPhoto(file) {
    if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
    draft.previewUrl = URL.createObjectURL(file);
    el.preview.src = draft.previewUrl;
    draft.blob = resizeImage(file); // start compressing right away
  }

  // ---------- editor sheet ----------
  function openEditor(d) {
    draft = { ...d };
    if (!sheetInHistory) { history.pushState(null, ""); sheetInHistory = true; }
    el.sheet.hidden = false;
    document.body.style.overflow = "hidden";
    el.comment.value = draft.comment || "";
    el.boxed.checked = !!draft.boxed;
    el.colorField.hidden = draft.mode !== "edit"; // new shoes get their color detected on upload

    if (draft.mode === "edit") {
      el.preview.src = draft.photo_url;
      el.previewAction.textContent = "Full size";
      el.foot.innerHTML =
        `<button type="button" class="danger" data-act="delete">Delete</button>` +
        `<button type="button" data-act="cancel">Cancel</button>` +
        `<button type="button" class="primary" data-act="save">Save</button>`;
    } else {
      el.preview.removeAttribute("src");
      el.previewAction.textContent = "Retake";
      el.foot.innerHTML =
        `<button type="button" class="icon" data-act="cancel" aria-label="Discard">✕</button>` +
        `<button type="button" class="secondary" data-act="save">Save</button>` +
        `<button type="button" class="primary" data-act="next">Save &amp; next</button>`;
    }
    renderPicker();
    el.sheet.querySelector(".sheet-body").scrollTop = 0;
  }

  function closeEditor(keepPhoto = false) {
    if (draft && draft.previewUrl && !keepPhoto) URL.revokeObjectURL(draft.previewUrl);
    draft = null;
    el.sheet.hidden = true;
    document.body.style.overflow = "";
    if (sheetInHistory) { sheetInHistory = false; history.back(); }
  }

  window.addEventListener("popstate", () => {
    if (!sheetInHistory) return;
    sheetInHistory = false;
    closeEditor();
  });

  function renderPicker() {
    el.catPick.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.cat === draft.category));
    el.sizeInput.value = draft.size || "";
    const whole = String(draft.size || "").replace(/\.5$/, "");
    const isHalf = /\.5$/.test(draft.size || "");
    el.halfBtn.setAttribute("aria-pressed", String(isHalf));
    el.sizeGrid.replaceChildren();
    SIZES[draft.category].forEach((n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = n;
      if (n === whole) b.classList.add("on");
      b.addEventListener("click", () => { draft.size = isHalf ? n + ".5" : n; renderPicker(); });
      el.sizeGrid.append(b);
    });
    el.colorPick.replaceChildren();
    COLOR_NAMES.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = colorLabel(c);
      b.prepend(dot(c));
      b.classList.toggle("on", c === draft.color);
      b.setAttribute("aria-pressed", String(c === draft.color));
      b.addEventListener("click", () => { draft.color = c; renderPicker(); });
      el.colorPick.append(b);
    });
  }

  el.catPick.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cat]");
    if (!b || !draft) return;
    draft.category = b.dataset.cat;
    renderPicker();
  });
  el.sizeInput.addEventListener("input", () => {
    draft.size = el.sizeInput.value.trim().replace(",", ".");
    const keep = el.sizeInput.selectionStart;
    renderPicker();
    el.sizeInput.setSelectionRange(keep, keep);
  });
  el.halfBtn.addEventListener("click", () => {
    const s = draft.size || "";
    if (/\.5$/.test(s)) draft.size = s.slice(0, -2);
    else if (/^\d+$/.test(s)) draft.size = s + ".5";
    else return toast("Pick a whole size first");
    renderPicker();
  });

  el.previewAction.addEventListener("click", () => {
    if (!draft) return;
    if (draft.mode === "edit") window.open(draft.photo_url, "_blank");
    else { retaking = true; el.camera.click(); }
  });

  el.foot.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b || !draft) return;
    const act = b.dataset.act;
    draft.comment = el.comment.value.trim();
    draft.boxed = el.boxed.checked;

    if (act === "cancel") return closeEditor();

    if (act === "delete") {
      if (!confirm("Delete this shoe and its photo?")) return;
      try {
        await api("DELETE", `/api/shoes/${draft.id}`);
        state.shoes = state.shoes.filter((s) => s.id !== draft.id);
        closeEditor(); render(); toast("Deleted");
      } catch (err) { toast("Delete failed: " + err.message, true); }
      return;
    }

    if (!draft.size) { el.sizeInput.focus(); return toast("Pick a size first", true); }

    if (draft.mode === "edit") {
      try {
        const upd = await api("PATCH", `/api/shoes/${draft.id}`, { category: draft.category, size: draft.size, comment: draft.comment, boxed: draft.boxed, color: draft.color || undefined });
        state.shoes = state.shoes.map((s) => (s.id === upd.id ? upd : s));
        closeEditor(); render(); toast("Saved");
      } catch (err) { toast("Save failed: " + err.message, true); }
      return;
    }

    // add mode: queue the upload and close immediately
    if (!draft.blob) return toast("Take a photo first", true);
    prefs.cat = draft.category; prefs.size = draft.size; savePrefs();
    enqueue({ blob: draft.blob, previewUrl: draft.previewUrl, category: draft.category, size: draft.size, comment: draft.comment, boxed: draft.boxed });
    closeEditor(true);
    if (act === "next") { retaking = false; el.camera.click(); } // must stay synchronous inside the tap
    else toast("Saved");
  });

  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && draft) closeEditor(); });

  // ---------- upload queue ----------
  function enqueue(item) { queue.push(item); updateQueue(); pump(); }

  async function pump() {
    if (uploading) return;
    uploading = true;
    while (queue.length) {
      const item = queue[0];
      updateQueue();
      try {
        const blob = await item.blob;
        const fd = new FormData();
        fd.append("photo", blob, "shoe.jpg");
        fd.append("category", item.category);
        fd.append("size", item.size);
        fd.append("comment", item.comment || "");
        fd.append("boxed", item.boxed ? "true" : "false");
        const shoe = await api("POST", "/api/shoes", fd);
        state.shoes.unshift(shoe);
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        render();
      } catch (err) {
        failed.push(item);
        toast("Upload failed: " + err.message, true);
      }
      queue.shift();
    }
    uploading = false;
    updateQueue();
  }

  function updateQueue() {
    if (queue.length) {
      el.queue.hidden = false;
      el.queue.className = "queue";
      el.queue.textContent = `Uploading ${queue.length}…`;
    } else if (failed.length) {
      el.queue.hidden = false;
      el.queue.className = "queue failed";
      el.queue.textContent = `${failed.length} upload${failed.length > 1 ? "s" : ""} failed. Tap to retry`;
    } else {
      el.queue.hidden = true;
    }
  }
  el.queue.addEventListener("click", () => {
    if (!failed.length || queue.length) return;
    queue.push(...failed.splice(0));
    updateQueue(); pump();
  });

  window.addEventListener("beforeunload", (e) => {
    if (queue.length || failed.length) { e.preventDefault(); e.returnValue = ""; }
  });

  load();
})();
