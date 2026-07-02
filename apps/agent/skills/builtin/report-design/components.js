/**
 * Aurevoy Report Components v3.1
 *
 * Web Component 库——封装所有报告 UI 组件，通过 Shadow DOM 强制设计一致性。
 * Agent 只需使用自定义元素 + 属性/插槽填充内容，无需编写 CSS/布局代码。
 *
 * 使用方式：
 *   由 bundle_report 工具内联到单一 HTML 文件中。
 *
 * 设计原则：
 *   - 所有样式通过 Shadow DOM 封装，外部 CSS 无法侵入
 *   - 与 Aurevoy 桌面应用共享同一套设计令牌（浅色为主、克制留白、中性强调色）
 *   - 通过 CSS 自定义属性适配 Light/Dark 双模式
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
      --bg: #ffffff;
      --surface: #f8f8f8;
      --surface-strong: #eeeeef;
      --border: #ececef;
      --border-strong: #dedee3;
      --text: #202124;
      --text-secondary: #686a70;
      --text-tertiary: #9a9ca3;
      --accent: #1f2328;
      --accent-contrast: #ffffff;
      --hover: rgba(0, 0, 0, 0.055);
      --active: rgba(0, 0, 0, 0.075);
      --online: #2ea043;
      --offline: #d14343;
      --warn: #d29922;
      --info: #0969da;

      --card-bg: #ffffff;
      --card-shadow: 0 8px 28px rgba(31, 35, 40, 0.08);
      --code-bg: #f0f0ee;
      --pill-bg: #efefec;
      --pill-fg: var(--text-secondary);
      --accent-soft-bg: #e6ecff;
      --accent-soft-fg: #3548c0;
      --success-soft-bg: #d9f2e0;
      --success-soft-fg: #1a7f3c;
      --danger-soft-bg: #fbe0e0;
      --danger-soft-fg: #d14343;
      --warn-soft-bg: #fbeecf;
      --warn-soft-fg: #8a6100;

      --font-scale: 0.94;
      --fs-xs: calc(12px * var(--font-scale));
      --fs-sm: calc(13px * var(--font-scale));
      --fs-base: calc(14px * var(--font-scale));
      --fs-md: calc(15px * var(--font-scale));
      --fs-lg: calc(18px * var(--font-scale));
      --fs-h1: calc(26px * var(--font-scale));
      --fs-num: calc(30px * var(--font-scale));

      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 20px;
      --space-6: 24px;
      --space-8: 32px;

      --radius-sm: 6px;
      --radius-md: 8px;
      --radius-lg: 12px;

      --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
      --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);

      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --bg: #1c1c1e;
        --surface: #232325;
        --surface-strong: #2a2a2e;
        --border: #2c2c2e;
        --border-strong: #3a3a3c;
        --text: #f2f2f4;
        --text-secondary: #a0a0a6;
        --text-tertiary: #6e6e74;
        --accent: #f2f2f4;
        --accent-contrast: #1c1c1e;
        --hover: #28282b;
        --active: #323236;
        --card-bg: #232325;
        --card-shadow: 0 12px 32px rgba(0, 0, 0, 0.34);
        --code-bg: #2a2a2e;
        --pill-bg: #2a2a2e;
        --pill-fg: var(--text-secondary);
        --accent-soft-bg: rgba(120, 140, 255, 0.16);
        --accent-soft-fg: #aab8ff;
        --success-soft-bg: rgba(46, 160, 67, 0.20);
        --success-soft-fg: #6ed98c;
        --danger-soft-bg: rgba(209, 67, 67, 0.20);
        --danger-soft-fg: #f0a3a3;
        --warn-soft-bg: rgba(180, 130, 30, 0.22);
        --warn-soft-fg: #e0b366;
      }
    }
  `;

  const ANIMATIONS = `
    @keyframes fade-in-up {
      from { opacity: 0; transform: translateY(14px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes scale-in {
      from { opacity: 0; transform: scale(0.96); }
      to { opacity: 1; transform: scale(1); }
    }
    @keyframes progress-fill {
      from { width: 0%; }
    }
    @keyframes bar-fill {
      from { width: 0%; }
    }
    .report-animate {
      animation: fade-in-up 0.45s var(--ease-out) both;
    }
    .report-animate-scale {
      animation: scale-in 0.4s var(--ease-out) both;
    }
    .report-stagger > ::slotted(*) {
      animation: fade-in-up 0.45s var(--ease-out) both;
    }
    .report-stagger > ::slotted(*:nth-child(1)) { animation-delay: 0ms; }
    .report-stagger > ::slotted(*:nth-child(2)) { animation-delay: 55ms; }
    .report-stagger > ::slotted(*:nth-child(3)) { animation-delay: 110ms; }
    .report-stagger > ::slotted(*:nth-child(4)) { animation-delay: 165ms; }
    .report-stagger > ::slotted(*:nth-child(5)) { animation-delay: 220ms; }
    .report-stagger > ::slotted(*:nth-child(6)) { animation-delay: 275ms; }
    .report-stagger > ::slotted(*:nth-child(7)) { animation-delay: 330ms; }
    .report-stagger > ::slotted(*:nth-child(8)) { animation-delay: 385ms; }
    .report-stagger > ::slotted(*:nth-child(9)) { animation-delay: 440ms; }
    .report-stagger > ::slotted(*:nth-child(10)) { animation-delay: 495ms; }
    .report-stagger > ::slotted(*:nth-child(11)) { animation-delay: 550ms; }
    .report-stagger > ::slotted(*:nth-child(12)) { animation-delay: 605ms; }
    @media (prefers-reduced-motion: reduce) {
      .report-animate, .report-animate-scale, .report-stagger > ::slotted(*) {
        animation: none !important;
        opacity: 1 !important;
        transform: none !important;
      }
    }
  `;

  const BASE_STYLE = `
    :host {
      display: block;
      font-family: var(--font);
      font-size: var(--fs-base);
      color: var(--text);
      line-height: 1.65;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    *, *::before, *::after { box-sizing: border-box; }
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
  function waitForMount(el, cb) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => cb(el), { once: true });
    } else {
      requestAnimationFrame(() => cb(el));
    }
  }

  /* ================================================================
     <report-container> — 页面容器
     ================================================================ */
  customElements.define('report-container', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + ANIMATIONS + `
        :host {
          max-width: 880px; margin: 0 auto;
          background: var(--card-bg); border-radius: var(--radius-lg);
          box-shadow: var(--card-shadow); padding: 48px 40px;
          animation: fade-in-up 0.55s var(--ease-out) both;
        }
        @media (max-width: 640px) {
          :host { padding: 28px 18px; border-radius: 0; }
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
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + ANIMATIONS + `
        :host { display: block; margin-bottom: var(--space-8); animation: fade-in-up 0.5s var(--ease-out) both; }
        .meta { display: flex; gap: var(--space-3); margin-bottom: var(--space-4); flex-wrap: wrap; align-items: center; }
        .badge { display: inline-flex; padding: 3px 10px; border-radius: 999px;
          background: var(--pill-bg); color: var(--pill-fg);
          font-size: var(--fs-xs); font-weight: 650; letter-spacing: 0.02em; }
        .date { font-size: var(--fs-xs); color: var(--text-tertiary); padding-top: 2px; }
        h1 { font-size: var(--fs-h1); font-weight: 750; letter-spacing: -0.025em;
          line-height: 1.2; color: var(--accent); margin: 0 0 var(--space-3); }
        .summary { font-size: var(--fs-md); color: var(--text-secondary); line-height: 1.6;
          padding-bottom: var(--space-5); border-bottom: 1px solid var(--border); }
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
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + ANIMATIONS + `
        :host {
          display: grid;
          grid-template-columns: repeat(${cols}, minmax(150px, 1fr));
          gap: var(--space-4); margin: var(--space-4) 0;
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
      const direction = attr(this, 'direction', '');
      const accent = hasAttr(this, 'accent');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + ANIMATIONS + `
        :host { display: block; animation: fade-in-up 0.45s var(--ease-out) both; }
        .card {
          background: var(--surface); border: 1px solid var(--border);
          border-radius: var(--radius-md); padding: var(--space-5);
          text-align: center; transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out);
        }
        .card:hover { transform: translateY(-2px); box-shadow: var(--card-shadow); }
        .card.accent { background: var(--accent); border-color: var(--accent); }
        .value { font-size: var(--fs-num); font-weight: 760; color: var(--accent);
          line-height: 1.15; margin-bottom: var(--space-1); letter-spacing: -0.02em; }
        .accent .value, .accent .label, .accent .change { color: var(--accent-contrast); }
        .label { font-size: var(--fs-xs); color: var(--text-tertiary);
          text-transform: uppercase; letter-spacing: 0.04em; font-weight: 650; }
        .change { font-size: var(--fs-xs); margin-top: var(--space-1); font-weight: 600; }
        .change.up { color: var(--online); }
        .change.down { color: var(--offline); }
        .accent .change.up, .accent .change.down { opacity: 0.85; }
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
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + ANIMATIONS + `
        :host {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: var(--space-4); margin: var(--space-4) 0;
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
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + ANIMATIONS + `
        :host { display: block; animation: fade-in-up 0.45s var(--ease-out) both; }
        .card {
          background: var(--card-bg); border: 1px solid var(--border);
          border-radius: var(--radius-md); padding: var(--space-5);
          transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out), border-color 0.18s;
        }
        .card:hover { transform: translateY(-2px); box-shadow: var(--card-shadow); border-color: var(--border-strong); }
        h4 { font-size: var(--fs-md); font-weight: 680; color: var(--accent);
          margin: 0 0 var(--space-2); letter-spacing: -0.01em; }
        .body { font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.6; }
        .meta { font-size: var(--fs-xs); color: var(--text-tertiary);
          margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--border);
          display: flex; align-items: center; gap: var(--space-2); }
        .tag { display: inline-flex; padding: 2px 8px; border-radius: 999px;
          font-size: 10px; font-weight: 650; line-height: 1.5; letter-spacing: 0.02em; }
        .tag-success { background: var(--success-soft-bg); color: var(--success-soft-fg); }
        .tag-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
        .tag-info { background: var(--accent-soft-bg); color: var(--accent-soft-fg); }
        .tag-default { background: var(--pill-bg); color: var(--pill-fg); }
        .tag-danger { background: var(--danger-soft-bg); color: var(--danger-soft-fg); }
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
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + ANIMATIONS + `
        :host { display: block; }
        .tl { position: relative; padding-left: 30px; }
        .tl::before { content: ''; position: absolute; left: 9px; top: 6px; bottom: 6px;
          width: 2px; background: var(--border-strong); border-radius: 1px; }
        ::slotted(report-timeline-item) { display: block; margin-bottom: var(--space-5); }
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
      const status = attr(this, 'status', '');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + ANIMATIONS + `
        :host { display: block; position: relative; animation: fade-in-up 0.45s var(--ease-out) both; }
        :host::before {
          content: ''; position: absolute; left: -24px; top: 4px;
          width: 10px; height: 10px; border-radius: 50%;
          background: var(--surface-strong); border: 2px solid var(--card-bg);
          box-shadow: 0 0 0 2px var(--border-strong);
          transition: background 0.2s, box-shadow 0.2s;
        }
        :host([status="done"])::before,
        :host([status="active"])::before { background: var(--online); box-shadow: 0 0 0 2px var(--online); }
        :host([status="active"])::before { animation: pulse-dot 1.6s ease-in-out infinite; }
        @keyframes pulse-dot {
          0%, 100% { box-shadow: 0 0 0 2px var(--online); }
          50% { box-shadow: 0 0 0 4px rgba(46, 160, 67, 0.25); }
        }
        @media (prefers-reduced-motion: reduce) {
          :host([status="active"])::before { animation: none; }
        }
        .date { font-size: var(--fs-xs); color: var(--text-tertiary); margin-bottom: var(--space-1); font-weight: 600; }
        .title { font-weight: 680; color: var(--accent); margin-bottom: var(--space-1); letter-spacing: -0.01em; }
        .desc { font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.6; }
      `)];
      this.shadowRoot.innerHTML = `
        ${date ? `<div class="date">${date}</div>` : ''}
        ${title ? `<div class="title">${title}</div>` : ''}
        <div class="desc"><slot></slot></div>
      `;
    }
  });

  /* ================================================================
     <report-score-matrix> + <report-score-cell> — 评分矩阵
     ================================================================ */
  customElements.define('report-score-matrix', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + `
        :host { display: block; margin: var(--space-4) 0; overflow-x: auto; animation: fade-in-up 0.45s var(--ease-out) both; }
        table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: var(--fs-sm);
          border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
        ::slotted(report-score-head) th {
          background: var(--surface); color: var(--text-secondary); font-weight: 650;
          text-align: center; padding: var(--space-3) var(--space-4);
          border-bottom: 1px solid var(--border-strong); font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.03em;
        }
        ::slotted(report-score-head) th:first-child { text-align: left; }
        ::slotted(report-score-row) td {
          padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); text-align: center;
        }
        ::slotted(report-score-row) td:first-child {
          font-weight: 650; color: var(--accent); text-align: left;
        }
        ::slotted(report-score-row:last-child) td { border-bottom: none; }
        ::slotted(report-score-foot) td {
          font-weight: 700; background: var(--surface-strong);
          border-top: 2px solid var(--border-strong); padding: var(--space-3) var(--space-4);
        }
      `)];
      this.shadowRoot.innerHTML = '<table><thead><slot name="head"></slot></thead><tbody><slot></slot></tbody><tfoot><slot name="foot"></slot></tfoot></table>';
    }
  });

  customElements.define('report-score-cell', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const value = attr(this, 'value', '');
      const level = attr(this, 'level', '');
      const color = level === 'high' ? 'var(--online)' : level === 'mid' ? 'var(--warn)' : level === 'low' ? 'var(--offline)' : 'var(--text)';
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        span { font-weight: 680; color: ${color}; font-variant-numeric: tabular-nums; }
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
        :host { display: block; margin: var(--space-4) 0; }
        ::slotted(report-progress-bar) { display: block; margin-bottom: var(--space-3); }
      `)];
      this.shadowRoot.appendChild(document.createElement('slot'));
    }
  });

  customElements.define('report-progress-bar', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const label = attr(this, 'label', '');
      const pct = Math.min(100, Math.max(0, parseFloat(attr(this, 'value', '0')) || 0));
      const level = attr(this, 'level', '');
      const fillColor = level === 'high' ? 'var(--online)' : level === 'mid' ? 'var(--warn)' : level === 'low' ? 'var(--offline)' : 'var(--accent)';
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: block; animation: fade-in-up 0.45s var(--ease-out) both; }
        .row { display: flex; align-items: center; gap: var(--space-4); }
        .label { min-width: 110px; font-size: var(--fs-sm); color: var(--text-secondary); }
        .track { flex: 1; height: 8px; background: var(--surface-strong);
          border-radius: 999px; overflow: hidden; }
        .fill { height: 100%; border-radius: 999px; background: ${fillColor};
          width: 0%; transition: width 0.9s var(--ease-out); }
        .val { min-width: 42px; text-align: right; font-size: var(--fs-xs);
          color: var(--text-tertiary); font-weight: 650; font-variant-numeric: tabular-nums; }
        @media (prefers-reduced-motion: reduce) {
          .fill { transition: none; }
        }
      `)];
      this.shadowRoot.innerHTML = `
        <div class="row">
          <div class="label">${label}</div>
          <div class="track"><div class="fill"></div></div>
          <div class="val">${pct}%</div>
        </div>
      `;
      waitForMount(this, (el) => {
        const fill = el.shadowRoot.querySelector('.fill');
        if (fill) fill.style.width = pct + '%';
      });
    }
  });

  /* ================================================================
     <report-bar-chart> + <report-bar> — CSS 条形图
     ================================================================ */
  customElements.define('report-bar-chart', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + `
        :host { display: block; margin: var(--space-4) 0; }
        ::slotted(report-bar) { display: block; margin-bottom: var(--space-3); }
      `)];
      this.shadowRoot.appendChild(document.createElement('slot'));
    }
  });

  customElements.define('report-bar', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const label = attr(this, 'label', '');
      const pct = Math.min(100, Math.max(1, parseFloat(attr(this, 'value', '50')) || 50));
      const level = attr(this, 'level', '');
      const fillColor = level === 'high' ? 'var(--online)' : level === 'mid' ? 'var(--warn)' : level === 'low' ? 'var(--offline)' : 'var(--accent)';
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + `
        :host { display: block; animation: fade-in-up 0.45s var(--ease-out) both; }
        .row { display: flex; align-items: center; gap: var(--space-4); }
        .label { min-width: 100px; font-size: var(--fs-sm); color: var(--text-secondary); text-align: right; }
        .track { flex: 1; height: 26px; background: var(--surface-strong);
          border-radius: var(--radius-sm); overflow: hidden; }
        .fill { height: 100%; border-radius: var(--radius-sm); background: ${fillColor};
          width: 0%; display: flex; align-items: center; padding-left: var(--space-2);
          transition: width 0.9s var(--ease-out); }
        .fill-text { font-size: var(--fs-xs); color: var(--accent-contrast); font-weight: 650;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .val { font-size: var(--fs-xs); color: var(--text-tertiary); min-width: 48px; font-weight: 650; }
        @media (prefers-reduced-motion: reduce) {
          .fill { transition: none; }
        }
      `)];
      this.shadowRoot.innerHTML = `
        <div class="row">
          <div class="label">${label}</div>
          <div class="track"><div class="fill"><span class="fill-text"><slot></slot></span></div></div>
          <div class="val"><slot></slot></div>
        </div>
      `;
      waitForMount(this, (el) => {
        const fill = el.shadowRoot.querySelector('.fill');
        if (fill) fill.style.width = pct + '%';
      });
    }
  });

  /* ================================================================
     <report-steps> + <report-step> — 步骤指示器
     ================================================================ */
  customElements.define('report-steps', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + ANIMATIONS + `
        :host { display: flex; gap: var(--space-2); margin: var(--space-6) 0; flex-wrap: wrap; }
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
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + ANIMATIONS + `
        :host { display: block; animation: fade-in-up 0.45s var(--ease-out) both; }
        .step { padding: var(--space-4); text-align: center; background: var(--surface);
          border-radius: var(--radius-md); border: 1px solid var(--border);
          transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out), background 0.18s; }
        .step:hover { transform: translateY(-2px); box-shadow: var(--card-shadow); }
        .step.active { background: var(--accent); border-color: var(--accent); }
        .num { display: inline-flex; align-items: center; justify-content: center;
          width: 28px; height: 28px; border-radius: 50%;
          background: var(--border-strong); color: var(--text-secondary);
          font-size: var(--fs-xs); font-weight: 700; margin-bottom: var(--space-2);
          transition: background 0.2s, color 0.2s; }
        .active .num { background: var(--accent-contrast); color: var(--accent); }
        .title { font-weight: 680; font-size: var(--fs-sm); color: var(--accent);
          margin-bottom: var(--space-1); letter-spacing: -0.01em; }
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
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + ANIMATIONS + `
        :host { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); margin: var(--space-4) 0; }
        @media (max-width: 600px) { :host { grid-template-columns: 1fr; } }
      `)];
      this.shadowRoot.appendChild(document.createElement('slot'));
    }
  });

  customElements.define('report-pros', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const title = attr(this, 'title', '优势');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + ANIMATIONS + `
        :host { display: block; padding: var(--space-4); border-radius: var(--radius-md);
          background: var(--success-soft-bg); border: 1px solid color-mix(in srgb, var(--success-soft-fg) 20%, transparent); }
        h4 { font-size: var(--fs-md); font-weight: 680; margin: 0 0 var(--space-3); color: var(--success-soft-fg); letter-spacing: -0.01em; }
        ::slotted(li) { font-size: var(--fs-sm); margin-bottom: var(--space-2); color: var(--text); }
        ::slotted(li)::marker { color: var(--success-soft-fg); }
      `)];
      this.shadowRoot.innerHTML = `<h4>✓ ${title}</h4><ul><slot></slot></ul>`;
    }
  });

  customElements.define('report-cons', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const title = attr(this, 'title', '劣势');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + ANIMATIONS + `
        :host { display: block; padding: var(--space-4); border-radius: var(--radius-md);
          background: var(--danger-soft-bg); border: 1px solid color-mix(in srgb, var(--danger-soft-fg) 20%, transparent); }
        h4 { font-size: var(--fs-md); font-weight: 680; margin: 0 0 var(--space-3); color: var(--danger-soft-fg); letter-spacing: -0.01em; }
        ::slotted(li) { font-size: var(--fs-sm); margin-bottom: var(--space-2); color: var(--text); }
        ::slotted(li)::marker { color: var(--danger-soft-fg); }
      `)];
      this.shadowRoot.innerHTML = `<h4>− ${title}</h4><ul><slot></slot></ul>`;
    }
  });

  /* ================================================================
     <report-callout> — 标注框
     ================================================================ */
  customElements.define('report-callout', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const type = attr(this, 'type', 'info');
      const title = attr(this, 'title', '');
      const icons = { info: 'i', warn: '!', success: '✓', danger: '−' };
      const icon = icons[type] || icons.info;
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + ANIMATIONS + `
        :host { display: flex; gap: var(--space-3); margin: var(--space-4) 0; padding: var(--space-4);
          border-radius: var(--radius-md); border: 1px solid; font-size: var(--fs-sm); line-height: 1.6;
          animation: fade-in-up 0.45s var(--ease-out) both; }
        :host([type="info"]) { background: var(--accent-soft-bg); border-color: color-mix(in srgb, var(--accent-soft-fg) 20%, transparent); }
        :host([type="warn"]) { background: var(--warn-soft-bg); border-color: color-mix(in srgb, var(--warn-soft-fg) 20%, transparent); }
        :host([type="success"]) { background: var(--success-soft-bg); border-color: color-mix(in srgb, var(--success-soft-fg) 20%, transparent); }
        :host([type="danger"]) { background: var(--danger-soft-bg); border-color: color-mix(in srgb, var(--danger-soft-fg) 20%, transparent); }
        .icon { flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 12px; font-weight: 750; color: white; margin-top: 1px; }
        :host([type="info"]) .icon { background: var(--accent-soft-fg); }
        :host([type="warn"]) .icon { background: var(--warn-soft-fg); }
        :host([type="success"]) .icon { background: var(--success-soft-fg); }
        :host([type="danger"]) .icon { background: var(--danger-soft-fg); }
        .body { flex: 1; }
        .title { font-weight: 680; margin-bottom: var(--space-1); color: var(--text); }
        ::slotted(p) { margin: 0; }
        ::slotted(p:not(:last-child)) { margin-bottom: var(--space-2); }
      `)];
      this.shadowRoot.innerHTML = `
        <div class="icon">${icon}</div>
        <div class="body">
          ${title ? `<div class="title">${title}</div>` : ''}
          <slot></slot>
        </div>
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
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + ANIMATIONS + `
        :host { display: block; margin: var(--space-6) 0; padding: var(--space-5);
          background: var(--surface); border-radius: var(--radius-lg);
          border: 1px solid var(--border); animation: fade-in-up 0.45s var(--ease-out) both; }
        h3 { font-size: var(--fs-lg); color: var(--accent); margin: 0 0 var(--space-4); letter-spacing: -0.01em; }
        ::slotted(report-finding) { display: block; margin-bottom: var(--space-3); }
        ::slotted(report-finding:last-child) { margin-bottom: 0; }
      `)];
      this.shadowRoot.innerHTML = `<h3>${title}</h3><slot></slot>`;
    }
  });

  customElements.define('report-finding', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const type = attr(this, 'type', 'fact');
      const icons = { fact: '•', risk: '!', action: '→' };
      const colors = { fact: 'var(--info)', risk: 'var(--warn)', action: 'var(--online)' };
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + ANIMATIONS + `
        :host { display: flex; gap: var(--space-3); align-items: flex-start; animation: fade-in-up 0.45s var(--ease-out) both; }
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
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + ANIMATIONS + `
        :host {
          display: block; margin: var(--space-6) 0; padding: var(--space-5);
          background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 92%, var(--info)));
          border-radius: var(--radius-lg); color: var(--accent-contrast);
          animation: fade-in-up 0.5s var(--ease-out) both;
          box-shadow: var(--card-shadow);
        }
        h3 { color: var(--accent-contrast); font-size: var(--fs-lg); margin: 0 0 var(--space-3); letter-spacing: -0.01em; }
        ::slotted(p) { opacity: 0.9; line-height: 1.7; margin: 0; }
        ::slotted(p:not(:last-child)) { margin-bottom: var(--space-3); }
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
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + ANIMATIONS + `
        :host { display: inline-flex; padding: 2px 8px; border-radius: 999px;
          font-size: var(--fs-xs); font-weight: 650; line-height: 1.5; white-space: nowrap;
          animation: fade-in 0.3s var(--ease-out) both; }
        :host([type="default"]) { background: var(--pill-bg); color: var(--pill-fg); }
        :host([type="success"]) { background: var(--success-soft-bg); color: var(--success-soft-fg); }
        :host([type="warn"]) { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
        :host([type="danger"]) { background: var(--danger-soft-bg); color: var(--danger-soft-fg); }
        :host([type="info"]) { background: var(--accent-soft-bg); color: var(--accent-soft-fg); }
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
        :host { display: block; margin: var(--space-4) 0; }
      `)];
      this.shadowRoot.appendChild(document.createElement('slot'));
    }
  });

  customElements.define('report-accordion-item', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    connectedCallback() {
      const title = attr(this, 'title', '');
      const open = hasAttr(this, 'open');
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + ANIMATIONS + `
        :host { display: block; border: 1px solid var(--border);
          border-radius: var(--radius-md); margin-bottom: var(--space-2); overflow: hidden;
          animation: fade-in-up 0.45s var(--ease-out) both; }
        :host(:last-child) { margin-bottom: 0; }
        .header { padding: var(--space-3) var(--space-4); background: var(--surface); font-weight: 680;
          font-size: var(--fs-sm); color: var(--accent); cursor: pointer;
          display: flex; justify-content: space-between; align-items: center;
          user-select: none; transition: background 0.15s; }
        .header:hover { background: var(--surface-strong); }
        .arrow { font-size: var(--fs-xs); color: var(--text-tertiary); transition: transform 0.25s var(--ease-out); }
        :host([open]) .arrow { transform: rotate(180deg); }
        .body { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.3s var(--ease-out); }
        :host([open]) .body { grid-template-rows: 1fr; }
        .body-inner { overflow: hidden; }
        .body-content { padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border); }
        @media (prefers-reduced-motion: reduce) {
          .body { transition: none; }
          .arrow { transition: none; }
        }
      `)];
      this.shadowRoot.innerHTML = `
        <div class="header"><span>${title}</span><span class="arrow">▾</span></div>
        <div class="body"><div class="body-inner"><div class="body-content"><slot></slot></div></div></div>
      `;
      if (open) this.setAttribute('open', '');
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
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + ANIMATIONS + `
        :host { display: block; margin: var(--space-4) 0; }
        .nav { display: flex; border-bottom: 2px solid var(--border); margin-bottom: var(--space-4); position: relative; }
        .panels ::slotted(report-tab) { display: none; padding: var(--space-3) 0; }
        .panels ::slotted(report-tab[active]) { display: block; animation: fade-in 0.25s var(--ease-out) both; }
      `)];
      this.shadowRoot.innerHTML = '<div class="nav"></div><div class="panels"><slot></slot></div>';
      this._nav = this.shadowRoot.querySelector('.nav');
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
        btn.style.cssText = 'flex:1;padding:12px 16px;border:none;background:none;font-size:var(--fs-sm);font-weight:680;color:var(--text-tertiary);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:color 0.2s,border-color 0.2s';
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
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + BASE_STYLE + ANIMATIONS + `
        :host { display: block; margin-bottom: var(--space-8); animation: fade-in-up 0.5s var(--ease-out) both; }
        :host(:last-child) { margin-bottom: 0; }
        h2 { font-size: 22px; font-weight: 680; letter-spacing: -0.015em;
          color: var(--accent); margin: 0 0 var(--space-4); padding-bottom: var(--space-2);
          border-bottom: 1px solid var(--border); }
        h3 { font-size: var(--fs-md); font-weight: 650; color: var(--text);
          margin: var(--space-5) 0 var(--space-3); }
        ::slotted(p) { margin: 0 0 var(--space-4); line-height: 1.7; }
        ::slotted(ul), ::slotted(ol) { margin: var(--space-3) 0 var(--space-4) var(--space-5); }
        ::slotted(li) { margin-bottom: var(--space-2); line-height: 1.7; }
        ::slotted(blockquote) {
          margin: var(--space-4) 0; padding: var(--space-3) var(--space-4);
          border-left: 3px solid var(--accent); background: var(--surface);
          border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
          color: var(--text-secondary); font-size: var(--fs-sm);
        }
        ::slotted(code) {
          background: var(--code-bg); padding: 1px 6px;
          border-radius: var(--radius-sm); font-size: 0.92em;
        }
        ::slotted(pre) {
          background: var(--code-bg); padding: var(--space-4); border-radius: var(--radius-md);
          overflow-x: auto; font-size: var(--fs-sm); line-height: 1.6;
          margin: var(--space-4) 0;
        }
        ::slotted(pre code) { background: none; padding: 0; border-radius: 0; }
        ::slotted(.table-desc) {
          font-size: var(--fs-sm); color: var(--text-secondary); margin-bottom: var(--space-2);
        }
        ::slotted(table) {
          width: 100%; border-collapse: separate; border-spacing: 0; margin: var(--space-4) 0; font-size: var(--fs-sm);
          border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden;
        }
        ::slotted(th) {
          background: var(--surface); color: var(--text-secondary); font-weight: 650;
          text-align: left; padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-strong);
          font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.03em;
        }
        ::slotted(td) {
          padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); color: var(--text);
        }
        ::slotted(tr:last-child td) { border-bottom: none; }
        ::slotted(tr:nth-child(even) td) { background: var(--surface); }
        ::slotted(img) { max-width: 100%; height: auto; border-radius: var(--radius-md); box-shadow: var(--card-shadow); }
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
      this.shadowRoot.adoptedStyleSheets = [sheet(TOKENS + ANIMATIONS + `
        :host { display: flex; justify-content: space-between; flex-wrap: wrap;
          gap: var(--space-2); margin-top: var(--space-8); padding-top: var(--space-4);
          border-top: 1px solid var(--border);
          font-size: var(--fs-xs); color: var(--text-tertiary);
          animation: fade-in-up 0.45s var(--ease-out) both; }
      `)];
      this.shadowRoot.appendChild(document.createElement('slot'));
    }
  });

  console.log('[Aurevoy Report Components] v3.1 loaded —',
    [...customElements].filter(n => n.startsWith('report-')).length, 'components registered');
})();
