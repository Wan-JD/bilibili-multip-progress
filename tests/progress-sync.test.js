const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadHelpers() {
  const scriptPath = path.join(__dirname, '..', 'bilibili-multip-progress.user.js');
  const source = fs.readFileSync(scriptPath, 'utf8');
  const instrumented = source.replace(
    /\r?\n  bootstrap\(\);\r?\n\}\)\(\);\s*$/,
    `
  globalThis.__bmpvTestExports = {
    extractCidScopedProgress,
    accountProgressStatus,
    normalizeProgressValue,
    pickProgressValue,
    progressToStatus,
    setProgressMapValue,
    setTheme,
    cyclePartStatus,
    isManualMark,
    __setState(state) {
      if ('bvid' in state) bvid = state.bvid;
      if ('pages' in state) pages = state.pages;
      if ('storageCache' in state) storageCache = state.storageCache;
      if ('manualCache' in state) manualCache = state.manualCache;
    },
  };
})();`
  );
  assert.notEqual(instrumented, source, 'test harness should replace bootstrap with helper exports');

  const context = {
    URLSearchParams,
    console,
    document: {
      addEventListener() {},
      body: {},
      getElementById() {
        return null;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    fetch() {
      throw new Error('fetch should not run in helper tests');
    },
    GM_addStyle() {},
    GM_getValue() {
      return null;
    },
    GM_setValue() {
      return Promise.resolve();
    },
    history: {
      pushState() {},
      replaceState() {},
    },
    location: {
      href: 'https://www.bilibili.com/video/BVTEST?p=1',
      origin: 'https://www.bilibili.com',
      pathname: '/video/BVTEST',
      search: '?p=1',
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setInterval() {},
    clearInterval() {},
    setTimeout(fn) {
      return fn();
    },
    window: null,
  };
  context.window = context;

  vm.runInNewContext(instrumented, context, { filename: scriptPath });
  return context.__bmpvTestExports;
}

const helpers = loadHelpers();

function createElementStub() {
  return {
    dataset: {},
    style: {
      values: {},
      setProperty(key, value) {
        this.values[key] = value;
      },
    },
    className: '',
    textContent: '',
    title: '',
    querySelector() {
      return null;
    },
  };
}

function loadInteractiveHelpers({ gmSetValue = () => undefined } = {}) {
  const scriptPath = path.join(__dirname, '..', 'bilibili-multip-progress.user.js');
  const source = fs.readFileSync(scriptPath, 'utf8');
  const instrumented = source.replace(
    /\r?\n  bootstrap\(\);\r?\n\}\)\(\);\s*$/,
    `
  globalThis.__bmpvTestExports = {
    setTheme,
    cyclePartStatus,
    isManualMark,
    getPartStatus,
    __setState(state) {
      if ('bvid' in state) bvid = state.bvid;
      if ('pages' in state) pages = state.pages;
      if ('storageCache' in state) storageCache = state.storageCache;
      if ('manualCache' in state) manualCache = state.manualCache;
    },
  };
})();`
  );
  assert.notEqual(instrumented, source, 'test harness should replace bootstrap with helper exports');

  const panel = createElementStub();
  const fab = createElementStub();
  const themeButton = createElementStub();
  const statusButton = createElementStub();
  statusButton.dataset.page = '1';

  panel.querySelector = (selector) => (selector === '#bmpv-theme-btn' ? themeButton : null);

  const context = {
    URLSearchParams,
    console,
    document: {
      addEventListener() {},
      body: {},
      getElementById(id) {
        if (id === 'bmpv-panel') return panel;
        if (id === 'bmpv-fab') return fab;
        if (id === 'bmpv-badge') return null;
        return null;
      },
      querySelector(selector) {
        if (selector === '#bmpv-list .bmpv-status[data-page="1"]') return statusButton;
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    fetch() {
      throw new Error('fetch should not run in helper tests');
    },
    GM_addStyle() {},
    GM_getValue() {
      return null;
    },
    GM_setValue: gmSetValue,
    history: {
      pushState() {},
      replaceState() {},
    },
    location: {
      href: 'https://www.bilibili.com/video/BVTEST?p=1',
      origin: 'https://www.bilibili.com',
      pathname: '/video/BVTEST',
      search: '?p=1',
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setInterval() {},
    clearInterval() {},
    setTimeout(fn) {
      return fn();
    },
    window: null,
    __bmpvTestElements: { panel, fab, themeButton, statusButton },
  };
  context.window = context;

  vm.runInNewContext(instrumented, context, { filename: scriptPath });
  return { helpers: context.__bmpvTestExports, elements: context.__bmpvTestElements };
}

test('untrusted per-cid -1 is ignored instead of becoming completed', () => {
  assert.equal(helpers.extractCidScopedProgress({ cid: 2002, progress: -1 }, 2002), null);
  assert.equal(helpers.extractCidScopedProgress({ cid: 2002, last_play_time: -1 }, 2002), null);
});

test('history-scoped -1 remains a completed marker', () => {
  assert.equal(helpers.extractCidScopedProgress({ last_play_cid: 2002, last_play_time: -1 }, 2002), -1);
  assert.equal(helpers.extractCidScopedProgress({ history: { cid: 2002 }, progress: -1 }, 2002), -1);
});

test('mismatched cid progress is ignored', () => {
  assert.equal(helpers.extractCidScopedProgress({ last_play_cid: 2001, last_play_time: 120 }, 2002), null);
  assert.equal(helpers.extractCidScopedProgress({ cid: 2001, progress: 120 }, 2002), null);
});

test('nonnegative per-cid progress still syncs', () => {
  assert.equal(helpers.extractCidScopedProgress({ cid: 2002, progress: 45 }, 2002), 45);
  assert.equal(helpers.extractCidScopedProgress({ cid: 2002, last_play_time: 90 }, 2002), 90);
});

test('completed sentinel wins when progress values are merged', () => {
  const map = new Map();
  helpers.setProgressMapValue(map, 1, -1);
  helpers.setProgressMapValue(map, 1, 120);
  helpers.setProgressMapValue(map, 2, 15);
  helpers.setProgressMapValue(map, 2, 40);

  assert.equal(map.get(1), -1);
  assert.equal(map.get(2), 40);
});

test('progress values convert to expected statuses', () => {
  assert.equal(helpers.progressToStatus(null, 100), 'unwatched');
  assert.equal(helpers.progressToStatus(2, 100), 'unwatched');
  assert.equal(helpers.progressToStatus(10, 100), 'in_progress');
  assert.equal(helpers.progressToStatus(90, 100), 'completed');
  assert.equal(helpers.progressToStatus(-1, 100), 'completed');
});

test('account sync treats missing non-manual pages as unwatched after finding account evidence', () => {
  const progressMap = new Map([
    [1, -1],
    [3, 120],
  ]);

  assert.equal(helpers.accountProgressStatus(progressMap, 1, 100), 'completed');
  assert.equal(helpers.accountProgressStatus(progressMap, 2, 100, true), 'unwatched');
  assert.equal(helpers.accountProgressStatus(progressMap, 3, 200, true), 'in_progress');
  assert.equal(helpers.accountProgressStatus(progressMap, 4, 100, false), null);
});

test('theme click updates immediately when GM_setValue is synchronous', () => {
  const { helpers: interactive, elements } = loadInteractiveHelpers();

  assert.doesNotThrow(() => interactive.setTheme('light'));
  assert.equal(elements.panel.dataset.theme, 'light');
  assert.equal(elements.themeButton.textContent, '暗');
});

test('manual unwatched status click marks the part completed immediately when GM_setValue is synchronous', () => {
  const { helpers: interactive, elements } = loadInteractiveHelpers();
  interactive.__setState({
    bvid: 'BVTEST',
    pages: [{ page: 1, duration: 100 }],
    storageCache: {},
    manualCache: {},
  });

  assert.doesNotThrow(() => interactive.cyclePartStatus(1));
  assert.equal(interactive.getPartStatus('BVTEST', 1), 'completed');
  assert.equal(interactive.isManualMark('BVTEST', 1), true);
  assert.equal(elements.statusButton.textContent, '已完成');
});
