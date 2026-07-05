<p align="center">
  <img src="apps/desktop/public/aurevoy-wordmark.svg" width="320" alt="Aurevoy" />
</p>

# Aurevoy

> Tell it *what* you want, not *how* to do it.
> Your first AI companion that actually **gets things done**.

[中文文档](docs/README/README_zh-CN.md)
[한국어 문서](docs/README/README_ko-KR.md)
[日本語ドキュメント](docs/README/README_ja-JP.md)

---

Aurevoy is a personal AI agent that runs on your computer. It's more than a chat interface —
you give it a goal, and it figures out the rest: researching, writing files, searching the web, and working through tasks step by step.

**Like having someone sitting next to you who just says "I'll take care of it."**

---

## What It Can Do

### Everyday Tasks, Just Ask

```
"Convert all the PNGs in my downloads folder to WebP"
"Research React 19 breaking changes and write a migration checklist"
"Read through this folder and turn the code into a README"
```

Aurevoy breaks down the task and gets to work. You don't need to explain how.

### Write, Edit, and Explore Code

```
"Add dark mode to this project"
"Find the date-formatting utility in src/utils and check for bugs"
"This code is too slow — help me find the bottleneck"
```

It understands your project structure, makes precise edits, and flags issues. If something goes wrong, you can always **undo** — edit any earlier message, branch the conversation, or compress context to start fresh.

### Research & Writing

```
"Survey the top React state management libraries — compare pros and cons"
"Translate this article into English, keeping technical terms accurate"
"Turn these meeting notes into a weekly report"
```

It searches the web for up-to-date information, fetches pages for details, and synthesizes everything into the format you need.

### See and Understand Images

Drag and drop images or files into the conversation. Aurevoy switches to a vision model when images are present, so it can read screenshots, analyze diagrams, and answer questions about what it sees.

### Learns Your Preferences

Tell it how you work — "I always use pnpm," "I prefer functional style" — and it remembers. Next time it follows your conventions without being reminded.

---

## How It Works

You give it a goal → Aurevoy scouts your workspace to understand the context → builds a plan → executes step by step:

- **Need to read a file?** It opens and inspects it.
- **Need to look something up?** It searches the web for current information.
- **Need to write code?** It makes precise edits without touching unrelated parts.
- **Need your input?** It pauses, asks, and waits for your go-ahead before proceeding.

You see every step. Dislike a direction? Interrupt anytime, revise, and it picks back up. You can also rewind — edit any earlier message and regenerate from that point, or branch into a new thread to explore a different direction.

---

## Your Data, Your Rules

- **Everything runs locally.** Your data never leaves your machine.
- You bring your own API key and choose whichever model you want.
- The code is open source — you can always see exactly what it's doing.

---

## Get Started

### 1. Download

Grab the latest DMG from [Releases](../../releases) and drag it into Applications.

### 2. Configure a Model

Open Aurevoy and fill in your model details under Settings:

```
Provider: OpenAI (or any compatible API)
Base URL: https://api.openai.com/v1
Model: gpt-4o-mini
API Key: sk-xxxx
```

Works with OpenAI, DeepSeek, Ollama, and any OpenAI-compatible endpoint. Use your own key — no extra fees.

### 3. Start a Conversation

Tell Aurevoy what you need in the input box. Talk to it like a person.

```
/  Browse available skills (web-search, browser, and more)
```

---

## Contributing

Aurevoy is open source. Contributions are welcome.

```bash
# Prerequisites: Node.js >= 20, Rust (stable), macOS
git clone https://github.com/nullskymc/Aurevoy.git
cd Aurevoy
npm install
npm run dev          # start dev mode
npm run typecheck    # type check
npm run build        # production build
```

More details in [AGENTS.md](AGENTS.md) and [docs/](docs/).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop App | Tauri 2 + React + TypeScript |
| Agent Engine | Node.js + Fastify + SQLite |
| Transport | Local HTTP + SSE streaming |
| Tool Extensions | Built-in tools + MCP protocol (connect external tool servers) |
| Skill System | Slash-command-activated capabilities, custom skills supported |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

---

## What's Included

- Autonomous planning & parallel tool execution
- File read/write/search/copy/move/delete, precision diff edits
- Web search & page fetching with SSRF protection
- Long-term memory (learns your preferences over time)
- Multi-turn conversations, edit & retry, branching threads, context compression
- Multimodal: image/file drag-and-drop, vision model support
- Project workspaces for organizing conversations
- Skill system (slash commands, custom skills)
- macOS native desktop app

Coming next: knowledge base / RAG, agent evaluation framework, release polish. See [ROADMAP](docs/ROADMAP.md).

---

MIT
