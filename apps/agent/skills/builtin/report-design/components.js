/**
 * Aurevoy Report Components v3.0
 *
 * Web Component 库——封装所有报告 UI 组件，通过 Shadow DOM 强制设计一致性。
 * Agent 只需使用自定义元素 + 属性/插槽填充内容，无需编写 CSS/布局代码。
 *
 * 使用方式：
 *   <script src="./components.js"></script>
 *
 * 设计原则：
 *   - 所有样式通过 Shadow DOM 封装，外部 CSS 无法侵入
 *   - 通过 CSS 自定义属性（--bg, --text, --accent 等）适配 Light/Dark 双模式
 *   - 组件通过 attributes 接收数据，通过 <slot> 接收富文本内容
 *   - Agent 无法写出偏离设计规范的 HTML——组件只暴露语义化 API
 */
(function () {
  'use strict';

  /* ================================================================
     Shared: Design Tokens (injected into each Shadow DOM)
     ================================================================ */
  const TOKENS = `
    :host {
      --bg: #ffffff; --surface: #f8f8f8; --surface-strong: #eeeeef;
      --border: #ececef; --border-strong: #dedee3;
      --text: #202124; --text-secondary: #686a70; --text-tertiary: #9a9ca3;
      --accent: #1f2328; --accent-contrast: #ffffff;
      --online: #2ea043; --offline: #d14343; --warn: #d29922; --info: #0969da;
      --card-bg: #ffffff; --card-shadow: 0 8px 28px rgba(31,35,40,0.08);
      --code-bg: #f0f0ee; --pill-bg: #efefec; --pill-fg: var(--text-secondary);
      --info-bg: #ddf4ff; --info-border: #54aeff;
      --warn-bg: #fff8c5; --warn-border: #d4a72c;
      --success-bg: #dafbe1; --success-border: #2ea043;
      --danger-bg: #ffebe9; --danger-border: #d14343;
      --score-high: #2ea043; --score-mid: #d29922; --score-low: #d14343;
      --fs-xs: 11px; --fs-sm: 12px; --fs-base: 13px; --fs-md: 14px;
      --fs-lg: 18px; --fs-xl: 24px; --fs-h1: 26px; --fs-num: 30px;
      --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
      --space-5: 20px; --space-6: 24px; --space-8: 32px;
      --radius-sm: 6px; --radius-md: 8px; --radius-lg: 12px;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --bg: #1c1c1e; --surface: #232325; --surface-strong: #2a2a2e;
        --border: #2c2c2e; --border-strong: #3a3a3c;
        --text: #f2f2f4; --text-secondary: #a0a0a6; --text-tertiary: #6e6e74;
        --accent: #f2f2f4; --accent-contrast: #1c1c1e;
        --card-bg: #232325; --card-shadow: 0 12px 32px rgba(0,0,0,0.34);
        --code-bg: #2a2a2e; --pill-bg: #2a2a2e;
        --info-bg: #0d2d44; --warn-bg: #3d2e00;
        --success-bg: #0d3321; --danger-bg: #3d1117;
      }
    }
  `;

  const BASE_STYLE = `
    :host {
      display: block;
      font-family: var(--font);
      font-size: var(--fs-base);
      color: var(--text);
      line-height: 1.7;
    }
  `;

  function sheet(css) {
    const s = new CSSStyleSheet();
    s.replaceSync(css);
    return s;
  }

  /* ================================================================
     Utility
     ================================================================ */
  function attr(el, name, fallback) {
    const v = el.getAttribute(name);
    return v !== null ? v : fallback;
  }
  function hasAttr(el, name) { return el.hasAttribute(name); }

  /* ================================================================
     <report-container> — 页面容器
     ================================================================ */
  customElements.define('report-container', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + `
        :host {
          max-width: 880px; margin: 0 auto;
          background: var(--card-bg); border-radius: var(--radius-lg);
          box-shadow: var(--card-shadow); padding: 40px 32px;
        }
        @media (max-width: 640px) {
          :host { padding: 24px 16px; border-radius: 0; }
        }
      `)];
      const s = document.createElement('slot');
      this.shadowRoot.appendChild(s);
    }
  });

  /* ================================================================
     <report-header> — 报告头部
     ================================================================ */
  customElements.define('report-header', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const badge = attr(this, 'badge', '报告');
      const date = attr(this, 'date', '');
      const title = attr(this, 'title', '');
      const summary = attr(this, 'summary', '');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: block; margin-bottom: 32px; }
        .meta { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
        .badge { display: inline-flex; padding: 2px 10px; border-radius: 999px;
          background: var(--pill-bg); color: var(--pill-fg);
          font-size: var(--fs-xs); font-weight: 600; }
        .date { font-size: var(--fs-xs); color: var(--text-tertiary); padding-top: 3px; }
        h1 { font-size: var(--fs-h1); font-weight: 750; letter-spacing: -0.02em;
          line-height: 1.25; color: var(--accent); margin: 0 0 12px; }
        .summary { font-size: var(--fs-md); color: var(--text-secondary); line-height: 1.6;
          padding-bottom: 24px; border-bottom: 1px solid var(--border); }
      `)];
      this.shadowRoot.innerHTML = `
        <div class="meta">
          <span class="badge">${badge}</span>
          ${date ? `<span class="date">${date}</span>` : ''}
        </div>
        <h1>${title}</h1>
        ${summary ? `<p class="summary">${summary}</p>` : ''}
      `;
    }
  });

  /* ================================================================
     <report-stat-cards> + <report-stat-card> — 统计卡片网格
     ================================================================ */
  customElements.define('report-stat-cards', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const cols = attr(this, 'cols', 'auto-fit');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + `
        :host {
          display: grid;
          grid-template-columns: repeat(${cols}, minmax(150px, 1fr));
          gap: 16px; margin: 16px 0;
        }
        ::slotted(report-stat-card) { height: 100%; }
      `)];
      this.shadowRoot.appendChild(document.createElement('slot'));
    }
  });

  customElements.define('report-stat-card', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const value = attr(this, 'value', '');
      const label = attr(this, 'label', '');
      const change = attr(this, 'change', '');
      const direction = attr(this, 'direction', ''); // up / down
      const accent = hasAttr(this, 'accent');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: block; }
        .card {
          background: var(--surface); border: 1px solid var(--border);
          border-radius: var(--radius-md); padding: 20px;
          text-align: center; transition: box-shadow 0.15s;
        }
        .card:hover { box-shadow: var(--card-shadow); }
        .card.accent { background: var(--accent); border-color: var(--accent); }
        .value { font-size: var(--fs-num); font-weight: 750; color: var(--accent);
          line-height: 1.2; margin-bottom: 4px; }
        .accent .value, .accent .label, .accent .change { color: var(--accent-contrast); }
        .label { font-size: var(--fs-xs); color: var(--text-tertiary);
          text-transform: uppercase; letter-spacing: 0.04em; }
        .change { font-size: var(--fs-xs); margin-top: 4px; }
        .change.up { color: var(--online); }
        .change.down { color: var(--offline); }
      `)];
      this.shadowRoot.innerHTML = `
        <div class="card${accent ? ' accent' : ''}">
          <div class="value">${value}</div>
          <div class="label">${label}</div>
          ${change ? `<div class="change${direction ? ' ' + direction : ''}">${change}</div>` : ''}
        </div>
      `;
    }
  });

  /* ================================================================
     <report-card-grid> + <report-card> — 卡片网格
     ================================================================ */
  customElements.define('report-card-grid', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + `
        :host {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 16px; margin: 16px 0;
        }
      `)];
      this.shadowRoot.appendChild(document.createElement('slot'));
    }
  });

  customElements.define('report-card', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const title = attr(this, 'title', '');
      const badge = attr(this, 'badge', '');
      const badgeType = attr(this, 'badge-type', 'default');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: block; }
        .card {
          background: var(--card-bg); border: 1px solid var(--border);
          border-radius: var(--radius-md); padding: 20px; transition: box-shadow 0.15s;
        }
        .card:hover { box-shadow: var(--card-shadow); }
        h4 { font-size: var(--fs-md); font-weight: 640; color: var(--accent);
          margin: 0 0 8px; }
        .body { font-size: var(--fs-sm); color: var(--text-secondary); }
        .meta { font-size: var(--fs-xs); color: var(--text-tertiary);
          margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);
          display: flex; align-items: center; gap: 8px; }
        .tag { display: inline-flex; padding: 1px 8px; border-radius: 999px;
          font-size: 10px; font-weight: 600; line-height: 1.5; }
        .tag-success { background: var(--success-bg); color: var(--score-high); }
        .tag-warn { background: var(--warn-bg); color: var(--warn); }
        .tag-info { background: var(--info-bg); color: var(--info); }
        .tag-default { background: var(--pill-bg); color: var(--pill-fg); }
        .tag-danger { background: var(--danger-bg); color: var(--score-low); }
      `)];
      const tagHtml = badge ? `<span class="tag tag-${badgeType}">${badge}</span>` : '';
      this.shadowRoot.innerHTML = `
        <div class="card">
          <h4>${title}</h4>
          <div class="body"><slot></slot></div>
          ${tagHtml ? `<div class="meta">${tagHtml}</div>` : ''}
        </div>
      `;
    }
  });

  /* ================================================================
     <report-timeline> + <report-timeline-item> — 时间线
     ================================================================ */
  customElements.define('report-timeline', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + `
        .tl { position: relative; padding-left: 32px; }
        .tl::before { content: ''; position: absolute; left: 11px; top: 0; bottom: 0;
          width: 2px; background: var(--border-strong); }
        ::slotted(report-timeline-item) { display: block; margin-bottom: 24px; }
        ::slotted(report-timeline-item:last-child) { margin-bottom: 0; }
      `)];
      const div = document.createElement('div');
      div.className = 'tl';
      div.appendChild(document.createElement('slot'));
      this.shadowRoot.appendChild(div);
    }
  });

  customElements.define('report-timeline-item', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const date = attr(this, 'date', '');
      const title = attr(this, 'title', '');
      const status = attr(this, 'status', ''); // done / active / ''
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: block; position: relative; }
        :host::before {
          content: ''; position: absolute; left: -25px; top: 5px;
          width: 10px; height: 10px; border-radius: 50%;
          background: var(--accent);
          border: 2px solid var(--card-bg);
          box-shadow: 0 0 0 2px var(--border);
        }
        :host([status="done"])::before,
        :host([status="active"])::before { background: var(--online); box-shadow: 0 0 0 2px var(--online); }
        .date { font-size: var(--fs-xs); color: var(--text-tertiary); margin-bottom: 4px; }
        .title { font-weight: 640; color: var(--accent); margin-bottom: 4px; }
        .desc { font-size: var(--fs-sm); color: var(--text-secondary); }
      `)];
      this.shadowRoot.innerHTML = `
        ${date ? `<div class="date">${date}</div>` : ''}
        ${title ? `<div class="title">${title}</div>` : ''}
        <div class="desc"><slot></slot></div>
      `;
    }
  });

  /* ================================================================
     <report-score-matrix> + <report-score-row> + <report-score-cell> — 评分矩阵
     ================================================================ */
  customElements.define('report-score-matrix', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const cols = attr(this, 'cols', '3');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + `
        :host { display: block; margin: 16px 0; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
        ::slotted(report-score-head) th {
          background: var(--surface); color: var(--text-secondary); font-weight: 600;
          text-align: center; padding: 12px 16px;
          border-bottom: 1px solid var(--border-strong);
        }
        ::slotted(report-score-head) th:first-child { text-align: left; }
        ::slotted(report-score-row) td {
          padding: 12px 16px; border-bottom: 1px solid var(--border); text-align: center;
        }
        ::slotted(report-score-row) td:first-child {
          font-weight: 600; color: var(--accent); text-align: left;
        }
        ::slotted(report-score-foot) td {
          font-weight: 700; background: var(--surface-strong);
          border-top: 2px solid var(--border-strong); padding: 12px 16px;
        }
      `)];
      this.shadowRoot.innerHTML = '<table><thead><slot name="head"></slot></thead><tbody><slot></slot></tbody><tfoot><slot name="foot"></slot></tfoot></table>';
    }
  });

  customElements.define('report-score-cell', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const value = attr(this, 'value', '');
      const level = attr(this, 'level', ''); // high / mid / low
      const color = level === 'high' ? 'var(--score-high)' : level === 'mid' ? 'var(--score-mid)' : level === 'low' ? 'var(--score-low)' : 'var(--text)';
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        span { font-weight: 640; color: ${color}; }
      `)];
      this.shadowRoot.innerHTML = `<span>${value}</span>`;
    }
  });

  /* ================================================================
     <report-progress> + <report-progress-bar> — 进度条
     ================================================================ */
  customElements.define('report-progress', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + `
        :host { display: block; margin: 16px 0; }
        ::slotted(report-progress-bar) { display: block; margin-bottom: 12px; }
      `)];
      this.shadowRoot.appendChild(document.createElement('slot'));
    }
  });

  customElements.define('report-progress-bar', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const label = attr(this, 'label', '');
      const pct = Math.min(100, Math.max(0, parseFloat(attr(this, 'value', '0')) || 0));
      const level = attr(this, 'level', ''); // high / mid / low
      const fillColor = level === 'high' ? 'var(--score-high)' : level === 'mid' ? 'var(--score-mid)' : level === 'low' ? 'var(--score-low)' : 'var(--accent)';
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: block; }
        .row { display: flex; align-items: center; gap: 16px; }
        .label { min-width: 100px; font-size: var(--fs-sm); color: var(--text-secondary); }
        .track { flex: 1; height: 8px; background: var(--surface-strong);
          border-radius: 999px; overflow: hidden; }
        .fill { height: 100%; border-radius: 999px; background: ${fillColor};
          width: ${pct}%; transition: width 0.6s ease; }
        .val { min-width: 42px; text-align: right; font-size: var(--fs-xs);
          color: var(--text-tertiary); font-weight: 600; }
      `)];
      this.shadowRoot.innerHTML = `
        <div class="row">
          <div class="label">${label}</div>
          <div class="track"><div class="fill"></div></div>
          <div class="val">${pct}%</div>
        </div>
      `;
    }
  });

  /* ================================================================
     <report-bar-chart> + <report-bar> — CSS 条形图
     ================================================================ */
  customElements.define('report-bar-chart', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + `
        :host { display: block; margin: 16px 0; }
        ::slotted(report-bar) { display: block; margin-bottom: 12px; }
      `)];
      this.shadowRoot.appendChild(document.createElement('slot'));
    }
  });

  customElements.define('report-bar', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const label = attr(this, 'label', '');
      const pct = Math.min(100, Math.max(1, parseFloat(attr(this, 'value', '50')) || 50));
      const level = attr(this, 'level', ''); // high / mid / low
      const fillColor = level === 'high' ? 'var(--score-high)' : level === 'mid' ? 'var(--score-mid)' : level === 'low' ? 'var(--score-low)' : 'var(--accent)';
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: block; }
        .row { display: flex; align-items: center; gap: 16px; }
        .label { min-width: 100px; font-size: var(--fs-sm); color: var(--text-secondary); text-align: right; }
        .track { flex: 1; height: 24px; background: var(--surface-strong);
          border-radius: var(--radius-sm); overflow: hidden; }
        .fill { height: 100%; border-radius: var(--radius-sm); background: ${fillColor};
          width: ${pct}%; display: flex; align-items: center; padding-left: 8px;
          transition: width 0.6s ease; }
        .fill-text { font-size: var(--fs-xs); color: var(--accent-contrast); font-weight: 600;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .val { font-size: var(--fs-xs); color: var(--text-tertiary); min-width: 48px; font-weight: 600; }
      `)];
      this.shadowRoot.innerHTML = `
        <div class="row">
          <div class="label">${label}</div>
          <div class="track"><div class="fill"><span class="fill-text"><slot></slot></span></div></div>
          <div class="val"><slot></slot></div>
        </div>
      `;
    }
  });

  /* ================================================================
     <report-steps> + <report-step> — 步骤指示器
     ================================================================ */
  customElements.define('report-steps', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + `
        :host { display: flex; gap: 8px; margin: 24px 0; flex-wrap: wrap; }
        ::slotted(report-step) { flex: 1; min-width: 110px; }
      `)];
      this.shadowRoot.appendChild(document.createElement('slot'));
    }
  });

  customElements.define('report-step', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const num = attr(this, 'num', '');
      const title = attr(this, 'title', '');
      const desc = attr(this, 'desc', '');
      const active = hasAttr(this, 'active');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: block; }
        .step { padding: 16px; text-align: center; background: var(--surface);
          border-radius: var(--radius-md); border: 1px solid var(--border); }
        .step.active { background: var(--accent); border-color: var(--accent); }
        .num { display: inline-flex; align-items: center; justify-content: center;
          width: 28px; height: 28px; border-radius: 50%;
          background: var(--border-strong); color: var(--text-secondary);
          font-size: var(--fs-xs); font-weight: 700; margin-bottom: 8px; }
        .active .num { background: var(--accent-contrast); color: var(--accent); }
        .title { font-weight: 640; font-size: var(--fs-sm); color: var(--accent);
          margin-bottom: 4px; }
        .active .title, .active .desc { color: var(--accent-contrast); }
        .desc { font-size: var(--fs-xs); color: var(--text-tertiary); }
      `)];
      this.shadowRoot.innerHTML = `
        <div class="step${active ? ' active' : ''}">
          ${num ? `<div class="num">${num}</div>` : ''}
          ${title ? `<div class="title">${title}</div>` : ''}
          ${desc ? `<div class="desc">${desc}</div>` : ''}
        </div>
      `;
    }
  });

  /* ================================================================
     <report-pros-cons> + <report-pros> + <report-cons> — 优劣对比
     ================================================================ */
  customElements.define('report-pros-cons', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + `
        :host { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 0; }
        @media (max-width: 600px) { :host { grid-template-columns: 1fr; } }
      `)];
      this.shadowRoot.appendChild(document.createElement('slot'));
    }
  });

  customElements.define('report-pros', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const title = attr(this, 'title', '优势');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: block; padding: 16px; border-radius: var(--radius-md);
          background: var(--success-bg); border: 1px solid var(--success-border); }
        h4 { font-size: var(--fs-md); font-weight: 640; margin: 0 0 12px; color: var(--score-high); }
        ::slotted(li) { font-size: var(--fs-sm); margin-bottom: 8px; }
      `)];
      this.shadowRoot.innerHTML = `<h4>✅ ${title}</h4><ul><slot></slot></ul>`;
    }
  });

  customElements.define('report-cons', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const title = attr(this, 'title', '劣势');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: block; padding: 16px; border-radius: var(--radius-md);
          background: var(--danger-bg); border: 1px solid var(--danger-border); }
        h4 { font-size: var(--fs-md); font-weight: 640; margin: 0 0 12px; color: var(--score-low); }
        ::slotted(li) { font-size: var(--fs-sm); margin-bottom: 8px; }
      `)];
      this.shadowRoot.innerHTML = `<h4>⚠️ ${title}</h4><ul><slot></slot></ul>`;
    }
  });

  /* ================================================================
     <report-callout> — 标注框
     ================================================================ */
  customElements.define('report-callout', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const type = attr(this, 'type', 'info'); // info / warn / success / danger
      const title = attr(this, 'title', '');
      const icons = { info: 'ℹ️', warn: '⚠️', success: '✅', danger: '🚫' };
      const icon = icons[type] || icons.info;
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: block; margin: 16px 0; padding: 16px; border-radius: var(--radius-md);
          border-left: 4px solid; font-size: var(--fs-sm); line-height: 1.6; }
        :host([type="info"]) { background: var(--info-bg); border-color: var(--info-border); }
        :host([type="warn"]) { background: var(--warn-bg); border-color: var(--warn-border); }
        :host([type="success"]) { background: var(--success-bg); border-color: var(--success-border); }
        :host([type="danger"]) { background: var(--danger-bg); border-color: var(--danger-border); }
        .title { font-weight: 640; margin-bottom: 8px; }
        ::slotted(p) { margin: 0; }
        ::slotted(p:not(:last-child)) { margin-bottom: 8px; }
      `)];
      this.shadowRoot.innerHTML = `
        ${title ? `<div class="title">${icon} ${title}</div>` : ''}
        <slot></slot>
      `;
    }
  });

  /* ================================================================
     <report-findings> + <report-finding> — 关键发现
     ================================================================ */
  customElements.define('report-findings', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const title = attr(this, 'title', '关键发现');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: block; margin: 24px 0; padding: 24px;
          background: var(--surface); border-radius: var(--radius-lg);
          border: 1px solid var(--border); }
        h3 { font-size: var(--fs-lg); color: var(--accent); margin: 0 0 16px; }
        ::slotted(report-finding) { display: block; margin-bottom: 12px; }
        ::slotted(report-finding:last-child) { margin-bottom: 0; }
      `)];
      this.shadowRoot.innerHTML = `<h3>${title}</h3><slot></slot>`;
    }
  });

  customElements.define('report-finding', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const type = attr(this, 'type', 'fact'); // fact / risk / action
      const icons = { fact: '•', risk: '!', action: '→' };
      const colors = { fact: 'var(--info)', risk: 'var(--warn)', action: 'var(--online)' };
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: flex; gap: 12px; align-items: flex-start; }
        .icon { flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 12px; font-weight: 700; color: white; margin-top: 2px;
          background: ${colors[type] || colors.fact}; }
        .text { font-size: var(--fs-sm); color: var(--text); line-height: 1.6; }
      `)];
      this.shadowRoot.innerHTML = `<div class="icon">${icons[type] || icons.fact}</div><div class="text"><slot></slot></div>`;
    }
  });

  /* ================================================================
     <report-decision> — 决策卡
     ================================================================ */
  customElements.define('report-decision', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const title = attr(this, 'title', '建议');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host {
          display: block; margin: 24px 0; padding: 24px;
          background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 85%, var(--info)));
          border-radius: var(--radius-lg); color: var(--accent-contrast);
        }
        h3 { color: var(--accent-contrast); font-size: var(--fs-lg); margin: 0 0 12px; }
        ::slotted(p) { opacity: 0.9; line-height: 1.7; margin: 0; }
        ::slotted(p:not(:last-child)) { margin-bottom: 12px; }
      `)];
      this.shadowRoot.innerHTML = `<h3>${title}</h3><slot></slot>`;
    }
  });

  /* ================================================================
     <report-tag> — 内联标签 / 徽章
     ================================================================ */
  customElements.define('report-tag', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const type = attr(this, 'type', 'default');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: inline-flex; padding: 1px 8px; border-radius: 999px;
          font-size: var(--fs-xs); font-weight: 600; line-height: 1.5; white-space: nowrap; }
        :host([type="default"]) { background: var(--pill-bg); color: var(--pill-fg); }
        :host([type="success"]) { background: var(--success-bg); color: var(--score-high); }
        :host([type="warn"]) { background: var(--warn-bg); color: var(--warn); }
        :host([type="danger"]) { background: var(--danger-bg); color: var(--score-low); }
        :host([type="info"]) { background: var(--info-bg); color: var(--info); }
      `)];
      this.shadowRoot.appendChild(document.createElement('slot'));
    }
  });

  /* ================================================================
     <report-accordion> + <report-accordion-item> — 折叠面板
     ================================================================ */
  customElements.define('report-accordion', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + `
        :host { display: block; margin: 16px 0; }
      `)];
      this.shadowRoot.appendChild(document.createElement('slot'));
    }
  });

  customElements.define('report-accordion-item', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const title = attr(this, 'title', '');
      const open = hasAttr(this, 'open');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: block; border: 1px solid var(--border);
          border-radius: var(--radius-md); margin-bottom: 8px; overflow: hidden; }
        :host(:last-child) { margin-bottom: 0; }
        .header { padding: 12px 16px; background: var(--surface); font-weight: 640;
          font-size: var(--fs-sm); color: var(--accent); cursor: pointer;
          display: flex; justify-content: space-between; align-items: center;
          user-select: none; }
        .header:hover { background: var(--surface-strong); }
        .arrow { font-size: var(--fs-xs); color: var(--text-tertiary); transition: transform 0.2s; }
        :host([open]) .arrow { transform: rotate(180deg); }
        .body { display: none; padding: 16px; border-top: 1px solid var(--border); }
        :host([open]) .body { display: block; }
      `)];
      const bodyId = 'body-' + Math.random().toString(36).slice(2, 8);
      this.shadowRoot.innerHTML = `
        <div class="header"><span>${title}</span><span class="arrow">▾</span></div>
        <div class="body"><slot></slot></div>
      `;
      const header = this.shadowRoot.querySelector('.header');
      header.addEventListener('click', () => {
        if (this.hasAttribute('open')) this.removeAttribute('open');
        else this.setAttribute('open', '');
      });
    }
  });

  /* ================================================================
     <report-tabs> + <report-tab> — 选项卡
     ================================================================ */
  customElements.define('report-tabs', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + `
        :host { display: block; margin: 16px 0; }
        .nav { display: flex; border-bottom: 2px solid var(--border); margin-bottom: 16px; }
        .panels ::slotted(report-tab) { display: none; padding: 16px 0; }
        .panels ::slotted(report-tab[active]) { display: block; }
      `)];
      this.shadowRoot.innerHTML = '<div class="nav"></div><div class="panels"><slot></slot></div>';
      this._nav = this.shadowRoot.querySelector('.nav');
      // Re-sync when slots change
      const observer = new MutationObserver(() => this._sync());
      observer.observe(this, { childList: true, subtree: true, attributes: true });
      this._sync();
    }
    _sync() {
      const tabs = [...this.querySelectorAll('report-tab')];
      const nav = this._nav;
      nav.innerHTML = '';
      tabs.forEach((tab, i) => {
        const label = tab.getAttribute('label') || `Tab ${i + 1}`;
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = 'flex:1;padding:12px 16px;border:none;background:none;font-size:var(--fs-sm);font-weight:600;color:var(--text-tertiary);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all 0.15s';
        if (tab.hasAttribute('active')) {
          btn.style.color = 'var(--accent)';
          btn.style.borderBottomColor = 'var(--accent)';
        }
        btn.addEventListener('click', () => {
          tabs.forEach(t => t.removeAttribute('active'));
          tab.setAttribute('active', '');
          this._sync();
        });
        nav.appendChild(btn);
      });
    }
  });

  customElements.define('report-tab', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: none; }
        :host([active]) { display: block; }
      `)];
      this.shadowRoot.appendChild(document.createElement('slot'));
    }
  });

  /* ================================================================
     <report-section> — 章节
     ================================================================ */
  customElements.define('report-section', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const title = attr(this, 'title', '');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + `
        :host { display: block; margin-bottom: 32px; }
        :host(:last-child) { margin-bottom: 0; }
        h2 { font-size: 22px; font-weight: 660; letter-spacing: -0.01em;
          color: var(--accent); margin: 0 0 16px; padding-bottom: 8px;
          border-bottom: 1px solid var(--border); }
        h3 { font-size: var(--fs-md); font-weight: 640; color: var(--text);
          margin: 0 0 12px; }
        ::slotted(p) { margin: 0 0 16px; line-height: 1.7; }
        ::slotted(ul), ::slotted(ol) { margin: 12px 0 16px 20px; }
        ::slotted(li) { margin-bottom: 8px; line-height: 1.7; }
        ::slotted(blockquote) {
          margin: 16px 0; padding: 12px 16px;
          border-left: 3px solid var(--accent); background: var(--surface);
          border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
          color: var(--text-secondary); font-size: var(--fs-sm);
        }
        ::slotted(code) {
          background: var(--code-bg); padding: 1px 6px;
          border-radius: var(--radius-sm); font-size: 0.92em;
        }
        ::slotted(pre) {
          background: var(--code-bg); padding: 16px; border-radius: var(--radius-md);
          overflow-x: auto; font-size: var(--fs-sm); line-height: 1.6;
          margin: 16px 0;
        }
        ::slotted(pre code) { background: none; padding: 0; border-radius: 0; }
        ::slotted(.table-desc) {
          font-size: var(--fs-sm); color: var(--text-secondary); margin-bottom: 8px;
        }
        ::slotted(table) {
          width: 100%; border-collapse: collapse; margin: 16px 0; font-size: var(--fs-sm);
        }
        ::slotted(th) {
          background: var(--surface); color: var(--text-secondary); font-weight: 600;
          text-align: left; padding: 12px 16px; border-bottom: 1px solid var(--border-strong);
        }
        ::slotted(td) {
          padding: 12px 16px; border-bottom: 1px solid var(--border); color: var(--text);
        }
        ::slotted(tr:nth-child(even) td) { background: var(--surface); }
        ::slotted(img) { max-width: 100%; height: auto; border-radius: var(--radius-md); }
      `)];
      this.shadowRoot.innerHTML = `
        ${title ? `<h2>${title}</h2>` : ''}
        <slot></slot>
      `;
    }
  });

  /* ================================================================
     <report-footer> — 页脚
     ================================================================ */
  customElements.define('report-footer', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: flex; justify-content: space-between; flex-wrap: wrap;
          gap: 8px; margin-top: 32px; padding-top: 16px;
          border-top: 1px solid var(--border);
          font-size: var(--fs-xs); color: var(--text-tertiary); }
      `)];
      this.shadowRoot.appendChild(document.createElement('slot'));
    }
  });

  console.log('[Aurevoy Report Components] v3.0 loaded —',
    [...customElements].filter(n => n.startsWith('report-')).length, 'components registered');
})();
