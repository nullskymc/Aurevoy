# 多模态支持（Multimodal）

> Aurevoy v0.2.0 支持用户拖拽、粘贴或手动选择图片/文件，Agent 可读取内容、查看图片，
> 视觉模型可「看见」图片内容。

## 快速开始

### 1. 配置视觉模型

Aurevoy 使用**主模型 + 视觉子模型**的架构：

- **主模型**（Settings → Provider → Model）：处理纯文本对话
- **视觉子模型**（Settings → Provider → 视觉模型）：消息包含图片时自动切换

配置步骤：

1. 打开 Settings → Provider
2. 设置 Base URL 和 API Key（视觉模型通常共用同一 API 端点）
3. 点击「获取模型列表」拉取可用模型
4. 在「Model」填入主模型（如 `deepseek-v4-flash`）
5. 在「视觉模型」填入支持多模态的模型（如 `deepseek-v4-pro`）
6. 点击保存

> **注意**：视觉子模型留空时，图片将以文字引用形式注入（`[用户附带了图片: xxx]`），
> 纯文本模型无法「看到」图片像素内容。

### 2. 添加图片/文件

| 方式 | 操作 | 说明 |
|------|------|------|
| **从 Finder 拖入** | 拖文件/文件夹到输入框 | 文件夹会导入为项目；文件作为附件 |
| **粘贴** | Cmd+V 在输入框 | 系统剪贴板中的图片自动提取 |
| **附件按钮** | 点击输入框左侧 + 按钮 | 清除当前附件 |

### 3. 发送消息

附件 chip 出现在输入框上方。输入文字描述，按 Enter 发送。Agent 会：

1. 读取文本文件内容，注入上下文
2. 检测到图片 → 切换视觉子模型 → 以 base64 多模态格式发送
3. 用户拖入的文件路径被标记为「受信任外部路径」，工具可直接读写

## 功能详情

### 文件拖拽（Finder Drag & Drop）

```
Finder 拖入 report.ts
  → 输入框显示 chip：[📄 report.ts ✕]
  → 发送 "帮我分析性能"
  → Agent 读取文件内容 →
  → 注入 LLM 上下文：
     [Attached Files]
     ### report.ts (path: /Users/xxx/Desktop/report.ts)
     <文件完整内容>
```

- 文本文件（.ts/.js/.json/.md 等）直接注入上下文（≤30KB）
- 超大文件截断并提示 LLM 用 `read_file` 读取完整内容
- 非文本文件提示 LLM 用工具读取
- 文件夹拖入 → 自动导入为项目

### 图片支持（Image）

```
截图 → Cmd+V 粘贴
  → 输入框显示缩略图 chip
  → 发送 "这个错误怎么修"
  → 视觉子模型以 base64 注入图片
  → LLM 看到图片内容并回复
```

- 聊天历史中的图片显示缩略图（横排，点击可全屏查看）
- 图片查看器：点击缩略图 → 全屏 lightbox → ESC/✕/点击背景关闭
- 支持格式：PNG、JPG、GIF、WebP 等（取决于模型）
- 单张最大 20MB

### 目录限制解除

用户显式拖入/粘贴的文件路径（包括已导入的项目目录）自动标记为「受信任外部路径」，
所有文件工具（`read_file`、`write_file`、`edit_file` 等）对这些路径**跳过工作区沙箱检查**，
无需手动将文件复制到工作区。

### 审批系统

高风险工具（写文件、执行命令等）调用前需要用户确认。

审批方式（聊天界面内嵌）：

| 按钮 | 行为 | 有效期 |
|------|------|--------|
| **允许本次** | 仅本次调用通过 | — |
| **本次会话允许** | 本次调用 + 该任务后续同一工具免确认 | 任务结束 |
| **拒绝** | 拒绝本次调用 | — |

全局永久自动批准：Settings → 工具管理 → 勾选工具的「自动批准：跳过审批直接执行」。

## 技术架构

```
[Composer 图片/文件] → [App attachment state]
  → POST /api/tasks { goal, attachments }
  → Agent createTask/addUserTurn 存储 Message.attachments

[Agent Loop runTask]
  ├── collectExternalPaths() → ToolContext.externalPaths → 工具沙箱放行
  ├── buildAttachmentSystemMessage() → 文本文件注入 system context
  └── Provider.stream(messages)
      ├── needsVision? → effectiveModel = visionModel
      ├── toOpenAIMessage(msg, includeImages)
      │   ├── includeImages=true → content: [{text}, {image_url: base64}]
      │   └── includeImages=false → content: "text\n[图片: xxx]"（文本引用）
      └── FETCH /chat/completions { model: effectiveModel, messages }
```

## 相关文件

| 文件 | 职责 |
|------|------|
| `apps/desktop/src/components/Composer.tsx` | 拖拽/粘贴处理、附件 chip、缩略图 |
| `apps/desktop/src/components/Conversation.tsx` | 聊天历史图片展示 |
| `apps/desktop/src/components/ImageViewer.tsx` | 全屏 lightbox 查看器 |
| `apps/desktop/src/App.tsx` | Tauri onDragDropEvent、handlePasteFiles |
| `apps/desktop/src-tauri/src/lib.rs` | file_metadata、save_temp_file 命令 |
| `apps/agent/src/llm/provider.ts` | 多模态 content blocks、视觉模型切换 |
| `apps/agent/src/agent/loop.ts` | 附件上下文注入、externalPaths、session auto-approve |
| `apps/agent/src/tools/builtins.ts` | 沙箱受信任路径放行 |
| `packages/shared/src/index.ts` | MessageAttachment、visionModel 类型 |
