// ==UserScript==
// @name         B站多P课程进度助手
// @namespace    https://github.com/Wan-JD/bilibili-multip-progress
// @version      1.2.6
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
  const MANUAL_STORAGE_KEY = 'bilibili_multip_progress_manual';
  const THEME_KEY = 'bilibili_multip_progress_theme';
  const SCRIPT_VERSION = '1.2.6';
  const COMPLETE_RATIO = 0.9;
  const STATUS = { UNWATCHED: 'unwatched', IN_PROGRESS: 'in_progress', COMPLETED: 'completed' };
  const STATUS_LABEL = {
    [STATUS.UNWATCHED]: '未看',
    [STATUS.IN_PROGRESS]: '进行中',
    [STATUS.COMPLETED]: '已完成',
  };
  const STATUS_CYCLE = [STATUS.UNWATCHED, STATUS.IN_PROGRESS, STATUS.COMPLETED];
  let storageCache = null;
  let manualCache = null;
  let uiTheme = 'dark';
  let wbiMixinKey = null;
  let wbiMixinKeyAt = 0;
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

  function normalizeBvid(bv) {
    if (!bv) return bv;
    const m = String(bv).match(/^(bv)(.+)$/i);
    return m ? `BV${m[2]}` : bv;
  }

  function migrateBvidKeys(store) {
    if (!store || typeof store !== 'object') return;
    for (const key of Object.keys(store)) {
      const nk = normalizeBvid(key);
      if (!nk || nk === key) continue;
      store[nk] = { ...(store[nk] || {}), ...(store[key] || {}) };
      delete store[key];
    }
  }

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

    let manual = await GM_getValue(MANUAL_STORAGE_KEY, null);
    if (typeof manual === 'string') {
      try {
        manual = JSON.parse(manual);
      } catch {
        manual = {};
      }
    }
    manualCache = manual && typeof manual === 'object' ? manual : {};
    migrateBvidKeys(storageCache);
    migrateBvidKeys(manualCache);

    await GM_setValue(STORAGE_KEY, storageCache);
    return storageCache;
  }

  function persistStorage() {
    GM_setValue(STORAGE_KEY, storageCache).catch(() => {});
    GM_setValue(MANUAL_STORAGE_KEY, manualCache).catch(() => {});
  }

  function isManualMark(bv, pageNum) {
    const key = normalizeBvid(bv) || bv;
    return !!(manualCache?.[key]?.[String(pageNum)]);
  }

  function setManualMark(bv, pageNum, on) {
    const key = normalizeBvid(bv) || bv;
    if (!manualCache) manualCache = {};
    if (!manualCache[key]) manualCache[key] = {};
    if (on) manualCache[key][String(pageNum)] = true;
    else delete manualCache[key][String(pageNum)];
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
    setTheme(uiTheme === 'dark' ? 'light' : 'dark');
    refreshAllStatusButtons();
  }

  function refreshAllStatusButtons() {
    document.querySelectorAll('#bmpv-list .bmpv-status').forEach((btn) => {
      const pageNum = Number(btn.dataset.page);
      if (!pageNum || !bvid) return;
      const st = getPartStatus(bvid, pageNum);
      btn.className = `bmpv-status ${st}`;
      btn.textContent = STATUS_LABEL[st] || STATUS_LABEL[STATUS.UNWATCHED];
    });
    const summary = document.querySelector('#bmpv-content .bmpv-summary');
    if (summary && pages.length > 1) {
      const done = countCompleted();
      const remain = sumRemainingSeconds();
      const syncHint = accountSynced ? ' · 已合并账号记录' : '';
      summary.innerHTML = `共 <strong>${pages.length}</strong> P · 已完成 <strong>${done}</strong> · 预计剩余 <strong>${formatDuration(remain)}</strong>${syncHint}`;
    }
    applyTheme();
  }

  function applyTheme() {
    const panel = document.getElementById('bmpv-panel');
    const fab = document.getElementById('bmpv-fab');
    const isLight = uiTheme === 'light';
    const palette = isLight ? THEME_PALETTE.light : THEME_PALETTE.dark;

    if (panel) {
      panel.dataset.theme = uiTheme;
      panel.dataset.version = SCRIPT_VERSION;
      for (const [key, value] of Object.entries(palette)) {
        panel.style.setProperty(key, value);
      }
    }
    if (fab) {
      fab.dataset.theme = uiTheme;
      fab.dataset.version = SCRIPT_VERSION;
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
    const key = normalizeBvid(bv) || bv;
    if (!storageCache) storageCache = {};
    if (!storageCache[key]) storageCache[key] = {};
    return storageCache[key];
  }

  function getPartStatus(bv, pageNum) {
    return getProgress(bv)[String(pageNum)] || STATUS.UNWATCHED;
  }

  function setPartStatus(bv, pageNum, status, manual = false, lightUpdate = false) {
    getProgress(bv)[String(pageNum)] = status;
    if (manual) setManualMark(bv, pageNum, true);
    persistStorage();
    if (lightUpdate) refreshStatusUi(pageNum);
    else renderPanel();
    updateFabBadge();
  }

  function refreshStatusUi(pageNum) {
    const btn = document.querySelector(`#bmpv-list .bmpv-status[data-page="${pageNum}"]`);
    if (!btn) {
      renderPanel();
      return;
    }
    const st = getPartStatus(bvid, pageNum);
    btn.className = `bmpv-status ${st}`;
    btn.textContent = STATUS_LABEL[st] || STATUS_LABEL[STATUS.UNWATCHED];
    const summary = document.querySelector('#bmpv-content .bmpv-summary');
    if (summary && pages.length > 1) {
      const done = countCompleted();
      const remain = sumRemainingSeconds();
      const syncHint = accountSynced ? ' · 已合并账号记录' : '';
      summary.innerHTML = `共 <strong>${pages.length}</strong> P · 已完成 <strong>${done}</strong> · 预计剩余 <strong>${formatDuration(remain)}</strong>${syncHint}`;
    }
  }

  function normalizeProgressValue(progress, allowCompleteSentinel = false) {
    if (typeof progress !== 'number' || Number.isNaN(progress)) return null;
    if (progress === -1) return allowCompleteSentinel ? -1 : null;
    if (progress >= 0) return progress;
    return null;
  }

  function pickProgressValue(a, b) {
    if (a === -1 || b === -1) return -1;
    if (a == null) return b;
    if (b == null) return a;
    return Math.max(a, b);
  }

  function setProgressMapValue(map, pageNum, progress) {
    if (!(pageNum > 0) || progress == null) return;
    map.set(pageNum, pickProgressValue(map.get(pageNum), progress));
  }

  function progressToStatus(progress, duration) {
    if (progress == null) return STATUS.UNWATCHED;
    if (progress === -1) return STATUS.COMPLETED;
    if (duration > 0 && progress >= duration * COMPLETE_RATIO) return STATUS.COMPLETED;
    if (progress > 3) return STATUS.IN_PROGRESS;
    return STATUS.UNWATCHED;
  }

  function accountProgressStatus(progressMap, page, duration, foundAny) {
    if (progressMap.has(page)) return progressToStatus(progressMap.get(page), duration);
    return foundAny ? STATUS.UNWATCHED : null;
  }

  function cyclePartStatus(pageNum) {
    if (!bvid) return;
    const run = () => {
      const cur = getPartStatus(bvid, pageNum);
      const idx = STATUS_CYCLE.indexOf(cur);
      const next = STATUS_CYCLE[(idx >= 0 ? idx + 1 : 0) % STATUS_CYCLE.length];
      setPartStatus(bvid, pageNum, next, true, true);
    };
    if (!storageCache) {
      ensureStorage().then(run).catch(run);
      return;
    }
    run();
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

  function normalizeExtractedBvid(bv) {
    return bv ? normalizeBvid(bv) : null;
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

  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
    29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
  ];

  function getVideoReferer() {
    if (bvid) return `https://www.bilibili.com/video/${bvid}`;
    const m = location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/i);
    if (m) return `https://www.bilibili.com/video/${m[1]}`;
    return 'https://www.bilibili.com/';
  }

  function apiFetch(url) {
    return fetch(url, {
      credentials: 'include',
      headers: {
        Referer: getVideoReferer(),
        Origin: 'https://www.bilibili.com',
      },
    });
  }

  function extractProgressSeconds(payload, allowCompleteSentinel = false) {
    if (payload == null) return null;
    if (typeof payload === 'number') return normalizeProgressValue(payload, allowCompleteSentinel);
    if (typeof payload !== 'object') return null;
    const keys = ['progress', 'pro', 'played_time', 'play_progress', 'last_play_time', 'time'];
    for (const k of keys) {
      const value = normalizeProgressValue(payload[k], allowCompleteSentinel);
      if (value != null) return value;
    }
    if (payload.data != null) return extractProgressSeconds(payload.data, allowCompleteSentinel);
    return null;
  }

  function md5Hex(str) {
    function rl(n, s) {
      return (n << s) | (n >>> (32 - s));
    }
    function cm(q, a, b, x, s, t) {
      return (rl((a + q + x + t) | 0, s) + b) | 0;
    }
    function ff(a, b, c, d, x, s, t) {
      return cm((b & c) | (~b & d), a, b, x, s, t);
    }
    function gg(a, b, c, d, x, s, t) {
      return cm((b & d) | (c & ~d), a, b, x, s, t);
    }
    function hh(a, b, c, d, x, s, t) {
      return cm(b ^ c ^ d, a, b, x, s, t);
    }
    function ii(a, b, c, d, x, s, t) {
      return cm(c ^ (b | ~d), a, b, x, s, t);
    }
    function md5blk(s) {
      const md5blks = [];
      for (let i = 0; i < 64; i += 4) {
        md5blks[i >> 2] =
          s.charCodeAt(i) +
          (s.charCodeAt(i + 1) << 8) +
          (s.charCodeAt(i + 2) << 16) +
          (s.charCodeAt(i + 3) << 24);
      }
      return md5blks;
    }
    function md51(s) {
      let n = s.length;
      let state = [1732584193, -271733879, -1732584194, 271733878];
      let i;
      for (i = 64; i <= n; i += 64) {
        md5cycle(state, md5blk(s.substring(i - 64, i)));
      }
      s = s.substring(i - 64);
      const tail = new Array(16).fill(0);
      for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
      tail[i >> 2] |= 0x80 << ((i % 4) << 3);
      if (i > 55) {
        md5cycle(state, tail);
        tail.fill(0);
      }
      tail[14] = n * 8;
      md5cycle(state, tail);
      return state;
    }
    function md5cycle(x, k) {
      let [a, b, c, d] = x;
      a = ff(a, b, c, d, k[0], 7, -680876936);
      d = ff(d, a, b, c, k[1], 12, -389564586);
      c = ff(c, d, a, b, k[2], 17, 606105819);
      b = ff(b, c, d, a, k[3], 22, -1044525330);
      a = ff(a, b, c, d, k[4], 7, -176418897);
      d = ff(d, a, b, c, k[5], 12, 1200080426);
      c = ff(c, d, a, b, k[6], 17, -1473231341);
      b = ff(b, c, d, a, k[7], 22, -45705983);
      a = ff(a, b, c, d, k[8], 7, 1770035416);
      d = ff(d, a, b, c, k[9], 12, -1958414417);
      c = ff(c, d, a, b, k[10], 17, -42063);
      b = ff(b, c, d, a, k[11], 22, -1990404162);
      a = ff(a, b, c, d, k[12], 7, 1804603682);
      d = ff(d, a, b, c, k[13], 12, -40341101);
      c = ff(c, d, a, b, k[14], 17, -1502002290);
      b = ff(b, c, d, a, k[15], 22, 1236535329);
      a = gg(a, b, c, d, k[1], 5, -165796510);
      d = gg(d, a, b, c, k[6], 9, -1069501632);
      c = gg(c, d, a, b, k[11], 14, 643717713);
      b = gg(b, c, d, a, k[0], 20, -373897302);
      a = gg(a, b, c, d, k[5], 5, -701558691);
      d = gg(d, a, b, c, k[10], 9, 38016083);
      c = gg(c, d, a, b, k[15], 14, -660478335);
      b = gg(b, c, d, a, k[4], 20, -405537848);
      a = gg(a, b, c, d, k[9], 5, 568446438);
      d = gg(d, a, b, c, k[14], 9, -1019803690);
      c = gg(c, d, a, b, k[3], 14, -187363961);
      b = gg(b, c, d, a, k[8], 20, 1163531501);
      a = gg(a, b, c, d, k[13], 5, -1444681467);
      d = gg(d, a, b, c, k[2], 9, -51403784);
      c = gg(c, d, a, b, k[7], 14, 1735328473);
      b = gg(b, c, d, a, k[12], 20, -1926607734);
      a = hh(a, b, c, d, k[5], 4, -378558);
      d = hh(d, a, b, c, k[8], 11, -2022574463);
      c = hh(c, d, a, b, k[11], 16, 1839030562);
      b = hh(b, c, d, a, k[14], 23, -35309556);
      a = hh(a, b, c, d, k[1], 4, -1530992060);
      d = hh(d, a, b, c, k[4], 11, 1272893353);
      c = hh(c, d, a, b, k[7], 16, -155497632);
      b = hh(b, c, d, a, k[10], 23, -1094730640);
      a = hh(a, b, c, d, k[13], 4, 681279174);
      d = hh(d, a, b, c, k[0], 11, -358537222);
      c = hh(c, d, a, b, k[3], 16, -722521979);
      b = hh(b, c, d, a, k[6], 23, 76029189);
      a = hh(a, b, c, d, k[9], 4, -640364487);
      d = hh(d, a, b, c, k[12], 11, -421815835);
      c = hh(c, d, a, b, k[15], 16, 530742520);
      b = hh(b, c, d, a, k[2], 23, -995338651);
      a = ii(a, b, c, d, k[0], 6, -198630844);
      d = ii(d, a, b, c, k[7], 10, 1126891415);
      c = ii(c, d, a, b, k[14], 15, -1416354905);
      b = ii(b, c, d, a, k[5], 21, -57434055);
      a = ii(a, b, c, d, k[12], 6, 1700485571);
      d = ii(d, a, b, c, k[3], 10, -1894986606);
      c = ii(c, d, a, b, k[10], 15, -1051523);
      b = ii(b, c, d, a, k[1], 21, -2054922799);
      a = ii(a, b, c, d, k[8], 6, 1873313359);
      d = ii(d, a, b, c, k[15], 10, -30611744);
      c = ii(c, d, a, b, k[6], 15, -1560198380);
      b = ii(b, c, d, a, k[13], 21, 1309151649);
      a = ii(a, b, c, d, k[4], 6, -145523070);
      d = ii(d, a, b, c, k[11], 10, -1120210379);
      c = ii(c, d, a, b, k[2], 15, 718787259);
      b = ii(b, c, d, a, k[9], 21, -343485551);
      x[0] = (a + x[0]) | 0;
      x[1] = (b + x[1]) | 0;
      x[2] = (c + x[2]) | 0;
      x[3] = (d + x[3]) | 0;
    }
    function rhex(n) {
      const hex = '0123456789abcdef';
      let s = '';
      for (let j = 0; j < 4; j++) s += hex.charAt((n >> (j * 8 + 4)) & 0x0f) + hex.charAt((n >> (j * 8)) & 0x0f);
      return s;
    }
    return md51(str)
      .map(rhex)
      .join('');
  }

  function genMixinKey(raw) {
    let out = '';
    for (let i = 0; i < MIXIN_KEY_ENC_TAB.length; i++) {
      out += raw[MIXIN_KEY_ENC_TAB[i]];
    }
    return out.slice(0, 32);
  }

  async function getWbiMixinKey() {
    if (wbiMixinKey && Date.now() - wbiMixinKeyAt < 12 * 60 * 60 * 1000) return wbiMixinKey;
    const res = await apiFetch('https://api.bilibili.com/x/web-interface/nav');
    const json = await res.json();
    const img = json.data?.wbi_img?.img_url || '';
    const sub = json.data?.wbi_img?.sub_url || '';
    const imgKey = img.slice(img.lastIndexOf('/') + 1, img.lastIndexOf('.'));
    const subKey = sub.slice(sub.lastIndexOf('/') + 1, sub.lastIndexOf('.'));
    if (!imgKey || !subKey) throw new Error('WBI key unavailable');
    wbiMixinKey = genMixinKey(imgKey + subKey);
    wbiMixinKeyAt = Date.now();
    return wbiMixinKey;
  }

  async function wbiGet(baseUrl, params) {
    const mixin = await getWbiMixinKey();
    const wts = Math.floor(Date.now() / 1000);
    const entries = Object.entries({ ...params, wts }).sort(([a], [b]) => a.localeCompare(b));
    const query = entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const w_rid = md5Hex(`${query}${mixin}`);
    const url = `${baseUrl}?${query}&w_rid=${w_rid}`;
    const res = await apiFetch(url);
    return res.json();
  }

  function ingestHistoryItem(map, item, bvUpper, videoAid, cidToPage) {
    const h = item.history || {};
    const itemBvid = String(h.bvid || item.bvid || '').toUpperCase();
    const kid = item.kid ?? h.oid;
    const match =
      (itemBvid && itemBvid === bvUpper) ||
      (videoAid && (Number(kid) === Number(videoAid) || Number(h.oid) === Number(videoAid)));
    if (!match) return false;

    const progress = extractProgressSeconds({ progress: item.progress ?? h.progress }, true);
    if (progress == null) return false;

    const cid = h.cid;
    if (cid && cidToPage.has(cid)) {
      const p = cidToPage.get(cid);
      setProgressMapValue(map, p, progress);
    }
    const pageNum = h.page;
    if (pageNum > 0) {
      setProgressMapValue(map, pageNum, progress);
    }
    return true;
  }

  async function fetchPages(bv) {
    const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bv)}`;
    const res = await apiFetch(url);
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

  async function fetchHistoryProgressMap(bv, videoAid, cidToPage) {
    const map = new Map();
    const bvUpper = bv.toUpperCase();
    let max = 0;
    let viewAt = 0;
    let business = '';
    const ps = 30;
    let prevMax = -1;
    let prevViewAt = -1;

    for (let round = 0; round < 25; round++) {
      const qs = new URLSearchParams({
        ps: String(ps),
        max: String(max),
        view_at: String(viewAt),
        type: 'archive',
      });
      if (business) qs.set('business', business);
      const res = await apiFetch(
        `https://api.bilibili.com/x/web-interface/history/cursor?${qs.toString()}`
      );
      if (!res.ok) break;
      const json = await res.json();
      if (json.code === -101) return { map, loggedIn: false };
      if (json.code !== 0) break;

      const data = json.data || {};
      const list = data.list || [];
      if (!list.length) break;

      for (const item of list) {
        ingestHistoryItem(map, item, bvUpper, videoAid, cidToPage);
      }

      const c = data.cursor;
      if (!c || list.length < ps) break;
      const nextMax = c.max ?? max;
      const nextViewAt = c.view_at ?? viewAt;
      if (round > 0 && nextMax === prevMax && nextViewAt === prevViewAt) break;
      prevMax = nextMax;
      prevViewAt = nextViewAt;
      max = nextMax;
      viewAt = nextViewAt;
      business = c.business ?? business;
    }

    return { map, loggedIn: true };
  }

  async function fetchV2HistoryProgressMap(bv, videoAid, cidToPage) {
    const map = new Map();
    const bvUpper = bv.toUpperCase();

    for (let pn = 1; pn <= 40; pn++) {
      const res = await apiFetch(
        `https://api.bilibili.com/x/v2/history?pn=${pn}&ps=30`
      );
      if (!res.ok) break;
      const json = await res.json();
      if (json.code === -101) break;
      if (json.code !== 0) break;
      const list = json.data;
      if (!Array.isArray(list) || !list.length) break;

      for (const item of list) {
        const itemBvid = String(item.bvid || '').toUpperCase();
        if (itemBvid !== bvUpper && Number(item.aid) !== Number(videoAid)) continue;
        const progress = extractProgressSeconds({ progress: item.progress }, true);
        if (progress == null) continue;
        const pageObj = item.page;
        const pageNum = typeof pageObj === 'number' ? pageObj : pageObj?.page;
        if (pageNum > 0) {
          setProgressMapValue(map, pageNum, progress);
        }
        const itemCid = pageObj?.cid ?? item.cid;
        if (itemCid && cidToPage.has(itemCid)) {
          const p = cidToPage.get(itemCid);
          setProgressMapValue(map, p, progress);
        }
      }

      if (list.length < 30) break;
    }

    return map;
  }

  function extractCidScopedProgress(data, requestedCid) {
    if (!data || typeof data !== 'object') return null;

    const lastPlayCid = data.last_play_cid ?? data.history?.cid ?? data.view_info?.last_play_cid;
    if (lastPlayCid != null) {
      if (Number(lastPlayCid) !== Number(requestedCid)) return null;
      return extractProgressSeconds({ progress: data.last_play_time ?? data.progress }, true);
    }

    const watchedCid = data.history?.cid ?? data.view_info?.cid;
    if (watchedCid != null) {
      if (Number(watchedCid) !== Number(requestedCid)) return null;
      return extractProgressSeconds(data, true);
    }

    const responseCid = data.cid;
    if (responseCid != null && Number(responseCid) !== Number(requestedCid)) return null;

    return extractProgressSeconds(data, false);
  }

  async function fetchCidProgressPlayerV2(videoAid, bv, cid) {
    try {
      const res = await apiFetch(
        `https://api.bilibili.com/x/player/v2?aid=${videoAid}&bvid=${encodeURIComponent(bv)}&cid=${cid}`
      );
      if (!res.ok) return null;
      const json = await res.json();
      if (json.code !== 0 || !json.data) return null;
      const d = json.data;
      if (Number(d.cid) !== Number(cid)) return null;
      return extractCidScopedProgress(d, cid);
    } catch {
      return null;
    }
  }

  async function fetchCidProgressWbi(videoAid, bv, cid) {
    try {
      const json = await wbiGet('https://api.bilibili.com/x/player/wbi/v2', {
        aid: videoAid,
        bvid: bv,
        cid,
      });
      if (json.code !== 0 || !json.data) return null;
      const d = json.data;
      if (Number(d.cid) !== Number(cid)) return null;
      return extractCidScopedProgress(d, cid);
    } catch {
      return null;
    }
  }

  async function fetchCidProgressLegacy(videoAid, bv, cid) {
    const qs = new URLSearchParams({
      aid: String(videoAid),
      cid: String(cid),
      bvid: bv,
    });
    const res = await apiFetch(
      `https://api.bilibili.com/x/click-interface/web/history?${qs.toString()}`
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 0 || json.data == null) return null;
    return extractCidScopedProgress(json.data, cid);
  }

  async function fetchCidProgressAll(videoAid, bv, cid) {
    const legacy = await fetchCidProgressLegacy(videoAid, bv, cid);
    if (legacy != null) return legacy;
    const v2 = await fetchCidProgressPlayerV2(videoAid, bv, cid);
    if (v2 != null) return v2;
    return fetchCidProgressWbi(videoAid, bv, cid);
  }

  async function runPool(items, limit, worker) {
    const queue = [...items];
    if (!queue.length) return;
    const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        await worker(item);
      }
    });
    await Promise.all(runners);
  }

  function mergeProgressMaps(target, source) {
    for (const [page, sec] of source) {
      setProgressMapValue(target, page, sec);
    }
  }

  async function collectAccountProgress(videoAid, bv, pageList) {
    const cidToPage = new Map(pageList.map((p) => [p.cid, p.page]));
    const progressMap = new Map();

    const cursorResult = await fetchHistoryProgressMap(bv, videoAid, cidToPage);
    if (cursorResult.loggedIn === false) {
      return { progressMap, loggedIn: false, foundAny: false };
    }
    mergeProgressMaps(progressMap, cursorResult.map);

    mergeProgressMaps(progressMap, await fetchV2HistoryProgressMap(bv, videoAid, cidToPage));

    // 历史列表每个稿件通常只有「最近观看」的一条；各分 P 进度需按 cid 逐个查询
    await runPool(pageList, 4, async (pg) => {
      const sec = await fetchCidProgressAll(videoAid, bv, pg.cid);
      if (sec != null) {
        setProgressMapValue(progressMap, pg.page, sec);
      }
    });

    return { progressMap, loggedIn: true, foundAny: progressMap.size > 0 };
  }

  async function syncFromAccount(videoAid, bv, pageList) {
    if (!videoAid || !pageList.length) return { changed: false, foundAny: false, loggedIn: true };

    const { progressMap, loggedIn, foundAny } = await collectAccountProgress(videoAid, bv, pageList);
    if (!loggedIn) return { changed: false, foundAny: false, loggedIn: false };

    let changed = false;
    const local = getProgress(bv);

    for (const pg of pageList) {
      if (isManualMark(bv, pg.page)) continue;

      const serverSt = accountProgressStatus(progressMap, pg.page, pg.duration, foundAny);
      if (serverSt == null) continue;
      const localSt = local[String(pg.page)] || STATUS.UNWATCHED;
      if (serverSt !== localSt) {
        local[String(pg.page)] = serverSt;
        changed = true;
      }
    }

    if (changed) persistStorage();
    return { changed, foundAny, loggedIn: true };
  }

  async function runAccountSync() {
    if (!aid || !bvid || pages.length <= 1) return;
    const content = document.getElementById('bmpv-content');
    if (content) {
      content.className = 'bmpv-loading';
      content.textContent = '同步账号观看记录…';
    }
    try {
      const sync = await syncFromAccount(aid, bvid, pages);
      accountSynced = sync.foundAny;
      if (!sync.loggedIn) {
        if (content) {
          content.className = 'bmpv-empty';
          content.textContent = '未登录 B 站，无法读取观看记录';
        }
        return;
      }
    } catch (err) {
      accountSynced = false;
      if (content) {
        content.className = 'bmpv-empty';
        content.textContent = `同步失败：${err.message || '未知错误'}`;
      }
      return;
    }
    renderPanel();
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
    if (isManualMark(bvid, currentPage)) return;
    const st = getPartStatus(bvid, currentPage);
    if (st === STATUS.COMPLETED) return;
    if (st !== STATUS.IN_PROGRESS) setPartStatus(bvid, currentPage, STATUS.IN_PROGRESS, false, true);
  }

  function markCurrentCompleted() {
    if (!bvid) return;
    if (isManualMark(bvid, currentPage)) return;
    setPartStatus(bvid, currentPage, STATUS.COMPLETED, false, true);
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
      white-space: nowrap; position: relative; z-index: 2;
      cursor: pointer; pointer-events: auto;
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

  function stopUiEvent(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function wirePanelEvents(fab, panel) {
    if (fab && fab.dataset.bmpvFabWired !== '6') {
      fab.dataset.bmpvFabWired = '6';
      fab.addEventListener('click', (e) => {
        stopUiEvent(e);
        panelOpen = !panelOpen;
        panel.classList.toggle('open', panelOpen);
      });
    }

    if (panel.dataset.bmpvPanelWired !== '6') {
      panel.dataset.bmpvPanelWired = '6';

      const themeBtn = panel.querySelector('#bmpv-theme-btn');
      if (themeBtn) {
        themeBtn.replaceWith(themeBtn.cloneNode(true));
        panel.querySelector('#bmpv-theme-btn')?.addEventListener('click', (e) => {
          stopUiEvent(e);
          toggleTheme();
        });
      }

      const closeBtn = panel.querySelector('#bmpv-close');
      if (closeBtn) {
        closeBtn.replaceWith(closeBtn.cloneNode(true));
        panel.querySelector('#bmpv-close')?.addEventListener('click', (e) => {
          stopUiEvent(e);
          panelOpen = false;
          panel.classList.remove('open');
        });
      }
    }

    if (!window.__bmpvWheelHandlersInstalled) {
      window.__bmpvWheelHandlersInstalled = true;
      document.addEventListener(
        'wheel',
        (e) => {
          const list = e.target.closest('#bmpv-panel .bmpv-list');
          if (!list) return;
          const { scrollTop, scrollHeight, clientHeight } = list;
          const delta = e.deltaY;
          const atTop = scrollTop <= 0;
          const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
          if ((delta < 0 && atTop) || (delta > 0 && atBottom)) return;
          e.stopPropagation();
        },
        { passive: true, capture: true }
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
    fab?.remove();
    panel?.remove();
    panelOpen = false;
  }

  function onContinueClick() {
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
      applyTheme();
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
    const syncHint = accountSynced ? ' · 已合并账号记录' : '';

    content.innerHTML = `
      <div class="bmpv-summary">
        共 <strong>${pages.length}</strong> P · 已完成 <strong>${done}</strong> ·
        预计剩余 <strong>${formatDuration(remain)}</strong>${syncHint}
      </div>
      <div class="bmpv-actions">
        <button type="button" class="bmpv-btn primary" id="bmpv-continue">从第一个未完成的P继续</button>
        <button type="button" class="bmpv-btn" id="bmpv-sync">同步账号观看记录</button>
      </div>
      <div class="bmpv-list" id="bmpv-list"></div>
      <div class="bmpv-foot">
        <span>v${SCRIPT_VERSION}</span> · <a href="https://ifdian.net/a/jd0512" target="_blank" rel="noopener">支持作者</a>
      </div>
    `;

    document.getElementById('bmpv-continue')?.addEventListener('click', (e) => {
      stopUiEvent(e);
      onContinueClick();
    });
    document.getElementById('bmpv-sync')?.addEventListener('click', (e) => {
      stopUiEvent(e);
      runAccountSync().catch(() => {});
    });

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
        stopUiEvent(e);
        cyclePartStatus(pg.page);
      });
      list.appendChild(row);
    }

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

    const bv = normalizeExtractedBvid(extractBvid());
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
    bvid = normalizeExtractedBvid(bv);
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
        if (!sync.loggedIn && content) {
          content.className = 'bmpv-empty';
          content.textContent = '未登录 B 站，无法读取观看记录（可手动标记进度）';
        }
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
