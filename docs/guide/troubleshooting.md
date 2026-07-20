---
description: Aurevoy 故障排查：引擎离线、模型失败、审批卡住、知识库搜不到等常见问题。
---

# 故障排查

按症状定位。仍无法解决时，到 [GitHub Issues](https://github.com/nullskymc/Aurevoy/issues) 搜索或提交，并附上：系统版本、应用版本、是否自建、可复现步骤（**不要**贴 API Key）。

## 安装与启动

### 无法打开 / 未验证开发者

仅从 [官方 Releases](https://github.com/nullskymc/Aurevoy/releases) 下载。在 **系统设置 → 隐私与安全性** 允许，或 **右键 → 打开**。见 [快速开始](./quickstart)。

### Windows 安装后无法启动

1. 从 Releases 下载 **NSIS `.exe`**，不要解压 updater 的 `.sig` 文件后直接运行
2. 确认系统具备 WebView2 Runtime；通常 Windows 10/11 已预装，企业精简镜像可能需要由管理员安装
3. 若安全软件拦截首次启动，允许 Aurevoy 拉起本机 Agent 子进程后重试

### 检查更新失败 / 没有新版本

1. 确认本机可访问 `github.com`（代理/防火墙）  
2. 仅正式版 Release 会出现在 `latest` 通道；带 `-` 的预发布不会被标为 latest  
3. 设置页手动再点一次 **检查更新**；仍失败时从 Releases 手动下载安装包  
4. 开发者：确认 CI 已上传 `latest.json` 与对应平台的 `.sig`，见 [自动更新](/dev/auto-update)
5. Mac 报 `None of the fallback platforms ["darwin-aarch64-app", "darwin-aarch64"] were found`：说明 `latest.json` 的 `platforms` 里没有 `darwin-aarch64`，通常是 Release **缺** `*.app.tar.gz` + `.sig`（只发了 DMG）。修复：mac 构建用 `--bundles app,dmg` 后重发；见 [自动更新](/dev/auto-update)

### 引擎一直离线

1. 等待数秒（启动需拉起本机引擎）  
2. 完全退出应用后重开  
3. 检查是否有安全软件拦截本地回环地址  
4. 源码运行时确认 Node / 依赖按 [本地开发](/dev/develop) 就绪  

### 无法发送：未配置 LLM

1. 设置中 Provider 是否有有效 Key / Base URL  
2. 是否在 **模型** 列表中**启用**了模型  
3. 输入区是否选中了已启用的模型  

## 模型与网络

### 请求失败、超时、401 / 403

- Key 是否过期、额度是否用尽  
- Base URL 是否指向正确网关（含是否需要 `/v1`）  
- 模型名是否与服务商目录一致  
- 本机网络 / 代理 / VPN 是否干扰  

换一个已知可用的小模型做「只回复 pong」的最小验证，区分「产品问题」与「上游问题」。

### 本地模型连不上

- 服务是否在监听（Ollama 等是否已启动）  
- Base URL 是否用 `127.0.0.1` 且端口正确  
- 防火墙是否拦截  

## 执行行为

### 一直等待确认

这是审批，不是卡死。核对工具参数后允许或拒绝。见 [权限与审批](./permissions)。

### 终端类工具不可用

设置里 **允许运行终端命令** 可能为关闭。确认需要后再开启，并收紧目标范围。

### 改错了文件

1. **停止**  
2. 用 git 或备份恢复  
3. 用更窄范围 [编辑并重试](./control#编辑消息并重试)，或新开对话明确路径白名单  

### 结果质量差 / 跑偏

对照 [如何写目标](./prompting) 与 [使用习惯](./best-practices)：

- 是否缺少完成标准与约束  
- 是否未绑定项目  
- 是否一条对话塞了过多无关任务  
- 复杂任务是否跳过「先计划」  

### Skill 列表为空

Skill 页点 **重载**；确认未全部停用；Git 安装是否成功。

### 知识库搜不到

- 目录是否已添加且索引完成  
- Embedding 是否配置且服务可达  
- 目标里是否写明资料主题  

## 预算与性能

### 预算已用尽

缩小任务、拆对话，或调整设置中的预算（仅影响新任务）。见 [控制任务](./control#预算用尽)。

### 对话越来越慢、越来越胡

使用 `/compact` 或新开对话，并重申硬约束；稳定偏好写入记忆。

## 隐私相关

### 数据是否上传到 Aurevoy 云？

产品定位为本地个人 Agent：任务与记忆默认在本机。调用云端模型时，内容发往**你配置的 Provider**。

### Key 存在哪？

本机设置存储。不要提交到 git，不要发在 Issue 里。

## 仍需帮助

- [Issues](https://github.com/nullskymc/Aurevoy/issues)  
- 开发构建：[本地开发](/dev/develop) · 仓库 `AGENTS.md`  
