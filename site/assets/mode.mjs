/**
 * 全站“简洁 / 详细”显示模式。
 *
 * 与页面标记和样式共用的约定：
 * - 默认简洁：<body> 不带 data-mode 属性；
 * - 详细模式：<body data-mode="detailed">；
 * - 只在详细模式出现的内容标 class="mode-detail"，由样式负责隐藏；
 * - 页头按钮 [data-mode-toggle] 在脚本运行时才显示，用 aria-pressed 反映状态；
 * - 选择保存在 localStorage，首页、课程详情与来源页共用；存储不可用时仍可在当前页切换。
 */
const STORAGE_KEY = 'ustc-course-nav.mode';
const DETAILED = 'detailed';
const COMPACT = 'compact';

function readMode() {
  try {
    return localStorage.getItem(STORAGE_KEY) === DETAILED ? DETAILED : COMPACT;
  } catch {
    return COMPACT;
  }
}

function saveMode(mode) {
  try {
    if (mode === DETAILED) localStorage.setItem(STORAGE_KEY, DETAILED);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 站点数据被禁用等情况下无法持久化；当前页面的切换继续有效。
  }
}

function applyMode(mode) {
  const detailed = mode === DETAILED;
  if (detailed) document.body.dataset.mode = DETAILED;
  else delete document.body.dataset.mode;

  const isIndex = document.body.dataset.page === 'index';
  const prefix = isIndex ? '作用于课程详情页与来源页：' : '';

  for (const toggle of document.querySelectorAll('[data-mode-toggle]')) {
    toggle.hidden = false;
    toggle.setAttribute('aria-pressed', String(detailed));
    toggle.title = detailed
      ? `${prefix}当前为详细模式，点击切换到简洁模式`
      : `${prefix}当前为简洁模式，点击切换到详细模式`;
    for (const opt of toggle.querySelectorAll('[data-mode-opt]')) {
      const active = opt.dataset.modeOpt === (detailed ? DETAILED : COMPACT);
      if (active) opt.dataset.active = 'true';
      else delete opt.dataset.active;
    }
  }
}

function currentMode() {
  return document.body.dataset.mode === DETAILED ? DETAILED : COMPACT;
}

applyMode(readMode());

for (const toggle of document.querySelectorAll('[data-mode-toggle]')) {
  toggle.addEventListener('click', () => {
    const next = currentMode() === DETAILED ? COMPACT : DETAILED;
    applyMode(next);
    saveMode(next);
  });
}

// 其他标签页切换模式时保持一致；存储被清空（key 为 null）也回到简洁模式。
window.addEventListener('storage', (event) => {
  if (event.key !== null && event.key !== STORAGE_KEY) return;
  applyMode(readMode());
});
