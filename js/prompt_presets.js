// 提示词预设：在任意多行文本框左下角挂一个小按钮，
// 点开是「本节点最近用过的提示词 + 按工作流分类的预设库」。
//
// 设计要点：
//   · 插件不注册节点，只在客户端给已有的文本 widget 加一层 DOM 按钮，
//     画布本身不画任何东西，所以对节点尺寸、序列化都没有影响。
//   · 值永远写回 widget.value（ComfyUI 的真相源），同时同步可见的 textarea，
//     否则下一次序列化拿到的还是旧文本。
//   · 历史只在「提交执行成功」后记录 —— 写了一半没跑的不进历史。

import { app } from "../../scripts/app.js";

const CLASS = "PromptPresets";
const API = "/prompt_presets/api";
const HISTORY_LIMIT = 10;
const UNSAVED = "__unsaved__";

// 面板的浏览状态（停在哪个页、看哪个工作流、是否显示正文）记在本地
const UI_KEY = "promptPresets.ui";

// 按钮默认贴在文本框左下角；被同一区域的其他按钮挡住时自动往右让位
const BTN_W = 22;
const BTN_H = 18;
const BTN_INSET = 6;
const NUDGE_STEP = 24;
const NUDGE_MAX = 4;

const PREFIX = "[提示词预设]";

let LIB = { workflows: {}, history_limit: HISTORY_LIMIT, counts: { presets: 0, workflows: 0 } };
let libReady = false;
let libPromise = null;

// 当前打开的浮层（全局只有一个）
let PANEL = null;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function log(...args) {
  console.log(PREFIX, ...args);
}

function warn(...args) {
  console.warn(PREFIX, ...args);
}

function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function preview(text, max = 60) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function guessName(text) {
  const first = String(text || "").trim().split("\n")[0].trim().replace(/\s+/g, " ");
  if (!first) return "未命名预设";
  return first.length > 12 ? first.slice(0, 12) + "…" : first;
}

/* ------------------------------------------------------------------ */
/* 数据                                                                */
/* ------------------------------------------------------------------ */

async function fetchState() {
  const res = await fetch(`${API}/state`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.state) {
    LIB = data.state;
    libReady = true;
  }
  return LIB;
}

function ensureLib() {
  if (libReady) return Promise.resolve(LIB);
  if (!libPromise) {
    libPromise = fetchState()
      .catch((err) => {
        warn("读取预设库失败：", err);
        return LIB;
      })
      .finally(() => {
        libPromise = null;
      });
  }
  return libPromise;
}

async function postJSON(path, body) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }
  if (data && data.state) {
    LIB = data.state;
    libReady = true;
  } else if (!res.ok) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data;
}

function workflowOf(key) {
  return (LIB.workflows || {})[key] || null;
}

function presetsOf(key) {
  const wf = workflowOf(key);
  return wf ? wf.presets || [] : [];
}

function historyOf(key, nodeKey) {
  const wf = workflowOf(key);
  if (!wf) return [];
  return (wf.history || {})[nodeKey] || [];
}

/* ------------------------------------------------------------------ */
/* 浏览状态的记忆                                                       */
/* ------------------------------------------------------------------ */

/**
 * 记住上次停在哪个选项卡、看哪个工作流的预设、要不要显示正文。
 * 存 localStorage，跟工作流文件无关，换机器不会带走。
 */
function loadUI() {
  try {
    const raw = window.localStorage.getItem(UI_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch (err) {
    return {};
  }
}

function saveUI() {
  if (!PANEL) return;
  try {
    window.localStorage.setItem(
      UI_KEY,
      JSON.stringify({ tab: PANEL.tab, scope: PANEL.scope, detail: PANEL.detail })
    );
  } catch (err) {
    // 无痕模式或禁用存储时静默跳过
  }
}

/* ------------------------------------------------------------------ */
/* 当前工作流                                                          */
/* ------------------------------------------------------------------ */

function pickString(v) {
  return typeof v === "string" && v ? v : null;
}

/**
 * 拿当前工作流的稳定身份。
 * 优先用 path（workflows/xxx.json），未保存的新工作流退化成固定键。
 * 不同前端版本暴露的位置不一样，这里按可能的位置逐个试，失败也不影响使用。
 */
function currentWorkflow() {
  const candidates = [
    () => app.workflowManager && app.workflowManager.activeWorkflow,
    () => app.extensionManager && app.extensionManager.workflow && app.extensionManager.workflow.activeWorkflow,
    () => app.workflow,
  ];

  for (const get of candidates) {
    let wf = null;
    try {
      wf = get();
    } catch (err) {
      wf = null;
    }
    if (!wf) continue;

    const path = pickString(wf.path) || pickString(wf.key);
    const name =
      pickString(wf.filename) || pickString(wf.name) || (path ? path.split("/").pop().replace(/\.json$/i, "") : null);

    // 未保存的新工作流也会有一个占位 path（workflows/Unsaved Workflow.json）。
    // 所有临时工作流共用这一个 path，按它分组会把互不相干的东西混在一起，
    // 所以统一落到 __unsaved__，等用户第一次保存后再按真实 path 归位。
    if (/unsaved\s*workflow/i.test(path || "") || /unsaved\s*workflow/i.test(name || "")) {
      return { key: UNSAVED, name: "未保存的工作流", unsaved: true };
    }

    if (path) return { key: path.replace(/\\/g, "/"), name: name || path, unsaved: false };
    if (name) return { key: UNSAVED, name, unsaved: true };
  }

  return { key: UNSAVED, name: "未保存的工作流", unsaved: true };
}

/* ------------------------------------------------------------------ */
/* 目标 widget                                                         */
/* ------------------------------------------------------------------ */

/**
 * 只认多行文本框。
 * ComfyUI 把 STRING + multiline 注册成 type "customtext"，但有的节点是运行时
 * 才加 widget 的，所以除了 type 还要看 options.multiline。
 */
function isPromptWidget(node, w) {
  if (!w || typeof w.name !== "string") return false;
  if (w.name === "text" && /^(Note|MarkdownNote)$/.test(node?.type || "")) return false;
  if (w.options && w.options.multiline === true) return true;
  if (w.type === "customtext") return true;
  return false;
}

function nodeKeyOf(node) {
  return `${node.type || "Node"}#${node.id}`;
}

/**
 * 文本 widget 在 DOM 里的那层元素。
 *
 * `element` 通常是真正显示出来的那层，`inputEl` 是编辑时用的输入框；
 * 不同前端版本两者含义不完全一样，所以按「有尺寸」来挑，都挑不出来
 * 就退回容器里的第一个 textarea。
 */
function domOf(w) {
  const cands = [w.element, w.inputEl].filter(Boolean);
  for (const c of cands) {
    if (c.tagName === "TEXTAREA" || c.tagName === "INPUT") {
      if (c.getBoundingClientRect && c.getBoundingClientRect().height > 0) return c;
    }
  }
  for (const c of cands) {
    const inner = c.querySelector && c.querySelector("textarea, input");
    if (inner && inner.getBoundingClientRect && inner.getBoundingClientRect().height > 0) return inner;
  }
  for (const c of cands) {
    if (c.tagName === "TEXTAREA" || c.tagName === "INPUT") return c;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 值读写                                                              */
/* ------------------------------------------------------------------ */

function readValue(w) {
  if (typeof w.value === "string") return w.value;
  const dom = domOf(w);
  return dom && typeof dom.value === "string" ? dom.value : "";
}

function writeValue(node, w, text) {
  const before = w.value;
  w.value = text;

  const dom = domOf(w);
  if (dom && typeof dom.value === "string" && dom.value !== text) {
    dom.value = text;
  }

  try {
    // ComfyUI 内部靠这个把新值同步给 widgetValueStore / 触发联动
    if (typeof node.onWidgetChanged === "function") {
      node.onWidgetChanged(w.name, text, before, w);
    }
  } catch (err) {
    warn("同步 widget 值时出错（可以忽略）：", err);
  }

  try {
    app.graph && app.graph.setDirtyCanvas(true, true);
  } catch (err) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 上一条 / 下一条历史                                                  */
/* ------------------------------------------------------------------ */

/**
 * 在历史里前后翻。dir = 1 往回（更早用过的），-1 往前（更新的）。
 * 当前文本不在历史里（比如手改过）时，先跳到最近用过的那条。
 * 翻到头会绕回另一头，连续点不会卡住。
 * 只写文本框，不动历史顺序 —— 否则翻两条之后参照点就漂了。
 */
async function stepHistory(node, w, dir) {
  await ensureLib();
  const list = historyOf(currentWorkflow().key, nodeKeyOf(node));
  if (!list.length) return false;

  const cur = readValue(w);
  const idx = list.findIndex((h) => h.text === cur);
  const next = idx < 0 ? 0 : (idx + dir + list.length) % list.length;
  writeValue(node, w, list[next].text);
  return true;
}

/* ------------------------------------------------------------------ */
/* 按钮挂载                                                            */
/* ------------------------------------------------------------------ */

function nudgeStyle(btn, offset) {
  btn.style.left = offset + "px";
}

/**
 * 给一个文本 widget 挂按钮。
 * 返回 false 表示 DOM 还没准备好，稍后再试。
 */
function mountWidget(node, w) {
  if (w.__ppBtn && w.__ppBtn.isConnected) return true;

  const dom = domOf(w);
  if (!dom || !dom.parentElement) return false;
  if (!dom.getBoundingClientRect || dom.getBoundingClientRect().height <= 0) return false;

  const host = dom.parentElement;
  if (!host) return false;

  if (getComputedStyle(host).position === "static") {
    host.style.position = "relative";
  }

  const bar = el("div", "pp-btns");
  bar.dataset.ppButton = "1";

  const stop = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  };

  const mkBtn = (cls, text, title, onClick) => {
    const b = el("div", "pp-btn" + (cls ? " " + cls : ""), text);
    b.title = title;
    b.addEventListener("pointerdown", stop);
    b.addEventListener("mousedown", stop);
    b.addEventListener("dblclick", stop);
    b.addEventListener("click", (ev) => {
      stop(ev);
      onClick();
    });
    return b;
  };

  const btnPanel = mkBtn("", "P", "提示词：历史记录 / 预设", () => openPanel(node, w, bar));
  // ‹ 往回翻（更早用过的），› 往前翻（更新的）；到边界会绕回另一头
  const btnPrev = mkBtn("pp-nav", "‹", "上一条历史提示词", () => stepHistory(node, w, 1));
  const btnNext = mkBtn("pp-nav", "›", "下一条历史提示词", () => stepHistory(node, w, -1));
  bar.append(btnPanel, btnPrev, btnNext);

  // 定位到「文本框自己的」左下角：按两者实际位置差算，并把画布缩放的倍数折算回来。
  // 只按容器算会把按钮顶到 padding 外面去，所以这里始终以 textarea 的矩形为准。
  const hr = host.getBoundingClientRect();
  const dr = dom.getBoundingClientRect();
  const scale = host.offsetHeight ? hr.height / host.offsetHeight || 1 : 1;
  const left = (dr.left - hr.left) / scale + BTN_INSET;
  const bottom = (hr.bottom - dr.bottom) / scale + BTN_INSET;
  bar.style.left = Math.max(0, Math.round(left)) + "px";
  bar.style.bottom = Math.max(0, Math.round(bottom)) + "px";

  host.appendChild(bar);
  w.__ppBtn = bar;
  w.__ppLeft = parseFloat(bar.style.left) || BTN_INSET;

  // 被别的插件按钮盖住时向右让位
  requestAnimationFrame(() => avoidOverlap(w));

  return true;
}

function avoidOverlap(w) {
  const btn = w.__ppBtn;
  if (!btn || !btn.isConnected) return;

  const host = btn.parentElement;

  for (let i = 0; i <= NUDGE_MAX; i++) {
    const r = btn.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || hit === btn || btn.contains(hit)) {
      if (i > 0) w.__ppLeft = parseFloat(btn.style.left) || 0;
      return;
    }
    // 遮挡来自别的浮层（模板面板、对话框之类）时不该右移 —— 那不是同一个容器里的按钮，
    // 挪位置也躲不开，反而会把按钮顶到奇怪的地方。
    if (host && !host.contains(hit)) return;
    if (i === NUDGE_MAX) {
      // 同一个容器里实在让不开：保持位置，只把层级压上去
      btn.style.zIndex = "10000";
      return;
    }
    nudgeStyle(btn, (w.__ppLeft || 0) + NUDGE_STEP * (i + 1));
  }
}

function scanAndMount() {
  if (document.hidden) return;
  const nodes = (app.graph && app.graph._nodes) || [];
  for (const node of nodes) {
    if (!node || node.id === -1) continue;
    for (const w of node.widgets || []) {
      if (!isPromptWidget(node, w)) continue;
      if (w.__ppBtn && w.__ppBtn.isConnected) continue;
      try {
        mountWidget(node, w);
      } catch (err) {
        warn("挂按钮失败：", node.type, w.name, err);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 浮层                                                                */
/* ------------------------------------------------------------------ */

function ensureStyles() {
  if (document.getElementById("pp-style")) return;
  const css = `
  .pp-btns{position:absolute;z-index:9999;display:flex;gap:3px;}
  .pp-btn{box-sizing:border-box;display:flex;align-items:center;justify-content:center;
    width:${BTN_W}px;height:${BTN_H}px;border-radius:5px;font-size:11px;line-height:1;cursor:pointer;
    user-select:none;-webkit-user-select:none;opacity:.7;color:inherit;font-family:inherit;
    background:rgba(128,128,128,.20);border:1px solid rgba(128,128,128,.42);}
  .pp-nav{width:18px;font-size:13px;}
  .pp-btn:hover{opacity:1;background:rgba(128,128,128,.34);}
  .pp-tabs{display:flex;gap:4px;margin-bottom:6px;}
  .pp-tab{flex:1;text-align:center;padding:3px 0;border-radius:6px;cursor:pointer;font-size:12px;
    opacity:.6;border:1px solid transparent;user-select:none;}
  .pp-tab:hover{opacity:.9;background:rgba(128,128,128,.12);}
  .pp-tab.is-on{opacity:1;font-weight:600;background:rgba(128,128,128,.20);
    border-color:rgba(128,128,128,.38);}
  .pp-tab-n{font-size:11px;opacity:.6;margin-left:3px;}
  .pp-panel{position:fixed;z-index:12000;width:330px;max-height:70vh;display:flex;flex-direction:column;
    box-sizing:border-box;padding:10px;border-radius:10px;font-size:12px;line-height:1.5;
    color:var(--fg-color,#ddd);background:var(--comfy-menu-bg,#26262a);
    border:1px solid var(--border-color,rgba(128,128,128,.35));
    box-shadow:0 8px 28px rgba(0,0,0,.35);}
  .pp-head{display:flex;align-items:center;gap:6px;margin-bottom:8px;}
  .pp-title{font-weight:600;font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .pp-x{cursor:pointer;opacity:.6;padding:0 4px;font-size:14px;line-height:1;}
  .pp-x:hover{opacity:1;}
  .pp-search{width:100%;box-sizing:border-box;margin-bottom:8px;padding:4px 7px;border-radius:6px;
    font-size:12px;color:inherit;background:var(--comfy-input-bg,rgba(128,128,128,.12));
    border:1px solid var(--border-color,rgba(128,128,128,.3));outline:none;}
  .pp-scroll{overflow:auto;flex:1;min-height:0;}
  .pp-sec{display:flex;align-items:center;gap:6px;margin:2px 0 4px;}
  .pp-sec-t{font-weight:600;font-size:12px;opacity:.9;}
  .pp-sec-n{font-size:11px;opacity:.5;}
  .pp-sec-l{margin-left:auto;font-size:11px;opacity:.55;cursor:pointer;}
  .pp-sec-l:hover{opacity:.9;}
  .pp-item{display:flex;align-items:flex-start;gap:6px;padding:5px 6px;border-radius:6px;cursor:pointer;}
  .pp-item:hover{background:rgba(128,128,128,.16);}
  .pp-txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
  .pp-line{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word;}
  .pp-meta{font-size:10px;opacity:.45;}
  .pp-src{font-size:10px;opacity:.55;border:1px solid rgba(128,128,128,.35);border-radius:4px;padding:0 4px;}
  .pp-op{flex:none;font-size:11px;opacity:.65;border:1px solid rgba(128,128,128,.4);border-radius:5px;
    padding:1px 6px;cursor:pointer;background:transparent;color:inherit;font-family:inherit;}
  .pp-op:hover{opacity:1;background:rgba(128,128,128,.2);}
  .pp-empty{opacity:.45;font-size:11px;padding:4px 6px 8px;}
  .pp-rename{display:flex;gap:5px;padding:4px 6px 6px;}
  .pp-rename input{flex:1;min-width:0;box-sizing:border-box;padding:3px 6px;border-radius:5px;font-size:12px;
    color:inherit;background:var(--comfy-input-bg,rgba(128,128,128,.12));
    border:1px solid var(--border-color,rgba(128,128,128,.3));outline:none;user-select:text;-webkit-user-select:text;}
  .pp-div{height:1px;margin:8px 0;background:rgba(128,128,128,.22);}
  .pp-foot{margin-top:8px;}
  .pp-wide{width:100%;padding:3px 0;}
  .pp-select{max-width:150px;margin-left:auto;font-size:11px;padding:2px 4px;border-radius:5px;
    color:inherit;background:var(--comfy-input-bg,rgba(128,128,128,.12));
    border:1px solid var(--border-color,rgba(128,128,128,.3));outline:none;}
  .pp-select option{background:var(--comfy-menu-bg,#26262a);color:var(--fg-color,#ddd);}
  .pp-chk{display:flex;align-items:center;gap:3px;font-size:11px;opacity:.65;cursor:pointer;
    user-select:none;flex:none;}
  .pp-chk:hover{opacity:1;}
  .pp-chk input{margin:0;width:12px;height:12px;cursor:pointer;accent-color:currentColor;}
  `;
  const style = document.createElement("style");
  style.id = "pp-style";
  style.textContent = css;
  document.head.appendChild(style);
}

function closePanel() {
  if (!PANEL) return;
  if (PANEL.raf) cancelAnimationFrame(PANEL.raf);
  if (PANEL.onDocDown) document.removeEventListener("pointerdown", PANEL.onDocDown, true);
  PANEL.root.remove();
  PANEL = null;
}

function ensurePanel() {
  ensureStyles();
  if (PANEL) return PANEL;

  const root = el("div", "pp-panel");
  root.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  root.addEventListener("contextmenu", (ev) => ev.stopPropagation());

  document.body.appendChild(root);
  PANEL = { root, anchor: null, node: null, widget: null, query: "", scope: "current", tab: null };

  const onDocDown = (ev) => {
    if (!PANEL) return;
    if (PANEL.root.contains(ev.target)) return;
    if (ev.target && ev.target.dataset && ev.target.dataset.ppButton) return;
    closePanel();
  };
  PANEL.onDocDown = onDocDown;
  document.addEventListener("pointerdown", onDocDown, true);

  return PANEL;
}

function placePanel() {
  if (!PANEL) return;
  const anchor = PANEL.anchor;
  if (!anchor || !anchor.isConnected) {
    closePanel();
    return;
  }
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 锚点跑到视口外（画布被平移走了）就收起来
  if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) {
    closePanel();
    return;
  }

  const w = PANEL.w || 330;
  const h = PANEL.h || 200;

  let left = r.right + 8;
  if (left + w > vw - 8) left = r.left - w - 8;
  if (left < 8) left = Math.min(vw - w - 8, Math.max(8, r.left));

  let top = r.top;
  if (top + h > vh - 8) top = vh - h - 8;
  if (top < 8) top = 8;

  PANEL.root.style.left = Math.round(left) + "px";
  PANEL.root.style.top = Math.round(top) + "px";
}

function openPanel(node, widget, anchor) {
  const panel = ensurePanel();
  const ui = loadUI();
  panel.node = node;
  panel.widget = widget;
  panel.anchor = anchor;
  panel.query = "";
  // 接上次的浏览状态：默认看当前工作流、显示正文；停在哪个页也照旧
  panel.scope = ui.scope || "current";
  panel.tab = ui.tab || null;
  panel.detail = ui.detail !== false;
  panel.nodeKey = nodeKeyOf(node);

  renderPanel();
  placePanel();

  // 画布平移/缩放时跟着按钮走
  const tick = () => {
    if (!PANEL) return;
    placePanel();
    if (PANEL) PANEL.raf = requestAnimationFrame(tick);
  };
  if (PANEL.raf) cancelAnimationFrame(PANEL.raf);
  PANEL.raf = requestAnimationFrame(tick);

  ensureLib().then(() => {
    if (PANEL) renderPanel();
  });
}

function crossWorkflowList(scope) {
  const wfs = LIB.workflows || {};
  const keys = Object.keys(wfs);
  if (scope === "all") return keys;
  return keys.filter((k) => k === scope);
}

function renderPanel() {
  if (!PANEL) return;
  const { root, node, widget } = PANEL;
  if (!node || !widget) return;

  const wf = currentWorkflow();
  const nodeKey = PANEL.nodeKey;
  const history = historyOf(wf.key, nodeKey);
  const q = PANEL.query.toLowerCase();

  // 上次记住的那个工作流如果被删掉或改名了，退回「当前工作流」，否则会一片空白
  if (PANEL.scope !== "current" && PANEL.scope !== "all" && !(LIB.workflows || {})[PANEL.scope]) {
    PANEL.scope = "current";
  }

  const match = (s) => !q || String(s || "").toLowerCase().includes(q);

  root.innerHTML = "";

  // 头部
  const head = el("div", "pp-head");
  head.appendChild(el("div", "pp-title", "提示词预设"));
  const x = el("div", "pp-x", "✕");
  x.title = "关闭";
  x.onclick = closePanel;
  head.appendChild(x);
  root.appendChild(head);

  // 搜索
  const search = el("input", "pp-search");
  search.placeholder = "搜索历史 / 预设…";
  search.value = PANEL.query;
  search.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  search.addEventListener("input", () => {
    PANEL.query = search.value;
    PANEL.focusSearch = true;
    PANEL.keepScroll = scroll ? scroll.scrollTop : 0;
    renderPanel();
  });
  root.appendChild(search);

  const scroll = el("div", "pp-scroll");

  // 历史和预设分成两个选项卡，免得历史长了把预设压到看不见
  const scopedKeys = crossWorkflowList(PANEL.scope === "current" ? wf.key : PANEL.scope);
  const presetCount = scopedKeys.reduce((n, k) => n + presetsOf(k).length, 0);
  if (!PANEL.tab) PANEL.tab = history.length ? "history" : "presets";

  const tabs = el("div", "pp-tabs");
  const mkTab = (id, label, count) => {
    const t = el("div", "pp-tab" + (PANEL.tab === id ? " is-on" : ""));
    t.appendChild(document.createTextNode(label));
    t.appendChild(el("span", "pp-tab-n", String(count)));
    t.onclick = (ev) => {
      ev.stopPropagation();
      if (PANEL.tab === id) return;
      PANEL.tab = id;
      PANEL.keepScroll = 0;
      saveUI();
      renderPanel();
    };
    return t;
  };
  tabs.appendChild(mkTab("history", "历史", history.length));
  tabs.appendChild(mkTab("presets", "预设", presetCount));
  root.appendChild(tabs);
  root.appendChild(scroll);

  /* ---------------- 历史 ---------------- */
  if (PANEL.tab === "history") {
  const shownHistory = history.filter((h) => match(h.text));
  const hsec = el("div", "pp-sec");
  hsec.appendChild(el("div", "pp-sec-t", "本节点历史"));
  hsec.appendChild(el("div", "pp-sec-n", `${history.length}/${HISTORY_LIMIT}`));
  if (history.length) {
    const clr = el("div", "pp-sec-l", "清空");
    clr.onclick = async () => {
      try {
        await postJSON("/history/clear", { workflow: wf.key, node: nodeKey });
        renderPanel();
      } catch (err) {
        warn("清空历史失败：", err);
      }
    };
    hsec.appendChild(clr);
  }
  scroll.appendChild(hsec);

  if (!history.length) {
    scroll.appendChild(el("div", "pp-empty", "这个节点还没有历史。执行一次就会自动记下。"));
  } else if (!shownHistory.length) {
    scroll.appendChild(el("div", "pp-empty", "没有匹配的历史。"));
  } else {
    for (const item of shownHistory) {
      scroll.appendChild(historyRow(item));
    }
  }

  }

  /* ---------------- 预设 ---------------- */
  if (PANEL.tab === "presets") {
  const psec = el("div", "pp-sec");
  psec.appendChild(el("div", "pp-sec-t", "预设"));

  const select = el("select", "pp-select");
  select.onpointerdown = (ev) => ev.stopPropagation();
  const curOpt = document.createElement("option");
  curOpt.value = "current";
  curOpt.textContent = `当前工作流 · ${wf.name.length > 8 ? wf.name.slice(0, 8) + "…" : wf.name}`;
  select.appendChild(curOpt);

  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = "全部工作流";
  select.appendChild(allOpt);

  for (const key of Object.keys(LIB.workflows || {})) {
    if (key === wf.key) continue;
    const o = document.createElement("option");
    o.value = key;
    o.textContent = LIB.workflows[key].name || key;
    select.appendChild(o);
  }
  select.value = PANEL.scope;
  select.onchange = () => {
    PANEL.scope = select.value;
    saveUI();
    renderPanel();
  };
  psec.appendChild(select);

  // 只看标题：预设存多了以后一屏能扫过更多条
  const chkWrap = el("label", "pp-chk");
  chkWrap.title = "关闭后只显示标题，列表更紧凑";
  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.checked = PANEL.detail;
  chk.onpointerdown = (ev) => ev.stopPropagation();
  chk.onchange = () => {
    PANEL.detail = chk.checked;
    saveUI();
    renderPanel();
  };
  chkWrap.append(chk, document.createTextNode("详细"));
  psec.appendChild(chkWrap);

  scroll.appendChild(psec);

  const keys = crossWorkflowList(PANEL.scope === "current" ? wf.key : PANEL.scope);
  let shown = 0;
  for (const key of keys) {
    const list = presetsOf(key).filter((p) => match(p.name) || match(p.text));
    for (const preset of list) {
      scroll.appendChild(presetRow(preset, key, key !== wf.key ? LIB.workflows[key]?.name : null));
      shown++;
    }
  }

  if (!shown) {
    scroll.appendChild(
      el("div", "pp-empty", q ? "没有匹配的预设。" : "还没有预设。历史里那条右边的「存为」可以存一条。")
    );
  }
  }

  // 底部：把当前文本框内容存成预设
  const foot = el("div", "pp-foot");
  const save = el("button", "pp-op pp-wide", "把当前内容存为预设");
  save.onclick = (ev) => {
    ev.stopPropagation();
    startSaveCurrent(foot);
  };
  foot.appendChild(save);
  root.appendChild(foot);

  PANEL.w = root.offsetWidth;
  PANEL.h = root.offsetHeight;

  // 重绘后把焦点和滚动位置还回去，否则一边打字一边丢焦点
  if (PANEL.keepScroll) {
    scroll.scrollTop = PANEL.keepScroll;
    PANEL.keepScroll = 0;
  }
  if (PANEL.focusSearch) {
    PANEL.focusSearch = false;
    try {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    } catch (err) {
      /* ignore */
    }
  }

  function historyRow(item) {
    const row = el("div", "pp-item");
    const txt = el("div", "pp-txt");
    txt.appendChild(el("div", "pp-line", preview(item.text, 90)));
    const meta = el("div", "pp-meta", fmtTime(item.ts));
    txt.appendChild(meta);

    const saveBtn = el("button", "pp-op", "存为");
    saveBtn.onclick = (ev) => {
      ev.stopPropagation();
      startSaveRow(row, item.text);
    };

    row.appendChild(txt);
    row.appendChild(saveBtn);
    row.onclick = () => applyAndKeep(item.text);
    return row;
  }

  function presetRow(preset, key, sourceName) {
    const row = el("div", "pp-item");
    const txt = el("div", "pp-txt");
    const line = el("div", "pp-line", preset.name || guessName(preset.text));
    txt.appendChild(line);
    if (PANEL.detail && preset.text && preset.text !== preset.name) {
      const sub = el("div", "pp-meta", preview(preset.text, 50));
      txt.appendChild(sub);
    }
    if (sourceName) {
      const src = el("span", "pp-src", sourceName);
      src.style.alignSelf = "flex-start";
      txt.appendChild(src);
    }

    const del = el("button", "pp-op", "删");
    del.title = "删除这条预设";
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!window.confirm(`删除预设「${preset.name}」？`)) return;
      try {
        await postJSON("/preset/delete", { workflow: key, id: preset.id });
        renderPanel();
      } catch (err) {
        warn("删除失败：", err);
      }
    };

    row.appendChild(txt);
    row.appendChild(del);
    row.onclick = () => applyAndKeep(preset.text);
    return row;
  }

  function startSaveRow(row, text) {
    if (row.__ppForm) return;
    const form = el("div", "pp-rename");
    const input = el("input");
    input.value = guessName(text);
    input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") commit();
      if (ev.key === "Escape") cancel();
      ev.stopPropagation();
    });

    const ok = el("button", "pp-op", "存");
    ok.onclick = (ev) => {
      ev.stopPropagation();
      commit();
    };
    const no = el("button", "pp-op", "取消");
    no.onclick = (ev) => {
      ev.stopPropagation();
      cancel();
    };

    form.append(input, ok, no);
    row.after(form);
    row.__ppForm = form;
    row.style.display = "none";
    input.focus();
    input.select();

    async function commit() {
      try {
        await postJSON("/preset", {
          workflow: currentWorkflow().key,
          name: input.value.trim(),
          text,
        });
        cancel();
        renderPanel();
      } catch (err) {
        warn("保存预设失败：", err);
      }
    }

    function cancel() {
      form.remove();
      row.__ppForm = null;
      row.style.display = "";
    }
  }

  function startSaveCurrent(foot) {
    const text = readValue(widget);
    if (!text.trim()) {
      window.alert("文本框是空的，没有可保存的内容。");
      return;
    }
    if (foot.__ppForm) {
      const i = foot.querySelector("input");
      if (i) i.focus();
      return;
    }

    const form = el("div", "pp-rename");
    const input = el("input");
    input.value = guessName(text);
    input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") commit();
      if (ev.key === "Escape") cancel();
      ev.stopPropagation();
    });

    const ok = el("button", "pp-op", "存");
    ok.onclick = (ev) => {
      ev.stopPropagation();
      commit();
    };
    const no = el("button", "pp-op", "取消");
    no.onclick = (ev) => {
      ev.stopPropagation();
      cancel();
    };

    form.append(input, ok, no);
    foot.innerHTML = "";
    foot.appendChild(form);
    foot.__ppForm = form;
    input.focus();
    input.select();

    async function commit() {
      try {
        await postJSON("/preset", {
          workflow: currentWorkflow().key,
          name: input.value.trim(),
          text,
        });
        renderPanel();
      } catch (err) {
        warn("保存预设失败：", err);
      }
    }

    function cancel() {
      renderPanel();
    }
  }

  function applyAndKeep(text) {
    writeValue(node, widget, text);
  }
}

/* ------------------------------------------------------------------ */
/* 历史记录：提交执行成功后写入                                          */
/* ------------------------------------------------------------------ */

let recordEnabled = true;

function collectPrompts() {
  const out = [];
  const nodes = (app.graph && app.graph._nodes) || [];
  for (const node of nodes) {
    if (!node || node.id === -1) continue;
    // 静音 / 绕过的节点不会真正执行，不该算「用过」
    if (node.mode) continue;
    for (const w of node.widgets || []) {
      if (!isPromptWidget(node, w)) continue;
      const v = readValue(w);
      if (typeof v === "string" && v.trim()) {
        out.push({ node: nodeKeyOf(node), text: v });
      }
    }
  }
  return out;
}

async function sendHistory(wfKey, items) {
  if (!items.length) return;
  const byNode = new Map();
  for (const it of items) {
    if (!byNode.has(it.node)) byNode.set(it.node, []);
    byNode.get(it.node).push(it.text);
  }
  for (const [nodeKey, texts] of byNode) {
    try {
      const data = await postJSON("/history", { workflow: wfKey, node: nodeKey, texts });
      if (data && Array.isArray(data.items)) {
        // /history 只回这个节点的桶（不返全量 state），所以本地没有这条工作流时
        // 得自己建一个占位，否则面板读不到刚记进去的历史。
        let wf = workflowOf(wfKey);
        if (!wf) {
          wf = { key: wfKey, name: wfKey === UNSAVED ? "未保存的工作流" : wfKey, presets: [], history: {} };
          LIB.workflows = LIB.workflows || {};
          LIB.workflows[wfKey] = wf;
        }
        wf.history = wf.history || {};
        wf.history[nodeKey] = data.items;
        LIB.counts = LIB.counts || { presets: 0, workflows: 0 };
        LIB.counts.workflows = Object.keys(LIB.workflows).length;

        // 面板开在这个节点上就顺手刷新一下
        if (PANEL && PANEL.nodeKey === nodeKey) {
          renderPanel();
        }
      }
    } catch (err) {
      warn("记录历史失败：", err);
    }
  }
}

function hookQueue() {
  const orig = app.queuePrompt;
  if (typeof orig !== "function") {
    warn("没找到 app.queuePrompt，历史记录不可用");
    return;
  }
  if (orig.__ppHooked) return;

  const wrapped = async function (...args) {
    // 提交前快照：拿到的是「这次真正要跑」的文本
    let snapshot = [];
    let wfKey = UNSAVED;
    try {
      snapshot = collectPrompts();
      wfKey = currentWorkflow().key;
    } catch (err) {
      warn("提交前读取文本失败：", err);
    }

    const result = await orig.apply(app, args);

    if (recordEnabled && result !== false && snapshot.length) {
      sendHistory(wfKey, snapshot);
    }
    return result;
  };

  wrapped.__ppHooked = true;
  app.queuePrompt = wrapped;
  log("已接管提交事件，历史会在每次执行成功后记录");
}

/* ------------------------------------------------------------------ */
/* 注册                                                                */
/* ------------------------------------------------------------------ */

// 排查 / 自检用的钩子，不参与功能
window.PromptPresets = {
  reload: () => {
    libReady = false;
    return ensureLib();
  },
  state: () => LIB,
  workflow: () => currentWorkflow(),
  panel: () => PANEL,
  rescan: () => scanAndMount(),
};

app.registerExtension({
  name: "PromptPresets.Main",

  async setup() {
    ensureStyles();
    hookQueue();

    await ensureLib().catch(() => null);

    // 新节点 / 复制节点 / 载入工作流，统一靠这个轮询兜底。
    // 每轮只做属性判断，已经挂上的直接跳过，成本可以忽略。
    scanAndMount();
    setInterval(scanAndMount, 700);

    // 载入工作流后 DOM 是异步挂的，多扫几轮
    [200, 600, 1500, 3000].forEach((ms) => setTimeout(scanAndMount, ms));

    log("已加载，预设库：", LIB.counts || {});
  },
});
