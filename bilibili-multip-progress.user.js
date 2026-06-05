// ==UserScript==
// @name         B站多P课程进度助手
// @namespace    https://github.com/Wan-JD/bilibili-multip-progress
// @version      1.1.0
// @description  多P视频课程进度追踪：分P列表、账号进度同步、剩余时长估算、一键续看
// @author       Wan-JD
// @license      MIT
// @homepageURL  https://github.com/Wan-JD/bilibili-multip-progress
// @supportURL   https://github.com/Wan-JD/bilibili-multip-progress/issues
// @contributionURL https://ifdian.net/a/jd0512
// @updateURL    https://github.com/Wan-JD/bilibili-multip-progress/raw/main/bilibili-multip-progress.user.js
// @downloadURL  https://github.com/Wan-JD/bilibili-multip-progress/raw/main/bilibili-multip-progress.user.js
// @match        *://www.bilibili.com/video/*
// @match        *://www.bilibili.com/list/*
// @connect      api.bilibili.com
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'bilibili_multip_progress';
  const COMPLETE_RATIO = 0.9;
  const STATUS = { UNWATCHED: 'unwatched', IN_PROGRESS: 'in_progress', COMPLETED: 'completed' };
  const STATUS_LABEL = {
    [STATUS.UNWATCHED]: '未看',
    [STATUS.IN_PROGRESS]: '进行中',
    [STATUS.COMPLETED]: '已完成',
  };
  const STATUS_CYCLE = [STATUS.UNWATCHED, STATUS.IN_PROGRESS, STATUS.COMPLETED];
  const STATUS_RANK = {
    [STATUS.UNWATCHED]: 0,
    [STATUS.IN_PROGRESS]: 1,
    [STATUS.COMPLETED]: 2,
  };

  let storageCache = null;
  let bvid = null;
  let aid = null;
  let pages = [];
  let currentPage = 1;
  let panelOpen = false;
  let accountSynced = false;
  let videoObserver = null;
  let attachedVideo = null;
  let pollTimer = null;
  let lastHref = location.href;
  const syncedBvids = new Set();

  // ─── Storage (Tampermonkey; survives clearing B站 site data) ─

  async function ensureStorage() {
    if (storageCache) return storageCache;

    let data = await GM_getValue(STORAGE_KEY, null);
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        data = null;
      }
    }
    if (!data || typeof data !== 'object') {
      data = {};
      try {
        const legacy = localStorage.getItem(STORAGE_KEY);
        if (legacy) {
          data = JSON.parse(legacy);
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch {
        data = {};
      }
    }

    storageCache = data;
    await GM_setValue(STORAGE_KEY, storageCache);
    return storageCache;
  }

  function persistStorage() {
    GM_setValue(STORAGE_KEY, storageCache).catch(() => {});
  }

  function getProgress(bv) {
    if (!storageCache) storageCache = {};
    if (!storageCache[bv]) storageCache[bv] = {};
    return storageCache[bv];
  }

  function getPartStatus(bv, pageNum) {
    return getProgress(bv)[String(pageNum)] || STATUS.UNWATCHED;
  }

  function setPartStatus(bv, pageNum, status) {
    getProgress(bv)[String(pageNum)] = status;
    persistStorage();
    renderPanel();
    updateFabBadge();
  }

  function pickStatus(a, b) {
    return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
  }

  function progressToStatus(progress, duration) {
    if (progress == null) return STATUS.UNWATCHED;
    if (progress === -1) return STATUS.COMPLETED;
    if (duration > 0 && progress >= duration * COMPLETE_RATIO) return STATUS.COMPLETED;
    if (progress > 3) return STATUS.IN_PROGRESS;
    return STATUS.UNWATCHED;
  }

  function cyclePartStatus(pageNum) {
    const cur = getPartStatus(bvid, pageNum);
    const idx = STATUS_CYCLE.indexOf(cur);
    const next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
    setPartStatus(bvid, pageNum, next);
  }

  // ─── URL / Page helpers ────────────────────────────────────

  function extractBvid() {
    const pathMatch = location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/i);
    if (pathMatch) return pathMatch[1];

    const params = new URLSearchParams(location.search);
    const fromQuery = params.get('bvid');
    if (fromQuery && /^BV/i.test(fromQuery)) return fromQuery;

    try {
      const state = window.__INITIAL_STATE__;
      if (state?.videoData?.bvid) return state.videoData.bvid;
      if (state?.video?.bvid) return state.video.bvid;
      if (state?.bvid) return state.bvid;
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function getCurrentPageFromUrl() {
    const p = parseInt(new URLSearchParams(location.search).get('p') || '1', 10);
    return Number.isFinite(p) && p > 0 ? p : 1;
  }

  function formatDuration(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function sumRemainingSeconds() {
    let total = 0;
    for (const pg of pages) {
      const st = getPartStatus(bvid, pg.page);
      if (st !== STATUS.COMPLETED) total += pg.duration || 0;
    }
    return total;
  }

  function countCompleted() {
    return pages.filter((pg) => getPartStatus(bvid, pg.page) === STATUS.COMPLETED).length;
  }

  function firstIncompletePage() {
    const found = pages.find((pg) => getPartStatus(bvid, pg.page) !== STATUS.COMPLETED);
    return found ? found.page : null;
  }

  function partUrl(pageNum) {
    const base = location.pathname.match(/\/video\/BV[a-zA-Z0-9]+/i);
    if (base) return `${location.origin}${base[0]}?p=${pageNum}`;
    return `${location.origin}/video/${bvid}?p=${pageNum}`;
  }

  // ─── API ───────────────────────────────────────────────────

  async function fetchPages(bv) {
    const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bv)}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== 0 || !json.data) throw new Error(json.message || 'API 错误');
    return {
      aid: json.data.aid,
      pages: (json.data.pages || []).map((p) => ({
        page: p.page,
        cid: p.cid,
        title: p.part || p.title || `P${p.page}`,
        duration: p.duration || 0,
      })),
    };
  }

  async function fetchHistoryProgressMap(bv) {
    const map = new Map();
    let viewAt = 0;
    const maxRounds = 15;

    for (let round = 0; round < maxRounds; round++) {
      const url =
        `https://api.bilibili.com/x/web-interface/history/cursor?max=30&view_at=${viewAt}&business=archive`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) break;
      const json = await res.json();
      if (json.code === -101) return map;
      if (json.code !== 0) break;

      const list = json.data?.list || [];
      if (!list.length) break;

      for (const item of list) {
        const h = item.history || item;
        const itemBvid = h.bvid || item.bvid;
        if (itemBvid !== bv) continue;
        const page = h.page || item.page;
        const progress = h.progress ?? item.progress;
        if (!page || progress == null) continue;
        map.set(page, Math.max(map.get(page) || 0, progress));
      }

      if (!json.data?.has_more) break;
      const nextViewAt = json.data?.cursor?.view_at ?? list[list.length - 1]?.view_at;
      if (!nextViewAt || nextViewAt === viewAt) break;
      viewAt = nextViewAt;
    }

    return map;
  }

  async function fetchCidProgress(videoAid, cid) {
    const url =
      `https://api.bilibili.com/x/click-interface/web/history?aid=${videoAid}&cid=${cid}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 0 || json.data == null) return null;
    const progress = json.data.progress ?? json.data;
    return typeof progress === 'number' ? progress : null;
  }

  async function runPool(items, limit, worker) {
    const queue = [...items];
    const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        await worker(item);
      }
    });
    await Promise.all(runners);
  }

  async function syncFromAccount(videoAid, bv, pageList) {
    if (!videoAid || !pageList.length) return { changed: false, foundAny: false };

    const historyMap = await fetchHistoryProgressMap(bv);
    const cidProgress = new Map();

    const missing = pageList.filter((pg) => !historyMap.has(pg.page));
    await runPool(missing, 4, async (pg) => {
      const progress = await fetchCidProgress(videoAid, pg.cid);
      if (progress != null) cidProgress.set(pg.page, progress);
    });

    let changed = false;
    let foundAny = false;
    const local = getProgress(bv);

    for (const pg of pageList) {
      const progress = historyMap.has(pg.page) ? historyMap.get(pg.page) : cidProgress.get(pg.page);
      if (progress == null) continue;

      foundAny = true;
      const serverSt = progressToStatus(progress, pg.duration);
      const localSt = local[String(pg.page)] || STATUS.UNWATCHED;
      const merged = pickStatus(localSt, serverSt);
      if (merged !== localSt) {
        local[String(pg.page)] = merged;
        changed = true;
      }
    }

    if (changed) persistStorage();
    return { changed, foundAny };
  }

  // ─── Video tracking ────────────────────────────────────────

  function findVideo() {
    return (
      document.querySelector('.bpx-player-container video') ||
      document.querySelector('#bilibili-player video') ||
      document.querySelector('video')
    );
  }

  function markCurrentInProgress() {
    if (!bvid || !pages.length) return;
    const st = getPartStatus(bvid, currentPage);
    if (st === STATUS.COMPLETED) return;
    if (st !== STATUS.IN_PROGRESS) setPartStatus(bvid, currentPage, STATUS.IN_PROGRESS);
  }

  function markCurrentCompleted() {
    if (!bvid) return;
    setPartStatus(bvid, currentPage, STATUS.COMPLETED);
  }

  function onVideoTimeUpdate() {
    if (!attachedVideo || !bvid) return;
    const { currentTime, duration } = attachedVideo;
    if (!duration || duration <= 0) return;
    if (currentTime / duration >= COMPLETE_RATIO) markCurrentCompleted();
  }

  function onVideoEnded() {
    markCurrentCompleted();
  }

  function onVideoPlay() {
    markCurrentInProgress();
  }

  function detachVideo() {
    if (!attachedVideo) return;
    attachedVideo.removeEventListener('timeupdate', onVideoTimeUpdate);
    attachedVideo.removeEventListener('ended', onVideoEnded);
    attachedVideo.removeEventListener('play', onVideoPlay);
    attachedVideo = null;
  }

  function attachVideo() {
    const video = findVideo();
    if (!video || video === attachedVideo) return;
    detachVideo();
    attachedVideo = video;
    video.addEventListener('timeupdate', onVideoTimeUpdate);
    video.addEventListener('ended', onVideoEnded);
    video.addEventListener('play', onVideoPlay);
    if (!video.paused) markCurrentInProgress();
  }

  function startVideoWatch() {
    attachVideo();
    if (videoObserver) return;
    videoObserver = new MutationObserver(() => attachVideo());
    videoObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopVideoWatch() {
    if (videoObserver) {
      videoObserver.disconnect();
      videoObserver = null;
    }
    detachVideo();
  }

  // ─── UI ────────────────────────────────────────────────────

  GM_addStyle(`
    #bmpv-fab {
      position: fixed; right: 16px; top: 50%; z-index: 2147483646;
      transform: translateY(-50%);
      width: 44px; height: 44px; border-radius: 50%; border: none;
      background: linear-gradient(135deg, #fb7299, #f25d8e);
      color: #fff; font-size: 18px; box-shadow: 0 4px 16px rgba(251,114,153,.45);
      transition: transform .15s ease, box-shadow .15s ease;
    }
    #bmpv-fab:hover { transform: translateY(-50%) scale(1.06); }
    #bmpv-fab .bmpv-badge {
      position: absolute; top: -5px; right: -5px;
      min-width: 18px; height: 18px; padding: 0 4px;
      border-radius: 9px; background: #2563eb; color: #fff;
      font-size: 10px; font-weight: 700; line-height: 18px; text-align: center;
    }
    #bmpv-panel {
      position: fixed; right: 68px; top: 50%; z-index: 2147483646;
      transform: translateY(-50%);
      width: min(380px, calc(100vw - 90px)); height: min(78vh, 640px);
      display: none; flex-direction: column;
      background: #0f172a; color: #e2e8f0; border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.4);
      font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      overflow: hidden; min-height: 0;
    }
    #bmpv-panel.open { display: flex; }
    .bmpv-hdr {
      padding: 12px 14px; border-bottom: 1px solid #334155;
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    .bmpv-hdr-title { font-weight: 600; font-size: 14px; }
    .bmpv-hdr-close {
      background: #1e293b; border: none; color: #94a3b8;
      width: 28px; height: 28px; border-radius: 6px; font-size: 16px;
    }
    .bmpv-hdr-close:hover { background: #334155; color: #e2e8f0; }
    .bmpv-summary {
      flex-shrink: 0;
      padding: 10px 14px; background: #1e293b; border-bottom: 1px solid #334155;
      font-size: 12px; color: #94a3b8;
    }
    .bmpv-summary strong { color: #f8fafc; }
    .bmpv-actions { flex-shrink: 0; padding: 8px 14px; border-bottom: 1px solid #334155; }
    .bmpv-btn {
      display: block; width: 100%; margin: 4px 0; padding: 8px 10px;
      border: none; border-radius: 8px; font-size: 13px;
      background: #1e293b; color: #e2e8f0; text-align: center;
    }
    .bmpv-btn:hover { background: #334155; }
    .bmpv-btn.primary { background: #2563eb; color: #fff; }
    .bmpv-btn.primary:hover { background: #1d4ed8; }
    .bmpv-body {
      flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
    }
    .bmpv-list {
      flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
      padding: 6px 6px 10px 8px; overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: thin;
      scrollbar-color: rgba(51, 65, 85, 0.55) transparent;
    }
    .bmpv-list::-webkit-scrollbar {
      width: 3px;
    }
    .bmpv-list::-webkit-scrollbar-track {
      background: transparent;
      margin: 4px 0;
    }
    .bmpv-list::-webkit-scrollbar-thumb {
      background: rgba(51, 65, 85, 0.45);
      border-radius: 999px;
      transition: background 0.2s ease;
    }
    .bmpv-list:hover::-webkit-scrollbar-thumb {
      background: rgba(71, 85, 105, 0.7);
    }
    .bmpv-list::-webkit-scrollbar-thumb:active {
      background: rgba(100, 116, 139, 0.85);
    }
    .bmpv-row {
      display: grid; grid-template-columns: 36px 1fr auto auto;
      gap: 6px; align-items: center;
      padding: 8px 6px; border-radius: 8px; margin-bottom: 2px;
    }
    .bmpv-row:hover { background: #1e293b; }
    .bmpv-row.current { background: #172554; outline: 1px solid #3b82f6; }
    .bmpv-pnum { font-weight: 600; color: #fb7299; font-size: 12px; text-align: center; }
    .bmpv-ptitle {
      font-size: 12px; color: #e2e8f0; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
    }
    .bmpv-pdur { font-size: 11px; color: #64748b; white-space: nowrap; }
    .bmpv-status {
      font-size: 11px; padding: 2px 6px; border-radius: 4px; border: none;
      white-space: nowrap;
    }
    .bmpv-status.unwatched { background: #334155; color: #94a3b8; }
    .bmpv-status.in_progress { background: #1e3a5f; color: #7dd3fc; }
    .bmpv-status.completed { background: #14532d; color: #86efac; }
    .bmpv-status:hover { filter: brightness(1.1); }
    .bmpv-foot {
      flex-shrink: 0;
      padding: 8px 14px 10px; border-top: 1px solid #334155;
      text-align: center; font-size: 11px; color: #64748b;
    }
    .bmpv-foot a { color: #7dd3fc; text-decoration: none; }
    .bmpv-foot a:hover { text-decoration: underline; }
    .bmpv-empty { padding: 20px 14px; text-align: center; color: #64748b; font-size: 12px; }
    .bmpv-loading { padding: 20px 14px; text-align: center; color: #94a3b8; font-size: 12px; }
  `);

  function ensureUI() {
    if (document.getElementById('bmpv-fab')) return;

    const fab = document.createElement('button');
    fab.id = 'bmpv-fab';
    fab.type = 'button';
    fab.title = '多P课程进度';
    fab.innerHTML = 'P<span class="bmpv-badge" id="bmpv-badge" style="display:none"></span>';
    fab.addEventListener('click', () => {
      panelOpen = !panelOpen;
      document.getElementById('bmpv-panel')?.classList.toggle('open', panelOpen);
    });

    const panel = document.createElement('div');
    panel.id = 'bmpv-panel';
    panel.innerHTML = `
      <div class="bmpv-hdr">
        <span class="bmpv-hdr-title">多P课程进度</span>
        <button type="button" class="bmpv-hdr-close" id="bmpv-close" title="收起">×</button>
      </div>
      <div id="bmpv-content" class="bmpv-loading">加载中…</div>
    `;

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    document.getElementById('bmpv-close').addEventListener('click', () => {
      panelOpen = false;
      panel.classList.remove('open');
    });

    panel.addEventListener(
      'wheel',
      (e) => {
        const list = e.target.closest('.bmpv-list');
        if (!list) return;
        const { scrollTop, scrollHeight, clientHeight } = list;
        const delta = e.deltaY;
        const atTop = scrollTop <= 0;
        const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
        if ((delta < 0 && atTop) || (delta > 0 && atBottom)) return;
        e.stopPropagation();
      },
      { passive: true }
    );
  }

  function hideUI() {
    document.getElementById('bmpv-fab')?.remove();
    document.getElementById('bmpv-panel')?.remove();
    panelOpen = false;
  }

  function updateFabBadge() {
    const badge = document.getElementById('bmpv-badge');
    if (!badge || !pages.length) return;
    const done = countCompleted();
    const total = pages.length;
    badge.textContent = `${done}/${total}`;
    badge.style.display = total > 1 ? 'block' : 'none';
  }

  function renderPanel() {
    const content = document.getElementById('bmpv-content');
    if (!content) return;

    if (!pages.length) {
      content.className = 'bmpv-empty';
      content.textContent = '暂无分P数据';
      return;
    }

    if (pages.length === 1) {
      content.className = 'bmpv-empty';
      content.innerHTML = '当前视频仅 1 P，无需追踪多P进度。';
      updateFabBadge();
      return;
    }

    const done = countCompleted();
    const remain = sumRemainingSeconds();

    content.className = 'bmpv-body';
    const syncHint = accountSynced ? ' · 已合并账号观看记录' : '';

    content.innerHTML = `
      <div class="bmpv-summary">
        共 <strong>${pages.length}</strong> P · 已完成 <strong>${done}</strong> ·
        预计剩余 <strong>${formatDuration(remain)}</strong>${syncHint}
      </div>
      <div class="bmpv-actions">
        <button type="button" class="bmpv-btn primary" id="bmpv-continue">从第一个未完成的P继续</button>
      </div>
      <div class="bmpv-list" id="bmpv-list"></div>
      <div class="bmpv-foot">
        <a href="https://ifdian.net/a/jd0512" target="_blank" rel="noopener">支持作者</a>
      </div>
    `;

    const list = document.getElementById('bmpv-list');
    for (const pg of pages) {
      const st = getPartStatus(bvid, pg.page);
      const row = document.createElement('div');
      row.className = 'bmpv-row' + (pg.page === currentPage ? ' current' : '');
      row.innerHTML = `
        <span class="bmpv-pnum">P${pg.page}</span>
        <span class="bmpv-ptitle" title="${escapeHtml(pg.title)}">${escapeHtml(pg.title)}</span>
        <span class="bmpv-pdur">${formatDuration(pg.duration)}</span>
        <button type="button" class="bmpv-status ${st}" data-page="${pg.page}">${STATUS_LABEL[st]}</button>
      `;
      row.querySelector('.bmpv-ptitle').addEventListener('click', () => {
        if (pg.page !== currentPage) location.href = partUrl(pg.page);
      });
      row.querySelector('.bmpv-status').addEventListener('click', (e) => {
        e.stopPropagation();
        cyclePartStatus(pg.page);
      });
      list.appendChild(row);
    }

    document.getElementById('bmpv-continue')?.addEventListener('click', () => {
      const target = firstIncompletePage();
      if (!target) return;
      if (target === currentPage) {
        const video = findVideo();
        if (video) {
          video.currentTime = 0;
          video.play().catch(() => {});
        }
        return;
      }
      location.href = partUrl(target);
    });

    updateFabBadge();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Init / SPA navigation ─────────────────────────────────

  async function init() {
    await ensureStorage();

    const bv = extractBvid();
    if (!bv) {
      hideUI();
      stopVideoWatch();
      return;
    }

    if (bv === bvid && location.href === lastHref && pages.length) {
      currentPage = getCurrentPageFromUrl();
      renderPanel();
      attachVideo();
      return;
    }

    lastHref = location.href;
    bvid = bv;
    aid = null;
    accountSynced = false;
    currentPage = getCurrentPageFromUrl();
    pages = [];

    ensureUI();
    const content = document.getElementById('bmpv-content');
    if (content) {
      content.className = 'bmpv-loading';
      content.textContent = '加载分P列表…';
    }

    try {
      const meta = await fetchPages(bvid);
      aid = meta.aid;
      pages = meta.pages;
    } catch (err) {
      if (content) {
        content.className = 'bmpv-empty';
        content.textContent = `加载失败：${err.message || '未知错误'}`;
      }
      return;
    }

    if (pages.length <= 1) {
      ensureUI();
      renderPanel();
      document.getElementById('bmpv-fab').style.opacity = '0.55';
      stopVideoWatch();
      return;
    }

    if (!syncedBvids.has(bvid)) {
      if (content) content.textContent = '同步账号观看记录…';
      try {
        const sync = await syncFromAccount(aid, bvid, pages);
        accountSynced = sync.foundAny;
      } catch {
        accountSynced = false;
      }
      syncedBvids.add(bvid);
    }

    document.getElementById('bmpv-fab').style.opacity = '1';
    renderPanel();
    startVideoWatch();
    attachVideo();
    markCurrentInProgress();
  }

  function watchNavigation() {
    const check = () => {
      if (location.href !== lastHref) init();
    };
    window.addEventListener('popstate', check);
    const wrap = (fn) => function (...args) {
      const ret = fn.apply(this, args);
      setTimeout(check, 0);
      return ret;
    };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(check, 1500);
  }

  function bootstrap() {
    const start = () => {
      init().catch(() => {});
      watchNavigation();
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }

  bootstrap();
})();
