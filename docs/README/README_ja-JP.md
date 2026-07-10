<p align="center">
  <img src="../../apps/desktop/public/aurevoy-wordmark.svg" width="320" alt="Aurevoy" />
</p>

# Aurevoy

> *何を*したいかを伝えればよい。*どう*やるかは任せる。  
> 自分のマシン上で動く、仕事を完遂するパーソナル AI エージェント。

---

Aurevoy は**ローカルデスクトップエージェント**です（macOS 優先）。目標を伝えると、計画・ツール実行・ファイル操作・調査・コード編集まで進めます。いつでも中断・承認・巻き戻しができます。

## できること

```
"Downloads の PNG を WebP に変換して"
"React 19 の breaking changes を調べて移行チェックリストを書いて"
"このプロジェクトにダークモードを追加して"
"このメモを週次レポートにまとめて"
```

- **コードとファイル** — 検索・精密編集・ワークスペース境界  
- **調査** — Web 検索/取得（SSRF 対策）、任意の browser skill  
- **マルチモーダル** — 画像/ファイルをドロップ、必要なら vision モデル  
- **記憶とナレッジ** — 好みを記憶；フォルダ KB/RAG  
- **コントロール** — 停止、ツール承認、インライン編集して再試行、分岐  

データは基本的に端末内。API キーは自分のもの（OpenAI 互換 / Anthropic など）。オープンソース。

## はじめ方

1. **インストール** — [Releases](../../releases) の DMG  
2. **設定** — Provider / Base URL / モデル / Key  
3. **会話** — 目標を入力；`/` で skill 一覧

### 開発

```bash
# Node >= 22.19.0, Rust stable, macOS Xcode CLT
git clone https://github.com/nullskymc/Aurevoy.git
cd Aurevoy && npm install
npm run dev
npm run typecheck
```

[AGENTS.md](../../AGENTS.md) · [docs/](../)

## スタック

| 層 | 技術 |
|---|---|
| シェル | Tauri 2 |
| UI | React + TypeScript（`packages/web-ui`） |
| エンジン | Node + Fastify + Pi Agent + SQLite |
| 通信 | ローカル HTTP + SSE |
| 拡張 | 組み込みツール + MCP + Skill |

[ARCHITECTURE](../ARCHITECTURE.md) · [ROADMAP](../ROADMAP.md)

## 現状の能力

計画とツール · 複数 LLM Provider · auto/plan · 複数ターン/再開 ·  
インライン編集再試行 / 分岐 / 圧縮 · サブエージェント · Skill · Web 検索 ·  
マルチモーダル · プロジェクト · 二重予算 · 長期記憶 + KB RAG · 設定と CI  

**進行中：** 署名/自動更新、暗黙 KB 召回、評価とリリース体験。

---

MIT
