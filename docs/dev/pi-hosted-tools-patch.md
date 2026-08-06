# Pi hosted tool 补丁

`patches/pi-hosted-tools.patch` 只为当前 Pi 依赖补充 hosted tool 事件类型与 Provider 事件映射。它由 `scripts/apply-pi-hosted-tools-patch.mjs` 在安装和桌面依赖准备阶段应用。

- 应用前使用 `git apply --check`；已应用时用 reverse check 识别，重复执行不会二次修改。
- 上游文件上下文不匹配时直接失败，不静默跳过，以便在 Pi 升级后先审计事件契约。
- 每次升级 `@earendil-works/pi-ai` / `pi-agent-core` 后必须运行 `npm run prepare-agent-deps`、`npm run typecheck` 和 `npm run regression:m7`。
- 当上游原生支持 `hosted_tool_start` / `hosted_tool_end` 且 Aurevoy 的 Provider 轨迹测试通过后，删除补丁和应用脚本引用；删除前必须确认 hosted tool 事件仍能进入统一 trace，而不是仅确认包能编译。
