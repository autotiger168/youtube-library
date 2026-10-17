/* =========================================================
   我的影音收藏館 — 前端程式
   - 讀取 config/categories.json 與 data/videos.json 顯示影片
   - 我的最愛／收藏夾存在 data/favorites.json，透過 GitHub API 同步
   ========================================================= */
(() => {
  "use strict";

  // ---------- 小工具 ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem("ytlib." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("ytlib." + k, JSON.stringify(v)); } catch { /* 無痕模式等 */ } },
    del(k) { try { localStorage.removeItem("ytlib." + k); } catch { } },
  };
  const b64enc = (s) => { const b = new TextEncoder().encode(s); let bin = ""; for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]); return btoa(bin); };
  const b64dec = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
  const fmtDur = (sec) => { if (!sec) return ""; const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0"); };
  const fmtViews = (n) => !n ? "" : n >= 1e8 ? (n / 1e8).toFixed(1) + " 億次" : n >= 1e4 ? (n / 1e4).toFixed(n >= 1e5 ? 0 : 1) + " 萬次" : n + " 次";
  const fmtAgo = (iso) => {
    if (!iso) return ""; const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 3600) return "剛剛"; if (d < 86400) return Math.floor(d / 3600) + " 小時前";
    if (d < 86400 * 30) return Math.floor(d / 86400) + " 天前"; if (d < 86400 * 365) return Math.floor(d / 86400 / 30) + " 個月前";
    return Math.floor(d / 86400 / 365) + " 年前";
  };
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let toastTimer;
  const toast = (msg) => { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600); };

  // ---------- 狀態 ----------
  const S = {
    config: { settings: {}, groups: [] },
    data: { videos: [] },
    byId: new Map(),
    fav: { version: 1, favorites: [], collections: [] },
    favSha: null,
    configSha: null,
    gh: store.get("gh", null) || guessRepo(),
    watched: new Set(store.get("watched", [])),
    hideWatched: store.get("hideWatched", false),
    sort: store.get("sort", "published"),
    synced: false,
  };

  function guessRepo() {
    const host = location.hostname;
    if (host.endsWith(".github.io")) {
      const owner = host.split(".")[0];
      const first = location.pathname.split("/").filter(Boolean)[0];
      return { owner, repo: first || host, branch: "main", token: "" };
    }
    return { owner: "", repo: "", branch: "main", token: "" };
  }

  const allCats = () => S.config.groups.flatMap((g) => g.categories.map((c) => ({ ...c, group: g })));
  const catById = (id) => allCats().find((c) => c.id === id);
  const lookup = (id) => S.byId.get(id) || S.fav.favorites.find((f) => f.id === id) ||
    S.fav.collections.flatMap((c) => c.videos).find((v) => v.id === id);
  const isFav = (id) => S.fav.favorites.some((f) => f.id === id);
  const snapshot = (v) => ({ id: v.id, title: v.title, channel: v.channel, thumb: v.thumb, duration: v.duration || 0, publishedAt: v.publishedAt || "", embeddable: v.embeddable !== false });

  // ---------- 主題 ----------
  function applyTheme() { const t = store.get("theme", "auto"); if (t === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.dataset.theme = t; }
  applyTheme();

  // ---------- GitHub API ----------
  const ghReady = () => !!(S.gh && S.gh.owner && S.gh.repo && S.gh.token);
  async function gh(path, opts = {}) {
    const res = await fetch(`https://api.github.com/repos/${S.gh.owner}/${S.gh.repo}${path}`, {
      ...opts,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${S.gh.token}`, "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
    });
    return res;
  }
  async function ghGetFile(path) {
    const r = await gh(`/contents/${path}?ref=${encodeURIComponent(S.gh.branch || "main")}&t=${Date.now()}`, { cache: "no-store" });
    if (r.status === 404) return { json: null, sha: null };
    if (!r.ok) throw new Error(r.status === 401 ? "Token 無效或已過期" : "GitHub 讀取失敗（" + r.status + "）");
    const j = await r.json();
    return { json: JSON.parse(b64dec(j.content)), sha: j.sha };
  }
  async function ghPutFile(path, obj, sha, message) {
    const body = { message, content: b64enc(JSON.stringify(obj, null, 1) + "\n"), branch: S.gh.branch || "main" };
    if (sha) body.sha = sha;
    const r = await gh(`/contents/${path}`, { method: "PUT", body: JSON.stringify(body) });
    if (!r.ok) { const e = new Error("GitHub 寫入失敗（" + r.status + "）"); e.status = r.status; throw e; }
    return (await r.json()).content.sha;
  }

  // ---------- 我的最愛：載入／合併／儲存 ----------
  function mergeFav(a, b) {
    const out = { version: 1, favorites: [], collections: [] };
    const fm = new Map();
    [...(a.favorites || []), ...(b.favorites || [])].forEach((f) => { if (!fm.has(f.id)) fm.set(f.id, f); });
    out.favorites = [...fm.values()];
    const cm = new Map();
    [...(a.collections || []), ...(b.collections || [])].forEach((c) => {
      if (!cm.has(c.id)) cm.set(c.id, { ...c, videos: [...(c.videos || [])] });
      else { const t = cm.get(c.id); c.videos.forEach((v) => { if (!t.videos.some((x) => x.id === v.id)) t.videos.push(v); }); }
    });
    out.collections = [...cm.values()];
    return out;
  }

  async function loadFavorites() {
    const local = store.get("fav", null);
    const dirty = store.get("favDirty", false);
    if (ghReady()) {
      try {
        const { json, sha } = await ghGetFile("data/favorites.json");
        S.favSha = sha;
        S.fav = json || { version: 1, favorites: [], collections: [] };
        S.synced = true;
        if (dirty && local) { S.fav = mergeFav(S.fav, local); store.set("favDirty", false); scheduleSave(true); }
        store.set("fav", S.fav);
        return;
      } catch (e) {
        S.synced = false;
        showBanner(`⚠️ 無法連上 GitHub：${esc(e.message)}。目前使用本機暫存資料，<a href="#/settings">檢查設定</a>`);
      }
    }
    let remote = null;
    try { remote = await (await fetch("data/favorites.json?t=" + Date.now(), { cache: "no-store" })).json(); } catch { }
    S.fav = local ? mergeFav(local, remote || {}) : (remote || S.fav);
    if (!ghReady()) showBanner(`收藏目前只存在這台裝置。<a href="#/settings">連結 GitHub</a> 後，手機和電腦就會同步。`);
  }

  let saveTimer = null;
  function scheduleSave(immediate) {
    store.set("fav", S.fav);
    if (!ghReady()) { store.set("favDirty", true); return; }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, immediate ? 50 : 1200);
  }
  async function saveNow() {
    saveTimer = null;
    try {
      S.favSha = await ghPutFile("data/favorites.json", S.fav, S.favSha, "更新我的最愛");
      store.set("favDirty", false); hideBanner();
    } catch (e) {
      if (e.status === 409 || e.status === 422) {   // 別台裝置剛好也存過：取得最新版本後重試
        try {
          const { json, sha } = await ghGetFile("data/favorites.json");
          S.fav = mergeFav(S.fav, json || {}); S.favSha = sha;
          S.favSha = await ghPutFile("data/favorites.json", S.fav, S.favSha, "更新我的最愛");
          store.set("favDirty", false); return;
        } catch (e2) { e = e2; }
      }
      store.set("favDirty", true);
      showBanner(`⚠️ 收藏未能同步到 GitHub（${esc(e.message)}），已暫存在本機。<a href="#/settings">檢查設定</a>`);
    }
  }
  function showBanner(html) { const b = $("#sync-banner"); b.innerHTML = html; b.hidden = false; }
  function hideBanner() { $("#sync-banner").hidden = true; }

  // ---------- 收藏操作 ----------
  function toggleFav(id) {
    const v = lookup(id); if (!v) return;
    const i = S.fav.favorites.findIndex((f) => f.id === id);
    if (i >= 0) { S.fav.favorites.splice(i, 1); toast("已從最愛移除"); }
    else { S.fav.favorites.unshift({ ...snapshot(v), addedAt: new Date().toISOString() }); toast("❤️ 已加入最愛"); }
    scheduleSave(); refreshCardStates(id);
  }
  function toggleWatched(id) {
    S.watched.has(id) ? S.watched.delete(id) : S.watched.add(id);
    store.set("watched", [...S.watched].slice(-3000)); refreshCardStates(id);
  }
  function markWatched(id) { if (!S.watched.has(id)) { S.watched.add(id); store.set("watched", [...S.watched].slice(-3000)); refreshCardStates(id); } }
  function refreshCardStates(id) {
    document.querySelectorAll(`[data-vid="${CSS.escape(id)}"]`).forEach((el) => {
      el.classList.toggle("watched", S.watched.has(id) && !el.hasAttribute("data-keep-bright"));
      const h = el.querySelector('[data-act="fav"]'); if (h) { h.textContent = isFav(id) ? "♥" : "♡"; h.classList.toggle("fav-on", isFav(id)); }
      const w = el.querySelector('[data-act="watched"]'); if (w) w.title = S.watched.has(id) ? "標示為未看" : "標示為已看";
    });
    const pf = $('#player-info [data-act="fav"]'); if (pf && pf.dataset.id === id) pf.textContent = isFav(id) ? "♥ 已在最愛" : "♡ 加入最愛";
  }

  // ---------- 卡片 ----------
  function card(v, opt = {}) {
    const fav = isFav(v.id), w = S.watched.has(v.id);
    const isNew = v.firstSeen && S.data.updatedAt && v.firstSeen === S.data.updatedAt;
    return `<article class="card${w && !opt.keepBright ? " watched" : ""}" data-vid="${esc(v.id)}"${opt.keepBright ? " data-keep-bright" : ""}>
      <button class="thumb" data-act="play" data-id="${esc(v.id)}" aria-label="播放 ${esc(v.title)}">
        <img loading="lazy" src="${esc(v.thumb || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`)}" alt="">
        ${v.duration ? `<span class="badge">${fmtDur(v.duration)}</span>` : ""}
        ${isNew ? `<span class="badge left">NEW</span>` : ""}
      </button>
      <div class="card-body">
        <h3 class="card-title" data-act="play" data-id="${esc(v.id)}">${esc(v.title)}</h3>
        <div class="card-meta"><span class="ch">${esc(v.channel)}</span>${[fmtViews(v.views), fmtAgo(v.publishedAt)].filter(Boolean).join(" · ")}</div>
        ${opt.note ? `<div class="card-note">📝 ${esc(opt.note)}</div>` : ""}
      </div>
      <div class="card-actions">
        <button class="icon-btn${fav ? " fav-on" : ""}" data-act="fav" data-id="${esc(v.id)}" title="我的最愛">${fav ? "♥" : "♡"}</button>
        <button class="icon-btn" data-act="addcol" data-id="${esc(v.id)}" title="加入收藏夾">📁</button>
        <button class="icon-btn" data-act="watched" data-id="${esc(v.id)}" title="${w ? "標示為未看" : "標示為已看"}">✓</button>
        <span class="spacer"></span>
        ${opt.colId ? `<button class="icon-btn" data-act="note" data-id="${esc(v.id)}" data-col="${esc(opt.colId)}" title="備註">✎</button>
        <button class="icon-btn" data-act="colremove" data-id="${esc(v.id)}" data-col="${esc(opt.colId)}" title="從收藏夾移除">🗑</button>` :
        `<a class="icon-btn" href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener" title="在 YouTube 開啟">↗</a>`}
      </div>
    </article>`;
  }
  function sortVideos(list, mode) {
    const l = [...list];
    if (mode === "added") l.sort((a, b) => (b.addedAt || b.firstSeen || "").localeCompare(a.addedAt || a.firstSeen || ""));
    else if (mode === "views") l.sort((a, b) => (b.views || 0) - (a.views || 0));
    else if (mode === "duration") l.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    else l.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
    return l;
  }
  const visible = (list) => S.hideWatched ? list.filter((v) => !S.watched.has(v.id)) : list;
  function sortTools(addedLabel = "最新加入") {
    return `<select class="btn" data-act="sort" aria-label="排序">
        ${[["published", "最新發布"], ["added", addedLabel], ["views", "最多觀看"], ["duration", "片長最長"]].map(([k, l]) => `<option value="${k}"${S.sort === k ? " selected" : ""}>${l}</option>`).join("")}
      </select>
      <label class="check"><input type="checkbox" data-act="hidewatched"${S.hideWatched ? " checked" : ""}> 隱藏已看</label>`;
  }
  const emptyBox = (title, text) => `<div class="empty"><strong>${title}</strong>${text}</div>`;

  // ---------- 側欄 ----------
  function renderSidebar(active) {
    const counts = {};
    S.data.videos.forEach((v) => (v.cats || []).forEach((c) => counts[c] = (counts[c] || 0) + 1));
    $("#sidebar").innerHTML = S.config.groups.map((g) => `<div class="side-group">
        <h3>${esc(g.icon || "")} ${esc(g.name)}</h3>
        ${g.categories.map((c) => `<a class="side-link${active === c.id ? " active" : ""}" href="#/cat/${encodeURIComponent(c.id)}">
          <span>${esc(c.icon || "▪")}</span><span>${esc(c.name)}</span><span class="count">${counts[c.id] || 0}</span></a>`).join("")}
      </div>`).join("") + `<a class="side-link side-add" href="#/manage">＋ 新增／管理分類</a>`;
  }

  // ---------- 頁面 ----------
  function pageHome() {
    const vids = S.data.videos;
    if (!vids.length) return `<div class="page-head"><h1>歡迎回來</h1></div>` + emptyBox("還沒有影片資料",
      `請依照 README 的步驟申請 YouTube API Key、放進 GitHub Secrets，<br>再到 GitHub 的 Actions 頁面執行一次「自動更新影片」。<br><br><a class="btn primary" href="#/settings">前往設定</a>`);
    const latest = sortVideos(vids.filter((v) => v.firstSeen === S.data.updatedAt), "published").slice(0, 14);
    let html = `<div class="page-head"><h1>今天看點什麼？</h1>
      <div class="sub">共 ${vids.length} 部影片 · 上次更新 ${fmtDate(S.data.updatedAt)} · 每兩天自動更新</div></div>`;
    if (latest.length) html += `<div class="section-title">🆕 本次新加入</div><div class="row">${latest.map((v) => card(v)).join("")}</div>`;
    S.config.groups.forEach((g) => {
      html += `<h2 class="group-title">${esc(g.icon || "")} ${esc(g.name)}</h2>`;
      g.categories.forEach((c) => {
        const list = visible(sortVideos(vids.filter((v) => (v.cats || []).includes(c.id)), "published")).slice(0, 10);
        html += `<div class="section-title">${esc(c.icon || "")} ${esc(c.name)} <a href="#/cat/${encodeURIComponent(c.id)}">看全部 →</a></div>`;
        html += list.length ? `<div class="row">${list.map((v) => card(v)).join("")}</div>` : `<p class="card-meta">下次更新後會出現影片。</p>`;
      });
    });
    return html;
  }

  function pageCategory(id) {
    const c = catById(id);
    if (!c) return emptyBox("找不到這個分類", `<a href="#/">回首頁</a>`);
    const list = visible(sortVideos(S.data.videos.filter((v) => (v.cats || []).includes(id)), S.sort));
    const chans = (c.channels || []).map((x) => x.name).join("、");
    return `<div class="page-head"><h1>${esc(c.icon || "")} ${esc(c.name)}</h1>
        <div class="tools">${sortTools()}</div>
        <div class="sub">${esc(c.group.name)} · ${list.length} 部${chans ? " · 追蹤頻道：" + esc(chans) : ""}${(c.keywords || []).length ? " · 關鍵字：" + esc(c.keywords.join("、")) : ""}</div></div>
      ${list.length ? `<div class="grid">${list.map((v) => card(v)).join("")}</div>` : emptyBox("這裡還沒有影片", "下次自動更新後就會出現。")}`;
  }

  function pageFav() {
    const list = visible(sortVideos(S.fav.favorites.map((f) => ({ ...f, ...(S.byId.get(f.id) || {}), addedAt: f.addedAt })), S.sort));
    return `<div class="page-head"><h1>❤️ 我的最愛</h1><div class="tools">${sortTools("最近收藏")}</div>
        <div class="sub">${S.fav.favorites.length} 部影片${S.synced ? " · 已與 GitHub 同步" : ""}</div></div>
      ${list.length ? `<div class="grid">${list.map((v) => card(v, { keepBright: true })).join("")}</div>` : emptyBox("還沒有最愛的影片", "在任何影片卡片按 ♡ 就會出現在這裡。")}`;
  }

  function pageCollections() {
    const cols = S.fav.collections;
    return `<div class="page-head"><h1>📁 收藏夾</h1><div class="tools"><button class="btn primary" data-act="newcol">＋ 新增收藏夾</button></div>
        <div class="sub">把喜歡的影片分門別類存在一起，也可以貼上任何 YouTube 連結加入。</div></div>
      ${cols.length ? `<div class="col-grid">${cols.map((c) => {
        const th = c.videos.slice(0, 3).map((v) => `<img loading="lazy" src="${esc(v.thumb || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`)}" alt="">`).join("");
        return `<a class="col-card" href="#/col/${encodeURIComponent(c.id)}">
          <div class="col-cover${th ? "" : " empty-cover"}">${th || "📁"}</div>
          <div class="card-body"><h3>${esc(c.name)}</h3><div class="card-meta">${c.videos.length} 部影片${c.note ? " · " + esc(c.note) : ""}</div></div></a>`;
      }).join("")}</div>` : emptyBox("還沒有收藏夾", "按右上角「新增收藏夾」建立第一個，例如「週末看的鐵道」。")}`;
  }

  function pageCollection(id) {
    const c = S.fav.collections.find((x) => x.id === id);
    if (!c) return emptyBox("找不到這個收藏夾", `<a href="#/col">回收藏夾</a>`);
    const list = [...c.videos].reverse().map((v) => ({ ...v, ...(S.byId.get(v.id) || {}), note: v.note }));
    return `<div class="page-head"><h1>📁 ${esc(c.name)}</h1>
        <div class="tools"><button class="btn" data-act="addurl" data-col="${esc(c.id)}">＋ 貼上 YouTube 連結</button>
        <button class="btn" data-act="renamecol" data-col="${esc(c.id)}">重新命名</button>
        <button class="btn danger" data-act="delcol" data-col="${esc(c.id)}">刪除</button></div>
        <div class="sub"><a href="#/col">← 所有收藏夾</a> · ${c.videos.length} 部影片${c.note ? " · " + esc(c.note) : ""}</div></div>
      ${list.length ? `<div class="grid">${list.map((v) => card(v, { colId: c.id, note: v.note, keepBright: true })).join("")}</div>` : emptyBox("收藏夾是空的", "在影片卡片按 📁 加入，或貼上 YouTube 連結。")}`;
  }

  function pageSearch(q) {
    const k = q.toLowerCase().trim();
    const pool = new Map();
    [...S.data.videos, ...S.fav.favorites, ...S.fav.collections.flatMap((c) => c.videos)].forEach((v) => { if (!pool.has(v.id)) pool.set(v.id, v); });
    const list = visible(sortVideos([...pool.values()].filter((v) => (v.title + " " + v.channel).toLowerCase().includes(k)), S.sort));
    return `<div class="page-head"><h1>搜尋：「${esc(q)}」</h1><div class="tools">${sortTools()}</div><div class="sub">找到 ${list.length} 部</div></div>
      ${list.length ? `<div class="grid">${list.map((v) => card(v)).join("")}</div>` : emptyBox("找不到符合的影片", "試試其他關鍵字，或日文／英文名稱。")}`;
  }

  function pageSettings() {
    const g = S.gh, rep = S.data.channels || {};
    const theme = store.get("theme", "auto");
    const chRows = allCats().map((c) => {
      const r = rep[c.id] || [];
      const chs = r.length ? r.map((x) => x.ok ? `<span class="ch-ok">✓ ${esc(x.name)}</span>${x.title && x.title !== x.name ? `（${esc(x.title)}）` : ""}` : `<span class="ch-bad">✗ ${esc(x.name)}</span>`).join("<br>")
        : (c.channels || []).length ? `<span class="card-meta">尚未檢查</span>` : `<span class="card-meta">只用關鍵字</span>`;
      return `<tr><td>${esc(c.icon || "")} ${esc(c.name)}</td><td>${chs}</td></tr>`;
    }).join("");
    return `<div class="page-head"><h1>⚙️ 設定</h1></div>
      <section class="panel"><h2>GitHub 同步</h2>
        <p>連結後，我的最愛、收藏夾和分類設定會存回你的 GitHub repo，手機和電腦看到的都一樣。每台裝置第一次使用時輸入一次即可（Token 只存在這台裝置的瀏覽器）。</p>
        <form id="gh-form" class="form-grid">
          <label class="field"><span>GitHub 帳號</span><input name="owner" value="${esc(g.owner)}" placeholder="例如 jarcle" required></label>
          <label class="field"><span>Repo 名稱</span><input name="repo" value="${esc(g.repo)}" placeholder="youtube-library" required></label>
          <label class="field"><span>分支</span><input name="branch" value="${esc(g.branch || "main")}"></label>
          <label class="field"><span>Personal Access Token</span><input name="token" type="password" value="${esc(g.token)}" placeholder="github_pat_…" autocomplete="off"></label>
          <div class="inline" style="align-items:end"><button class="btn primary" type="submit">儲存並測試</button>
          ${g.token ? `<button class="btn" type="button" data-act="ghlogout">登出這台裝置</button>` : ""}</div>
        </form>
        <p style="margin-top:12px"><span class="status-dot ${S.synced ? "ok" : ghReady() ? "bad" : ""}"></span>${S.synced ? "已連線，收藏會自動同步" : ghReady() ? "設定了但無法連線，請檢查 Token" : "尚未連結"}</p>
      </section>
      <section class="panel"><h2>影片更新狀態</h2>
        <p>上次更新：${fmtDate(S.data.updatedAt)} · 共 ${S.data.total || 0} 部 · 本次用掉 ${S.data.quotaUsed ?? "—"} / 10,000 配額單位 · 每兩天早上 6 點自動更新</p>
        <div class="inline" style="margin-bottom:14px"><button class="btn primary" data-act="runnow"${ghReady() ? "" : " disabled"}>🔄 立即更新影片</button>
        <a class="btn" href="#/manage">管理分類與頻道</a></div>
        <table class="cat-table"><thead><tr><th>分類</th><th>追蹤頻道（✓ 找到 ✗ 找不到）</th></tr></thead><tbody>${chRows}</tbody></table>
        ${(S.data.log || []).length ? `<details style="margin-top:12px"><summary>更新紀錄</summary><div class="log">${esc(S.data.log.join("\n"))}</div></details>` : ""}
      </section>
      <section class="panel"><h2>外觀</h2>
        <div class="inline">${[["auto", "跟隨系統"], ["light", "亮色"], ["dark", "暗色"]].map(([k, l]) => `<button class="btn${theme === k ? " primary" : ""}" data-act="theme" data-theme="${k}">${l}</button>`).join("")}</div>
      </section>
      <section class="panel"><h2>備份</h2><p>把我的最愛和收藏夾下載成檔案，或從檔案匯入（匯入會合併，不會覆蓋）。</p>
        <div class="inline"><button class="btn" data-act="export">⬇ 匯出</button>
        <label class="btn">⬆ 匯入<input type="file" accept="application/json" data-act="import" hidden></label>
        <button class="btn" data-act="clearwatched">清除「已看」紀錄</button></div>
      </section>`;
  }

  function pageManage() {
    const rows = S.config.groups.map((g) => `<tr><th colspan="3" style="padding-top:18px">${esc(g.icon || "")} ${esc(g.name)}
        <button class="btn small" data-act="editgroup" data-group="${esc(g.id)}">改名</button>
        <button class="btn small" data-act="newcat" data-group="${esc(g.id)}">＋ 在此新增分類</button></th></tr>` +
      g.categories.map((c) => `<tr><td>${esc(c.icon || "")} ${esc(c.name)}</td>
        <td class="card-meta">${(c.channels || []).length} 個頻道 · ${(c.keywords || []).length} 個關鍵字</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn small" data-act="editcat" data-cat="${esc(c.id)}">編輯</button>
        <button class="btn small danger" data-act="delcat" data-cat="${esc(c.id)}">刪除</button></td></tr>`).join("")).join("");
    return `<div class="page-head"><h1>🗂 分類管理</h1><div class="tools"><button class="btn primary" data-act="newgroup">＋ 新增類型</button></div>
        <div class="sub">新增或修改後會存回 GitHub，下次更新（或按「立即更新」）時就會抓新分類的影片。</div></div>
      ${ghReady() ? "" : `<div class="panel"><p style="margin:0">⚠️ 需要先到 <a href="#/settings">設定</a> 連結 GitHub 才能儲存。也可以直接在 GitHub 網站編輯 <code>config/categories.json</code>。</p></div>`}
      <section class="panel"><table class="cat-table"><tbody>${rows}</tbody></table></section>`;
  }

  // ---------- 對話框 ----------
  function openModal(html, onSubmit) {
    const dlg = $("#modal"), form = $("#modal-form");
    form.innerHTML = html;
    form.onsubmit = async (e) => {
      const btn = e.submitter;
      if (!btn || btn.value !== "ok") return;
      e.preventDefault();
      const ok = await onSubmit(new FormData(form), form, btn);
      if (ok !== false) dlg.close();
    };
    dlg.showModal();
    const f = form.querySelector("input:not([type=hidden]),textarea"); if (f) f.focus();
  }
  const footer = (okLabel = "確定") => `<div class="foot"><button class="btn" value="cancel" formnovalidate>取消</button><button class="btn primary" value="ok">${okLabel}</button></div>`;

  function openColPicker(id) {
    const v = lookup(id); if (!v) return;
    const dlg = $("#col-picker"), form = $("#col-picker-form");
    const draw = () => {
      form.innerHTML = `<h2>加入收藏夾</h2><p>${esc(v.title)}</p>
        <div class="list">${S.fav.collections.map((c) => `<label><input type="checkbox" data-colpick="${esc(c.id)}"${c.videos.some((x) => x.id === id) ? " checked" : ""}> ${esc(c.name)} <span class="card-meta">（${c.videos.length}）</span></label>`).join("") || `<p>還沒有收藏夾，在下方建立一個。</p>`}</div>
        <div class="inline"><input class="btn" style="text-align:left;border-radius:10px" id="newcol-name" placeholder="新收藏夾名稱"><button class="btn" type="button" id="newcol-btn">建立</button></div>
        <div class="foot"><button class="btn primary" value="done">完成</button></div>`;
      form.querySelectorAll("[data-colpick]").forEach((cb) => cb.onchange = () => {
        const c = S.fav.collections.find((x) => x.id === cb.dataset.colpick);
        if (cb.checked) { if (!c.videos.some((x) => x.id === id)) c.videos.push({ ...snapshot(v), addedAt: new Date().toISOString(), note: "" }); }
        else c.videos = c.videos.filter((x) => x.id !== id);
        scheduleSave();
      });
      const make = () => {
        const name = $("#newcol-name").value.trim(); if (!name) return;
        S.fav.collections.push({ id: uid(), name, note: "", createdAt: new Date().toISOString(), videos: [{ ...snapshot(v), addedAt: new Date().toISOString(), note: "" }] });
        scheduleSave(); draw(); toast("已建立並加入「" + name + "」");
      };
      $("#newcol-btn").onclick = make;
      $("#newcol-name").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); make(); } };
    };
    draw();
    dlg.onclose = () => { if (/^#\/col/.test(location.hash)) render(); };
    dlg.showModal();
  }

  // ---------- 播放器 ----------
  function play(id) {
    const v = lookup(id) || { id, title: "", channel: "" };
    const embed = v.embeddable !== false;
    $("#player-frame").innerHTML = embed
      ? `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&playsinline=1" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="${esc(v.title)}"></iframe>`
      : `<div class="noembed"><div>🔒 這部影片的上傳者不允許在其他網站播放<br><br><a class="btn primary" href="https://www.youtube.com/watch?v=${esc(id)}" target="_blank" rel="noopener">到 YouTube 觀看</a></div></div>`;
    $("#player-info").innerHTML = `<h2>${esc(v.title)}</h2>
      <div class="card-meta">${esc(v.channel)} ${[fmtViews(v.views), fmtAgo(v.publishedAt)].filter(Boolean).map((x) => " · " + x).join("")}</div>
      <div class="actions">
        <button class="btn" data-act="fav" data-id="${esc(id)}">${isFav(id) ? "♥ 已在最愛" : "♡ 加入最愛"}</button>
        <button class="btn" data-act="addcol" data-id="${esc(id)}">📁 加入收藏夾</button>
        <a class="btn" href="https://www.youtube.com/watch?v=${esc(id)}" target="_blank" rel="noopener">↗ 在 YouTube 開啟</a>
        ${embed ? `<span class="card-meta" style="align-self:center">若顯示無法播放，請改用「在 YouTube 開啟」</span>` : ""}
      </div>`;
    $("#player").showModal();
    markWatched(id);
  }
  $("#player").addEventListener("close", () => { $("#player-frame").innerHTML = ""; });
  document.querySelectorAll("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));
  document.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) e.target.closest("dialog").close(); });

  // ---------- 分類設定（存回 GitHub） ----------
  async function saveConfig(msg) {
    if (!ghReady()) { toast("請先到設定連結 GitHub"); return false; }
    try {
      if (!S.configSha) { const r = await ghGetFile("config/categories.json"); S.configSha = r.sha; }
      S.configSha = await ghPutFile("config/categories.json", S.config, S.configSha, msg);
      toast("✅ 已儲存，下次更新會套用"); return true;
    } catch (e) { toast("儲存失敗：" + e.message); S.configSha = null; return false; }
  }
  const chToLine = (ch) => ch.id ? `${ch.name} | ${ch.id}` : ch.handle ? `${ch.name} | ${ch.handle}` : ch.query && ch.query !== ch.name ? `${ch.name} | ${ch.query}` : ch.name;
  function lineToCh(line) {
    const [name, extra] = line.split("|").map((s) => s.trim());
    if (!name) return null;
    const ch = { name };
    if (!extra) ch.query = name;
    else if (extra.startsWith("@")) ch.handle = extra;
    else if (/^UC[\w-]{22}$/.test(extra)) ch.id = extra;
    else ch.query = extra;
    return ch;
  }
  const lines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);

  function editCategory(catId, groupId) {
    const existing = catId ? catById(catId) : null;
    const c = existing || { name: "", icon: "", lang: "zh-Hant", recentDays: 0, keywords: [], channels: [], exclude: [] };
    const gid = existing ? existing.group.id : groupId;
    openModal(`<h2>${existing ? "編輯分類" : "新增分類"}</h2>
      <div class="form-grid">
        <label class="field"><span>名稱</span><input name="name" value="${esc(c.name)}" required></label>
        <label class="field"><span>圖示（一個表情符號）</span><input name="icon" value="${esc(c.icon || "")}" maxlength="4"></label>
        <label class="field"><span>所屬類型</span><select name="group">${S.config.groups.map((g) => `<option value="${esc(g.id)}"${g.id === gid ? " selected" : ""}>${esc(g.name)}</option>`).join("")}</select></label>
        <label class="field"><span>搜尋語言</span><select name="lang">${[["zh-Hant", "中文"], ["ja", "日文"], ["en", "英文"]].map(([k, l]) => `<option value="${k}"${c.lang === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      <label class="field"><span>只找最近幾天內的影片（0 = 不限，適合懷舊、歷史類）</span><input name="recentDays" type="number" min="0" value="${esc(c.recentDays ?? 0)}"></label>
      <label class="field"><span>關鍵字（一行一個，每個每次更新耗 100 配額）</span><textarea name="keywords">${esc((c.keywords || []).join("\n"))}</textarea></label>
      <label class="field"><span>追蹤頻道（一行一個；可寫「名稱」或「名稱 | @handle」或「名稱 | UC 開頭的頻道 ID」）</span><textarea name="channels">${esc((c.channels || []).map(chToLine).join("\n"))}</textarea></label>
      <label class="field"><span>排除字詞（標題含這些字就不要，一行一個）</span><textarea name="exclude" style="min-height:50px">${esc((c.exclude || []).join("\n"))}</textarea></label>
      ${footer("儲存")}`, async (fd) => {
      const data = {
        id: existing ? existing.id : "c-" + uid(),
        name: fd.get("name").trim(), icon: fd.get("icon").trim(), lang: fd.get("lang"),
        recentDays: Math.max(0, parseInt(fd.get("recentDays"), 10) || 0),
        keywords: lines(fd.get("keywords")), channels: lines(fd.get("channels")).map(lineToCh).filter(Boolean),
        exclude: lines(fd.get("exclude")),
      };
      if (!data.keywords.length && !data.channels.length) { toast("請至少填一個關鍵字或頻道"); return false; }
      const before = JSON.stringify(S.config);
      S.config.groups.forEach((g) => g.categories = g.categories.filter((x) => x.id !== data.id));
      const g = S.config.groups.find((x) => x.id === fd.get("group"));
      const oldIdx = existing ? existing.group.categories.findIndex((x) => x.id === data.id) : -1;
      if (existing && existing.group.id === g.id && oldIdx >= 0) g.categories.splice(oldIdx, 0, data); else g.categories.push(data);
      if (!(await saveConfig((existing ? "修改" : "新增") + "分類：" + data.name))) { S.config = JSON.parse(before); return false; }
      render();
    });
  }
  function editGroup(groupId) {
    const g = groupId ? S.config.groups.find((x) => x.id === groupId) : null;
    openModal(`<h2>${g ? "類型改名" : "新增類型"}</h2><p>例如「類型三：美食」「類型四：旅行」</p>
      <div class="form-grid"><label class="field"><span>名稱</span><input name="name" value="${esc(g ? g.name : "")}" required></label>
      <label class="field"><span>圖示</span><input name="icon" value="${esc(g ? g.icon || "" : "")}" maxlength="4"></label></div>
      ${g && !g.categories.length ? `<button class="btn danger" value="ok" name="del" data-del="1">刪除這個空的類型</button>` : ""}
      ${footer("儲存")}`, async (fd, form, btn) => {
      const before = JSON.stringify(S.config);
      if (btn.dataset.del) S.config.groups = S.config.groups.filter((x) => x !== g);
      else if (g) { g.name = fd.get("name").trim(); g.icon = fd.get("icon").trim(); }
      else S.config.groups.push({ id: "g-" + uid(), name: fd.get("name").trim(), icon: fd.get("icon").trim(), categories: [] });
      if (!(await saveConfig("更新類型"))) { S.config = JSON.parse(before); return false; }
      render();
    });
  }

  // ---------- 事件 ----------
  document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]"); if (!el || el.tagName === "SELECT" || el.type === "checkbox" || el.type === "file") return;
    const { act, id } = el.dataset;
    if (act === "play") { e.preventDefault(); play(id); }
    else if (act === "fav") toggleFav(id);
    else if (act === "addcol") openColPicker(id);
    else if (act === "watched") toggleWatched(id);
    else if (act === "newcol") openModal(`<h2>新增收藏夾</h2><label class="field"><span>名稱</span><input name="name" required placeholder="例如：週末看的鐵道"></label>
        <label class="field"><span>說明（可不填）</span><input name="note"></label>${footer("建立")}`, (fd) => {
      S.fav.collections.push({ id: uid(), name: fd.get("name").trim(), note: fd.get("note").trim(), createdAt: new Date().toISOString(), videos: [] });
      scheduleSave(); render();
    });
    else if (act === "renamecol") {
      const c = S.fav.collections.find((x) => x.id === el.dataset.col);
      openModal(`<h2>收藏夾設定</h2><label class="field"><span>名稱</span><input name="name" required value="${esc(c.name)}"></label>
        <label class="field"><span>說明</span><input name="note" value="${esc(c.note || "")}"></label>${footer("儲存")}`, (fd) => {
        c.name = fd.get("name").trim(); c.note = fd.get("note").trim(); scheduleSave(); render();
      });
    } else if (act === "delcol") {
      const c = S.fav.collections.find((x) => x.id === el.dataset.col);
      openModal(`<h2>刪除「${esc(c.name)}」？</h2><p>裡面的 ${c.videos.length} 部影片連結會一起移除（不影響我的最愛）。</p>${footer("刪除")}`, () => {
        S.fav.collections = S.fav.collections.filter((x) => x !== c); scheduleSave(); location.hash = "#/col";
      });
    } else if (act === "colremove") {
      const c = S.fav.collections.find((x) => x.id === el.dataset.col);
      c.videos = c.videos.filter((v) => v.id !== id); scheduleSave(); render(); toast("已從收藏夾移除");
    } else if (act === "note") {
      const c = S.fav.collections.find((x) => x.id === el.dataset.col), v = c.videos.find((x) => x.id === id);
      openModal(`<h2>備註</h2><p>${esc(v.title)}</p><label class="field"><span>寫點什麼，例如為什麼喜歡、第幾分鐘最精彩</span><textarea name="note">${esc(v.note || "")}</textarea></label>${footer("儲存")}`, (fd) => {
        v.note = fd.get("note").trim(); scheduleSave(); render();
      });
    } else if (act === "addurl") {
      const c = S.fav.collections.find((x) => x.id === el.dataset.col);
      openModal(`<h2>貼上 YouTube 連結</h2><label class="field"><span>影片網址</span><input name="url" required placeholder="https://www.youtube.com/watch?v=…"></label>
        <label class="field"><span>標題（可不填，會自動抓）</span><input name="title"></label>${footer("加入")}`, async (fd) => {
        const m = fd.get("url").match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/) || fd.get("url").trim().match(/^([\w-]{11})$/);
        if (!m) { toast("看不懂這個網址"); return false; }
        const vid = m[1];
        if (c.videos.some((x) => x.id === vid)) { toast("已經在收藏夾裡了"); return; }
        let title = fd.get("title").trim(), channel = "";
        const known = lookup(vid);
        if (known) { title = title || known.title; channel = known.channel; }
        if (!title) {
          try { const j = await (await fetch("https://noembed.com/embed?url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + vid))).json(); title = j.title || ""; channel = j.author_name || ""; } catch { }
        }
        c.videos.push({ id: vid, title: title || "YouTube 影片 " + vid, channel, thumb: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`, duration: known?.duration || 0, publishedAt: known?.publishedAt || "", embeddable: true, addedAt: new Date().toISOString(), note: "" });
        scheduleSave(); render(); toast("已加入");
      });
    } else if (act === "theme") { store.set("theme", el.dataset.theme); applyTheme(); render(); }
    else if (act === "ghlogout") { S.gh.token = ""; store.set("gh", S.gh); S.synced = false; toast("已登出"); render(); }
    else if (act === "export") {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(S.fav, null, 1)], { type: "application/json" }));
      a.download = "favorites-backup-" + new Date().toISOString().slice(0, 10) + ".json"; a.click();
    } else if (act === "clearwatched") { S.watched.clear(); store.set("watched", []); toast("已清除"); }
    else if (act === "runnow") {
      el.disabled = true;
      try {
        const r = await gh("/actions/workflows/update.yml/dispatches", { method: "POST", body: JSON.stringify({ ref: S.gh.branch || "main" }) });
        toast(r.status === 204 ? "🔄 已開始更新，約 1–3 分鐘後重新整理網頁" : "無法啟動（" + r.status + "），請確認 Token 有 Actions 權限");
      } catch (err) { toast("無法啟動：" + err.message); }
      el.disabled = false;
    } else if (act === "newgroup") editGroup(null);
    else if (act === "editgroup") editGroup(el.dataset.group);
    else if (act === "newcat") editCategory(null, el.dataset.group);
    else if (act === "editcat") editCategory(el.dataset.cat);
    else if (act === "delcat") {
      const c = catById(el.dataset.cat);
      openModal(`<h2>刪除分類「${esc(c.name)}」？</h2><p>下次更新後，這個分類的影片會從資料庫移除（我的最愛和收藏夾不受影響）。</p>${footer("刪除")}`, async () => {
        const before = JSON.stringify(S.config);
        S.config.groups.forEach((g) => g.categories = g.categories.filter((x) => x.id !== c.id));
        if (!(await saveConfig("刪除分類：" + c.name))) { S.config = JSON.parse(before); return false; }
        render();
      });
    }
  });

  document.addEventListener("change", async (e) => {
    const el = e.target;
    if (el.dataset.act === "sort") { S.sort = el.value; store.set("sort", S.sort); render(); }
    else if (el.dataset.act === "hidewatched") { S.hideWatched = el.checked; store.set("hideWatched", S.hideWatched); render(); }
    else if (el.dataset.act === "import" && el.files[0]) {
      try { const j = JSON.parse(await el.files[0].text()); S.fav = mergeFav(S.fav, j); scheduleSave(); toast("✅ 已匯入並合併"); render(); }
      catch { toast("檔案格式不對"); }
    }
  });

  document.addEventListener("submit", async (e) => {
    if (e.target.id === "search-form") {
      e.preventDefault(); const q = $("#search-input").value.trim();
      if (q) location.hash = "#/search/" + encodeURIComponent(q);
    } else if (e.target.id === "gh-form") {
      e.preventDefault();
      const fd = new FormData(e.target);
      S.gh = { owner: fd.get("owner").trim(), repo: fd.get("repo").trim(), branch: fd.get("branch").trim() || "main", token: fd.get("token").trim() };
      store.set("gh", S.gh);
      if (!S.gh.token) { toast("已儲存（沒有 Token，只能存在本機）"); return; }
      toast("連線中…");
      try {
        const r = await gh("");
        if (!r.ok) throw new Error(r.status === 401 ? "Token 無效" : r.status === 404 ? "找不到 repo，或 Token 沒有這個 repo 的權限" : "錯誤 " + r.status);
        const info = await r.json();
        if (!info.permissions?.push) throw new Error("Token 沒有寫入權限（Contents 要設 Read and write）");
        S.favSha = null; S.configSha = null;
        await loadFavorites();
        if (S.synced) { hideBanner(); toast("✅ 連線成功，收藏已同步"); }
        render();
      } catch (err) { S.synced = false; toast("❌ " + err.message); render(); }
    }
  });

  // ---------- 路由 ----------
  function render() {
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
    const [route, ...rest] = h.split("/"); const arg = rest.join("/");
    const nav = { "": "home", cat: "home", fav: "fav", col: "col", settings: "settings", manage: "settings", search: "home" }[route] || "home";
    document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === nav && route !== "cat" && route !== "search"));
    renderSidebar(route === "cat" ? arg : null);
    let html;
    if (route === "cat") html = pageCategory(arg);
    else if (route === "fav") html = pageFav();
    else if (route === "col" && arg) html = pageCollection(arg);
    else if (route === "col") html = pageCollections();
    else if (route === "search") { html = pageSearch(arg); $("#search-input").value = arg; }
    else if (route === "settings") html = pageSettings();
    else if (route === "manage") html = pageManage();
    else html = pageHome();
    const main = $("#main"); main.innerHTML = html;
  }
  window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });

  // ---------- 啟動 ----------
  async function boot() {
    $("#main").innerHTML = `<p class="card-meta">載入中…</p>`;
    try {
      const [cfg, data] = await Promise.all([
        fetch("config/categories.json?t=" + Date.now(), { cache: "no-store" }).then((r) => r.json()),
        fetch("data/videos.json?t=" + Date.now(), { cache: "no-store" }).then((r) => r.json()).catch(() => ({ videos: [] })),
      ]);
      S.config = cfg; S.data = data; S.data.videos = S.data.videos || [];
      S.data.videos.forEach((v) => S.byId.set(v.id, v));
    } catch (e) {
      $("#main").innerHTML = emptyBox("讀取資料失敗", "請確認 config/categories.json 格式正確。<br>" + esc(e.message)); return;
    }
    $("#updated-at").textContent = S.data.updatedAt ? "更新於 " + fmtAgo(S.data.updatedAt) : "尚未更新";
    await loadFavorites();
    render();
    // 回到網頁時，重新抓一次最愛（另一台裝置可能改過）
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible" && ghReady() && !saveTimer) { await loadFavorites(); if (!$("dialog[open]")) render(); }
    });
  }
  boot();
})();
