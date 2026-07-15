import { useMemo, useState } from "react";
import "../App.css";
import "../components/Conversation.css";
import "../components/Composer.css";
import "../pages/SkillsPage.css";
import "./palettes.css";
import "./ThemeDemo.css";

type PaletteId = "aurora" | "paper" | "teal" | "dual" | "gold" | "codex";
type Mode = "light" | "dark";

const PALETTES: Array<{
  id: PaletteId;
  name: string;
  title: string;
  blurb: string;
}> = [
  {
    id: "aurora",
    name: "A · Signal Green（原版）",
    title: "未修改青绿",
    blurb: "初版 Signal Green：#0d9488 亮青绿 + 绿面。用来和 C 对比。",
  },
  {
    id: "paper",
    name: "B · Warm Paper",
    title: "暖纸阅读",
    blurb: "米白 + 赤陶，像本地笔记/文档产品。",
  },
  {
    id: "teal",
    name: "C · Mist Teal（调后）",
    title: "灰底绿阴影",
    blurb: "相对 A：面更灰、accent 更闷、阴影带绿相。当前偏好方向。",
  },
  {
    id: "dual",
    name: "D · Dual-Surface",
    title: "双面分区",
    blurb: "深侧栏 + 亮主区，结构差拉开桌面壳感。",
  },
  {
    id: "gold",
    name: "E · Gold Trace",
    title: "金迹点缀",
    blurb: "整体中性，仅主按钮/软强调用金色品牌点。",
  },
  {
    id: "codex",
    name: "对照 · Codex 灰",
    title: "当前撞脸基线",
    blurb: "纯灰 + 近黑 accent，仅作对照。",
  },
];

export function ThemeDemo() {
  const [mode, setMode] = useState<Mode>("light");
  const [focusId, setFocusId] = useState<PaletteId | null>(null);

  const visible = useMemo(
    () => (focusId ? PALETTES.filter((p) => p.id === focusId) : PALETTES),
    [focusId],
  );

  return (
    <div className="theme-demo-root" data-mode={mode}>
      <header className="theme-demo-chrome">
        <div>
          <p className="theme-demo-kicker">Aurevoy · Theme Lab</p>
          <h1>五种色调示范（复用项目组件样式）</h1>
          <p className="theme-demo-sub">
            每张卡片是同一套 UI 骨架：侧栏、会话、过程摘要、气泡、Composer、Skill
            卡、主按钮。切换浅/深可看对称适配。
          </p>
        </div>
        <div className="theme-demo-chrome-actions">
          <div className="theme-demo-seg" role="group" aria-label="明暗">
            <button
              type="button"
              data-active={mode === "light"}
              onClick={() => setMode("light")}
            >
              浅色
            </button>
            <button
              type="button"
              data-active={mode === "dark"}
              onClick={() => setMode("dark")}
            >
              深色
            </button>
          </div>
          {focusId && (
            <button type="button" className="theme-demo-back" onClick={() => setFocusId(null)}>
              返回总览
            </button>
          )}
        </div>
      </header>

      <div className={`theme-demo-grid${focusId ? " is-focus" : ""}`}>
        {visible.map((p) => (
          <PaletteFrame
            key={p.id}
            palette={p}
            mode={mode}
            focused={focusId === p.id}
            onFocus={() => setFocusId(p.id)}
          />
        ))}
      </div>
    </div>
  );
}

function PaletteFrame({
  palette,
  mode,
  focused,
  onFocus,
}: {
  palette: (typeof PALETTES)[number];
  mode: Mode;
  focused: boolean;
  onFocus: () => void;
}) {
  const dual = palette.id === "dual";

  return (
    <section
      className="theme-demo-frame"
      data-palette={palette.id}
      data-mode={mode === "dark" ? "dark" : "light"}
      data-dual={dual ? "true" : "false"}
    >
      <header className="theme-demo-frame-head">
        <div>
          <span className="theme-demo-frame-name">{palette.name}</span>
          <strong>{palette.title}</strong>
          <p>{palette.blurb}</p>
        </div>
        {!focused && (
          <button type="button" className="theme-demo-focus-btn" onClick={onFocus}>
            放大看
          </button>
        )}
      </header>

      <div className="theme-demo-shell">
        <aside className="theme-demo-sidebar">
          <div className="theme-demo-brand">Aurevoy</div>
          <button type="button" className="theme-demo-nav is-active">
            对话
          </button>
          <button type="button" className="theme-demo-nav">
            Skill
          </button>
          <button type="button" className="theme-demo-nav">
            设置
          </button>
          <div className="theme-demo-conv-list">
            <div className="theme-demo-conv is-active">整理本周笔记</div>
            <div className="theme-demo-conv">修复构建失败</div>
            <div className="theme-demo-conv">审查 PR #42</div>
          </div>
        </aside>

        <main className="theme-demo-main">
          <div className="theme-demo-topbar">
            <span className="theme-demo-topbar-title">整理本周笔记</span>
            <span className="theme-demo-pill">online</span>
          </div>

          <div className="theme-demo-chat">
            <div className="user-bubble-row">
              <div className="user-bubble">帮我把本周会议纪要整理成行动项清单。</div>
            </div>

            <div className="theme-demo-process">
              <span className="theme-demo-process-label">已处理 12s</span>
              <span className="theme-demo-process-line">读取笔记 · 提取决策 · 生成清单</span>
            </div>

            <div className="theme-demo-agent">
              <p>
                已根据会议记录整理出 <strong>6</strong> 条行动项，按负责人分组。需要我导出 Markdown
                吗？
              </p>
              <pre className="theme-demo-code">
                {`- [ ] 更新路线图（@you）\n- [ ] 同步设计稿（@design）`}
              </pre>
              <div className="theme-demo-pills">
                <span className="theme-demo-soft accent">进行中</span>
                <span className="theme-demo-soft success">完成</span>
                <span className="theme-demo-soft danger">失败</span>
              </div>
            </div>

            <div className="theme-demo-skills">
              <button type="button" className="skills-list-card">
                <div className="skills-list-card-copy">
                  <span className="skills-list-card-name">Agently Mail</span>
                  <span className="skills-list-card-desc">通过 CLI 操作邮件…</span>
                </div>
                <span className="skills-list-card-check">✓</span>
              </button>
              <button type="button" className="skills-list-card">
                <div className="skills-list-card-copy">
                  <span className="skills-list-card-name">PDF Skill</span>
                  <span className="skills-list-card-desc">创建与审阅 PDF…</span>
                </div>
                <span className="skills-list-card-check">✓</span>
              </button>
            </div>
          </div>

          <div className="theme-demo-composer composer-box">
            <div className="theme-demo-composer-input">继续补充负责人与截止日期…</div>
            <div className="theme-demo-composer-bar">
              <button type="button" className="ghost-btn">
                模型 · high
              </button>
              <div className="theme-demo-composer-actions">
                <button type="button" className="theme-demo-btn ghost">
                  取消
                </button>
                <button type="button" className="theme-demo-btn primary">
                  发送
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>

      <footer className="theme-demo-swatches" aria-label="色板样本">
        <Swatch label="bg" varName="--bg" />
        <Swatch label="surface" varName="--surface" />
        <Swatch label="sidebar" varName="--sidebar-bg" />
        <Swatch label="accent" varName="--accent" />
        <Swatch label="bubble" varName="--user-bubble-bg" />
        <Swatch label="text" varName="--text" />
      </footer>
    </section>
  );
}

function Swatch({ label, varName }: { label: string; varName: string }) {
  return (
    <div className="theme-demo-swatch">
      <span className="theme-demo-swatch-chip" style={{ background: `var(${varName})` }} />
      <span>{label}</span>
    </div>
  );
}
