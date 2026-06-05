// ==UserScript==
// @name         B站多P课程进度助手
// @namespace    https://github.com/Wan-JD/bilibili-multip-progress
// @version      1.1.3
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
  const THEME_KEY = 'bilibili_multip_progress_theme';
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
  let uiTheme = 'dark';
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

  const THEME_PALETTE = {
    dark: {
      '--bmpv-bg': '#0f172a',
      '--bmpv-text': '#e2e8f0',
      '--bmpv-border': '#334155',
      '--bmpv-surface': '#1e293b',
      '--bmpv-surface-hover': '#334155',
      '--bmpv-muted': '#94a3b8',
      '--bmpv-strong': '#f8fafc',
      '--bmpv-dim': '#64748b',
      '--bmpv-row-hover': '#1e293b',
      '--bmpv-row-current-bg': '#172554',
      '--bmpv-row-current-outline': '#3b82f6',
      '--bmpv-scroll-track': 'rgba(51, 65, 85, 0.55)',
      '--bmpv-scroll-thumb': 'rgba(51, 65, 85, 0.45)',
      '--bmpv-scroll-thumb-hover': 'rgba(71, 85, 105, 0.7)',
      '--bmpv-scroll-thumb-active': 'rgba(100, 116, 139, 0.85)',
      '--bmpv-st-unwatched-bg': '#334155',
      '--bmpv-st-unwatched-fg': '#94a3b8',
      '--bmpv-st-progress-bg': '#1e3a5f',
      '--bmpv-st-progress-fg': '#7dd3fc',
      '--bmpv-st-done-bg': '#14532d',
      '--bmpv-st-done-fg': '#86efac',
      '--bmpv-link': '#7dd3fc',
      '--bmpv-shadow': 'rgba(0,0,0,.4)',
    },
    light: {
      '--bmpv-bg': '#ffffff',
      '--bmpv-text': '#18191c',
      '--bmpv-border': '#e3e5e7',
      '--bmpv-surface': '#f1f2f3',
      '--bmpv-surface-hover': '#e3e5e7',
      '--bmpv-muted': '#61666d',
      '--bmpv-strong': '#18191c',
      '--bmpv-dim': '#9499a0',
      '--bmpv-row-hover': '#f6f7f8',
      '--bmpv-row-current-bg': '#e8f3ff',
      '--bmpv-row-current-outline': '#00a1d6',
      '--bmpv-scroll-track': 'rgba(148, 153, 160, 0.45)',
      '--bmpv-scroll-thumb': 'rgba(148, 153, 160, 0.35)',
      '--bmpv-scroll-thumb-hover': 'rgba(148, 153, 160, 0.55)',
      '--bmpv-scroll-thumb-active': 'rgba(97, 102, 109, 0.65)',
      '--bmpv-st-unwatched-bg': '#e3e5e7',
      '--bmpv-st-unwatched-fg': '#61666d',
      '--bmpv-st-progress-bg': '#d6ebff',
      '--bmpv-st-progress-fg': '#0066cc',
      '--bmpv-st-done-bg': '#d9f2e5',
      '--bmpv-st-done-fg': '#1a7f4b',
      '--bmpv-link': '#00a1d6',
      '--bmpv-shadow': 'rgba(0,0,0,.12)',
    },
  };

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

  async function loadTheme() {
    const saved = await GM_getValue(THEME_KEY, 'dark');
    uiTheme = saved === 'light' ? 'light' : 'dark';
    applyTheme();
  }

  function setTheme(theme) {
    uiTheme = theme === 'light' ? 'light' : 'dark';
    GM_setValue(THEME_KEY, uiTheme).catch(() => {});
    applyTheme();
  }

  function toggleTheme() {
    const list = document.getElementById('bmpv-list');
    const scrollTop = list?.scrollTop ?? 0;
    setTheme(uiTheme === 'dark' ? 'light' : 'dark');
    const content = document.getElementById('bmpv-content');
    if (pages.length > 1 && content?.classList.contains('bmpv-body')) {
      renderPanel();
      const list2 = document.getElementById('bmpv-list');
      if (list2) list2.scrollTop = scrollTop;
    }
  }

  function applyTheme() {
    const panel = document.getElementById('bmpv-panel');
    const fab = document.getElementById('bmpv-fab');
    const isLight = uiTheme === 'light';
    const palette = isLight ? THEME_PALETTE.light : THEME_PALETTE.dark;

    if (panel) {
      panel.dataset.theme = uiTheme;
      for (const [key, value] of Object.entries(palette)) {
        panel.style.setProperty(key, value);
      }
    }
    if (fab) {
      fab.dataset.theme = uiTheme;
      fab.style.boxShadow = isLight
        ? '0 4px 14px rgba(251,114,153,.35)'
        : '0 4px 16px rgba(251,114,153,.45)';
    }
    const btn = panel?.querySelector('#bmpv-theme-btn');
    if (btn) {
      btn.textContent = isLight ? '暗' : '明';
      btn.title = isLight ? '切换为深色' : '切换为浅色';
    }
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
      background: var(--bmpv-bg, #0f172a);
      color: var(--bmpv-text, #e2e8f0);
      border-radius: 12px;
      box-shadow: 0 12px 40px var(--bmpv-shadow, rgba(0,0,0,.4));
      font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      overflow: hidden; min-height: 0;
      transition: background-color .2s ease, color .2s ease, box-shadow .2s ease;
    }
    #bmpv-panel.open { display: flex; }
    #bmpv-panel .bmpv-hdr {
      padding: 12px 14px; border-bottom: 1px solid var(--bmpv-border, #334155);
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    #bmpv-panel .bmpv-hdr-title { font-weight: 600; font-size: 14px; flex: 1; min-width: 0; }
    #bmpv-panel .bmpv-hdr-actions {
      display: flex; align-items: center; gap: 6px; flex-shrink: 0;
      position: relative; z-index: 2;
    }
    #bmpv-panel .bmpv-hdr-btn,
    #bmpv-panel .bmpv-hdr-close {
      background: var(--bmpv-surface, #1e293b); border: none;
      color: var(--bmpv-muted, #94a3b8);
      height: 28px; border-radius: 6px; font-size: 13px; line-height: 28px; padding: 0;
    }
    #bmpv-panel .bmpv-hdr-btn { width: 28px; }
    #bmpv-panel .bmpv-hdr-close { width: 28px; font-size: 16px; }
    #bmpv-panel .bmpv-hdr-btn:hover,
    #bmpv-panel .bmpv-hdr-close:hover {
      background: var(--bmpv-surface-hover, #334155); color: var(--bmpv-text, #e2e8f0);
    }
    #bmpv-panel .bmpv-summary {
      flex-shrink: 0;
      padding: 10px 14px; background: var(--bmpv-surface, #1e293b);
      border-bottom: 1px solid var(--bmpv-border, #334155);
      font-size: 12px; color: var(--bmpv-muted, #94a3b8);
    }
    #bmpv-panel .bmpv-summary strong { color: var(--bmpv-strong, #f8fafc); }
    #bmpv-panel .bmpv-actions {
      flex-shrink: 0; padding: 8px 14px;
      border-bottom: 1px solid var(--bmpv-border, #334155);
    }
    #bmpv-panel .bmpv-btn {
      display: block; width: 100%; margin: 4px 0; padding: 8px 10px;
      border: none; border-radius: 8px; font-size: 13px;
      background: var(--bmpv-surface, #1e293b); color: var(--bmpv-text, #e2e8f0); text-align: center;
    }
    #bmpv-panel .bmpv-btn:hover { background: var(--bmpv-surface-hover, #334155); }
    #bmpv-panel .bmpv-btn.primary { background: #2563eb; color: #fff; }
    #bmpv-panel .bmpv-btn.primary:hover { background: #1d4ed8; }
    #bmpv-panel .bmpv-body {
      flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
    }
    #bmpv-panel .bmpv-list {
      flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
      padding: 6px 6px 10px 8px; overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: thin;
      scrollbar-color: var(--bmpv-scroll-track, rgba(51,65,85,.55)) transparent;
    }
    #bmpv-panel .bmpv-list::-webkit-scrollbar { width: 3px; }
    #bmpv-panel .bmpv-list::-webkit-scrollbar-track { background: transparent; margin: 4px 0; }
    #bmpv-panel .bmpv-list::-webkit-scrollbar-thumb {
      background: var(--bmpv-scroll-thumb, rgba(51,65,85,.45));
      border-radius: 999px; transition: background 0.2s ease;
    }
    #bmpv-panel .bmpv-list:hover::-webkit-scrollbar-thumb {
      background: var(--bmpv-scroll-thumb-hover, rgba(71,85,105,.7));
    }
    #bmpv-panel .bmpv-list::-webkit-scrollbar-thumb:active {
      background: var(--bmpv-scroll-thumb-active, rgba(100,116,139,.85));
    }
    #bmpv-panel .bmpv-row {
      display: grid; grid-template-columns: 36px 1fr auto auto;
      gap: 6px; align-items: center;
      padding: 8px 6px; border-radius: 8px; margin-bottom: 2px;
    }
    #bmpv-panel .bmpv-row:hover { background: var(--bmpv-row-hover, #1e293b); }
    #bmpv-panel .bmpv-row.current {
      background: var(--bmpv-row-current-bg, #172554);
      outline: 1px solid var(--bmpv-row-current-outline, #3b82f6);
    }
    #bmpv-panel .bmpv-pnum { font-weight: 600; color: #fb7299; font-size: 12px; text-align: center; }
    #bmpv-panel .bmpv-ptitle {
      font-size: 12px; color: var(--bmpv-text, #e2e8f0); overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
    }
    #bmpv-panel .bmpv-pdur { font-size: 11px; color: var(--bmpv-dim, #64748b); white-space: nowrap; }
    #bmpv-panel .bmpv-status {
      font-size: 11px; padding: 2px 6px; border-radius: 4px; border: none;
      white-space: nowrap;
    }
    #bmpv-panel .bmpv-status.unwatched {
      background: var(--bmpv-st-unwatched-bg, #334155); color: var(--bmpv-st-unwatched-fg, #94a3b8);
    }
    #bmpv-panel .bmpv-status.in_progress {
      background: var(--bmpv-st-progress-bg, #1e3a5f); color: var(--bmpv-st-progress-fg, #7dd3fc);
    }
    #bmpv-panel .bmpv-status.completed {
      background: var(--bmpv-st-done-bg, #14532d); color: var(--bmpv-st-done-fg, #86efac);
    }
    #bmpv-panel .bmpv-status:hover { filter: brightness(1.08); }
    #bmpv-panel .bmpv-foot {
      flex-shrink: 0;
      padding: 8px 14px 10px; border-top: 1px solid var(--bmpv-border, #334155);
      text-align: center; font-size: 11px; color: var(--bmpv-dim, #64748b);
    }
    #bmpv-panel .bmpv-foot a { color: var(--bmpv-link, #7dd3fc); text-decoration: none; }
    #bmpv-panel .bmpv-foot a:hover { text-decoration: underline; }
    #bmpv-panel .bmpv-empty,
    #bmpv-panel .bmpv-loading {
      padding: 20px 14px; text-align: center;
      color: var(--bmpv-dim, #64748b); font-size: 12px;
    }
    #bmpv-panel .bmpv-loading { color: var(--bmpv-muted, #94a3b8); }
  `);

  function upgradePanelHeader(panel) {
    const hdr = panel.querySelector('.bmpv-hdr');
    if (!hdr) return;

    if (!hdr.querySelector('#bmpv-theme-btn')) {
      let actions = hdr.querySelector('.bmpv-hdr-actions');
      const close = hdr.querySelector('#bmpv-close');
      if (!actions) {
        actions = document.createElement('div');
        actions.className = 'bmpv-hdr-actions';
        if (close) {
          close.remove();
          actions.appendChild(close);
        }
        hdr.appendChild(actions);
      }
      const themeBtn = document.createElement('button');
      themeBtn.type = 'button';
      themeBtn.className = 'bmpv-hdr-btn';
      themeBtn.id = 'bmpv-theme-btn';
      themeBtn.textContent = '明';
      themeBtn.title = '切换为浅色';
      actions.insertBefore(themeBtn, actions.firstChild);
    }
  }

  function wirePanelEvents(fab, panel) {
    if (!fab.dataset.bmpvFabWired) {
      fab.dataset.bmpvFabWired = '1';
      fab.addEventListener('click', (e) => {
        e.stopPropagation();
        panelOpen = !panelOpen;
        panel.classList.toggle('open', panelOpen);
      });
    }

    if (panel.dataset.bmpvPanelWired !== '2') {
      panel.dataset.bmpvPanelWired = '2';

      const themeBtn = panel.querySelector('#bmpv-theme-btn');
      if (themeBtn) themeBtn.replaceWith(themeBtn.cloneNode(true));

      panel.addEventListener(
        'click',
        (e) => {
          if (e.target.closest('#bmpv-theme-btn')) {
            e.preventDefault();
            e.stopPropagation();
            toggleTheme();
            return;
          }
          if (e.target.closest('#bmpv-close')) {
            e.preventDefault();
            e.stopPropagation();
            panelOpen = false;
            panel.classList.remove('open');
          }
        },
        true
      );

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
  }

  function ensureUI() {
    let fab = document.getElementById('bmpv-fab');
    let panel = document.getElementById('bmpv-panel');

    if (!fab || !panel) {
      fab = document.createElement('button');
      fab.id = 'bmpv-fab';
      fab.type = 'button';
      fab.title = '多P课程进度';
      fab.innerHTML = 'P<span class="bmpv-badge" id="bmpv-badge" style="display:none"></span>';

      panel = document.createElement('div');
      panel.id = 'bmpv-panel';
      panel.innerHTML = `
        <div class="bmpv-hdr">
          <span class="bmpv-hdr-title">多P课程进度</span>
          <div class="bmpv-hdr-actions">
            <button type="button" class="bmpv-hdr-btn" id="bmpv-theme-btn" title="切换为浅色">明</button>
            <button type="button" class="bmpv-hdr-close" id="bmpv-close" title="收起">×</button>
          </div>
        </div>
        <div id="bmpv-content" class="bmpv-loading">加载中…</div>
      `;

      document.body.appendChild(fab);
      document.body.appendChild(panel);
    } else {
      upgradePanelHeader(panel);
    }

    wirePanelEvents(fab, panel);
    applyTheme();
  }

  function hideUI() {
    const fab = document.getElementById('bmpv-fab');
    const panel = document.getElementById('bmpv-panel');
    if (fab) delete fab.dataset.bmpvFabWired;
    if (panel) delete panel.dataset.bmpvPanelWired;
    fab?.remove();
    panel?.remove();
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
      applyTheme();
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
    applyTheme();
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
    await loadTheme();

    const bv = extractBvid();
    if (!bv) {
      hideUI();
      stopVideoWatch();
      return;
    }

    if (bv === bvid && location.href === lastHref && pages.length) {
      currentPage = getCurrentPageFromUrl();
      renderPanel();
      applyTheme();
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
