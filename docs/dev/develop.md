---
description: 从源码开发 Aurevoy：环境要求、npm 命令、仓库结构与文档站构建。
---

# 本地开发

面向贡献者与二次开发。完整协作规则见仓库根目录 [`AGENTS.md`](https://github.com/nullskymc/Aurevoy/blob/dev/AGENTS.md)。

终端用户请从 [使用指南](/guide/introduction) 开始，无需阅读本文。

## 环境

| 依赖 | 说明 |
|---|---|
| Node.js | ≥ 22.19.0 |
| Rust | stable（Tauri 2） |
| macOS | Xcode Command Line Tools |

## 克隆与安装

```bash
git clone https://github.com/nullskymc/Aurevoy.git
cd Aurevoy
npm install
```

## 常用命令

```bash
npm run dev              # 引擎 + 桌面
npm run dev:agent        # 仅引擎热重载
npm run typecheck        # 全仓类型检查
npm run build            # shared → web-ui → agent → desktop
npm run build:shared     # 修改 packages/shared 后必做
npm run regression:m3    # 其余 m4–m8 见 package.json
```

### 文档站

```bash
npm run docs:dev         # 本地预览 http://localhost:5173/
npm run docs:build
npm run docs:preview
```

线上文档：https://aurevoy.nullskymc.site/

## 仓库结构

```
apps/desktop     Tauri 壳、子进程托管
apps/agent       Fastify 引擎（Pi harness、工具、存储）
packages/web-ui  React UI
packages/shared  跨进程类型
docs/            用户文档 + VitePress + 协作参考
```

## 规则摘要

1. 跨进程类型只定义在 `packages/shared`，改完执行 `build:shared`  
2. 新工具放在 `apps/agent/src/tool/tools/`，经 registry 注册  
3. 不恢复第二套 ReAct 主循环；Provider 扩展走 Pi 映射  
4. 外部能力缺失时明确失败或降级  
5. 密钥不进仓库  

发布与自动更新见 [自动更新](/dev/auto-update)。更多见 [开发约定](/CONVENTIONS)、[架构](/ARCHITECTURE)。

## 引擎地址

默认 `http://127.0.0.1:8787`。可用环境变量或 `VITE_AGENT_BASE_URL` 覆盖。详见 [API](/API)。

## 文档站点部署

推送 `docs/**` 至 `main` / `dev` 时，由 `.github/workflows/docs.yml` 构建并发布 GitHub Pages。
