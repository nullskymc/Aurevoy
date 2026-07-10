<p align="center">
  <img src="../../apps/desktop/public/aurevoy-wordmark.svg" width="320" alt="Aurevoy" />
</p>

# Aurevoy

> 告诉它**做什么**，不必教它怎么做。  
> 跑在你电脑上的个人 AI Agent，真正把事做完。

---

Aurevoy 是**本地桌面 Agent**（优先 macOS）。你描述目标，它规划、调工具、推进任务：读写文件、检索网页、改代码、整理材料，过程可中断、可审批、可回溯。

## 能做什么

```
"把 downloads 里的 PNG 转成 WebP"
"调研 React 19 breaking changes，写迁移清单"
"给这个项目加暗色模式"
"根据这些笔记写一份周报"
```

- **代码与文件** — 搜索、精确编辑、按工作区隔离  
- **调研** — 网页搜索与抓取（SSRF 防护），可选浏览器 skill  
- **多模态** — 拖入图片/文件，需要时用视觉模型  
- **记忆与知识库** — 记住偏好；可为目录建索引做 RAG  
- **可控** — 随时停止；工具审批；内联修改并重试；分支对话  

数据默认不出本机。自备 API Key（OpenAI 兼容、Anthropic 等）。代码开源。

## 快速开始

1. **安装** — [Releases](../../releases) 下载 DMG  
2. **配置** — 设置里填 Provider / Base URL / 模型 / Key  
3. **对话** — 输入目标；`/` 查看 skill（如 web-search、browser）

### 开发

```bash
# Node >= 22.19.0，Rust stable，macOS Xcode CLT
git clone https://github.com/nullskymc/Aurevoy.git
cd Aurevoy && npm install
npm run dev
npm run typecheck
```

协作入口：[AGENTS.md](../../AGENTS.md) · 文档：[docs/](../)

## 技术概要

| 层 | 技术 |
|---|---|
| 桌面壳 | Tauri 2 |
| UI | React + TypeScript（`packages/web-ui`） |
| 引擎 | Node + Fastify + Pi Agent + SQLite |
| 通信 | 本机 HTTP + SSE |
| 扩展 | 内置工具 + MCP + Skill |

架构：[ARCHITECTURE](../ARCHITECTURE.md) · 路线图：[ROADMAP](../ROADMAP.md)

## 当前能力

自主规划与工具 · 多 Provider LLM · auto/plan · 多轮与恢复 ·  
内联编辑重试 / 分支 / 压缩 · 多角色子代理 · Skill · 网页搜索 ·  
多模态 · 项目工作区 · 双层预算 · 长期记忆与知识库 RAG · 设置与 CI  

**进行中：** 签名公证与自动更新、隐式 KB 召回、评测与发布体验。

---

MIT
