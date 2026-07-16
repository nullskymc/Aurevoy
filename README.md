<p align="center">
  <img src="apps/desktop/public/aurevoy-wordmark.svg" width="320" alt="Aurevoy" />
</p>

# Aurevoy

> Tell it *what* you want, not *how* to do it.  
> A personal AI agent that **gets work done** on your machine.

[中文](docs/README/README_zh-CN.md) · [한국어](docs/README/README_ko-KR.md) · [日本語](docs/README/README_ja-JP.md)

---

Aurevoy is a **local desktop agent** (macOS first). You state a goal; it plans, uses tools, and works through the task—files, web research, code edits, and more—while you stay in control.

## What you can do

```
"Convert PNGs in Downloads to WebP"
"Research React 19 breaking changes and write a migration checklist"
"Add dark mode to this project"
"Summarize these notes into a weekly report"
```

- **Code & files** — search, precise edits, workspace-aware tools  
- **Research** — web search & fetch (SSRF-safe), optional browser skill  
- **Multimodal** — drag images/files; vision models when needed  
- **Memory & knowledge** — preferences you teach it; optional folder KB/RAG  
- **Control** — stop anytime; approve tools; inline edit & retry; branch threads  

Everything runs **on your computer**. You bring your own API keys (OpenAI-compatible, Anthropic, and more). Open source.

## Quick start

1. **Install** — latest DMG from [Releases](../../releases)  
2. **Configure** — Settings → provider, base URL, model, API key  
3. **Chat** — type a goal; `/` lists skills (e.g. web-search, browser)

### Develop

```bash
# Node >= 22.19.0, Rust stable, macOS Xcode CLT
git clone https://github.com/nullskymc/Aurevoy.git
cd Aurevoy && npm install
npm run dev
npm run typecheck
```

Contributor guide: [AGENTS.md](AGENTS.md) · docs: [docs/](docs/) · site: [aurevoy.nullskymc.site](https://aurevoy.nullskymc.site/)

## Stack

| Layer | Tech |
|---|---|
| Shell | Tauri 2 |
| UI | React + TypeScript (`packages/web-ui`) |
| Engine | Node + Fastify + Pi Agent + SQLite |
| Transport | Local HTTP + SSE |
| Extensions | Built-in tools + MCP + Skills |

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md)

## Capabilities (current)

Autonomous agent & tools · multi-provider LLM · multi-turn & resume ·  
inline edit-retry / branch / compact · multi-role subagents · skills · web search ·  
multimodal · projects · dual task budgets · long-term memory + KB RAG · settings & CI  

**In progress:** Apple code signing / notarization, implicit KB recall, evals, release polish.  
**Shipped (distribution):** in-app auto-update via GitHub Releases (Tauri updater).

---

MIT
