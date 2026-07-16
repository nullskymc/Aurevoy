# 路线图

> 完成标准：真实链路、失败可诊断、状态可恢复、验证可复现。  
> 细节契约见 `packages/shared` 与源码；本文只维护**状态**与**未竟项**。

## 已完成（不再展开）

| 域 | 内容 |
|---|---|
| 底座 | Monorepo、HTTP+SSE、shared 契约、Tauri 壳、Pi AgentHarness |
| 工具与安全 | 内置文件/网络工具、三级风险、审批门、MCP、Effect 工具框架、沙箱边界 |
| 规划与模式 | Scout、执行计划展示、Agent 自动执行、安全暂停 |
| 会话控制 | 多轮、resume、内联编辑重试（revert+continue）、unrevert、branch、compact |
| 子代理 | 多角色 `delegate`、并发闸门、进度 SSE、Timeline 工作组 |
| 记忆与知识 | 长期记忆 CRUD、sqlite-vec 混合检索、Dreams、KB 索引/recall、设置面板 |
| 交付面 | 追问、产物、双层预算、token usage、checkpoint、工作台、多模态、Skill |
| 工程 | 轨迹日志、M3–M8 回归、跨平台 CI、i18n、模型多 Provider 槽位 |

验证：

```bash
npm run typecheck && npm run build
npm run regression:m3   # … m8 见 package.json
```

## 进行中

### M5 分发 🚧

- [x] 设置 / 工具 / 数据 / MCP / 模型槽位 / i18n / 引擎托管 / CI  
- [x] 自动更新（Tauri updater + GitHub Releases `latest.json`；设置页检查/安装）  
- [ ] macOS Apple 代码签名与公证（需 Apple Developer）  
- [ ] Windows 适配（WebView2、原生模块、路径）

### M8 体验深化 🚧

**KB / RAG**

- [x] 索引目录、增量索引、KNN `recall`、Embedding 配置、设置 UI  
- [ ] 隐式自动召回（任务开始时注入 KB 上下文）

**评测**

- [ ] `scripts/evals/` 真实任务集 + 规则评分（+ 可选 LLM Judge）  
- [ ] `npm run eval:agent-usability` 发布门槛

**浏览器**

- [x] 预装 browser skill + Playwright MCP 兼容说明  
- [x] 预装 research skill（快速/深度报告；Markdown 默认，HTML 可选）  
- [ ] 推荐 MCP 模板（默认关闭高风险动作）  
- [ ] 截图/DOM 摘要更顺畅进入 workbench

**发布**

- [ ] 首次启动向导、健康页、数据导出/清理体验  
- [x] GitHub Releases 多平台安装包 + updater 通道（`latest.json`）  
- [ ] macOS 公证安装体验、Windows 签名安装体验

## 原则

1. 一次推进有边界的目标；不做假完成。  
2. 类型变更：先 `packages/shared` → `build:shared` → agent / web-ui。  
3. 主执行链只走 Pi；控制面保留审批、沙箱、轨迹、SSE。  
4. 多 Agent 编排 / 后训练不是近期目标。
