import { Schema } from 'effect';
import { make } from '../../framework/definition.js';

const ContentOutput = Schema.Union(
  Schema.Struct({ contentBlock: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
);

export const attachContentTool = make({
  name: 'attach_content',
  description: '向用户交付文件或链接。file_reference / image 会在对话中显示卡片，并默认在右侧工作台打开预览；link 类型仅展示可点击链接。',
  riskLevel: 'safe',
  input: Schema.Struct({
    type: Schema.Literal('file_reference', 'image', 'link').annotations({ description: 'Content type.' }),
    content: Schema.String.annotations({ description: 'File path, image path, or URL.' }),
    name: Schema.optional(Schema.String),
    mimeType: Schema.optional(Schema.String),
    size: Schema.optional(Schema.Number),
  }),
  output: ContentOutput,
  execute: async (input) => ({ contentBlock: { type: input.type, content: input.content, name: input.name, mimeType: input.mimeType, size: input.size } }),
});

export const presentUiTool = make({
  name: 'present_ui',
  description: '在对话中直接展示交互式 UI。当前仅支持 canvas：HTML、CSS 与 JavaScript 都在 sandbox iframe 内运行；适合数据探索器、图表、筛选器和局部交互。使用相同 id 可更新既有片段。',
  riskLevel: 'safe',
  input: Schema.Struct({
    kind: Schema.Literal('canvas'),
    props: Schema.Unknown.annotations({ description: 'Canvas HTML fragment and optional script, css, title, description, and state.' }),
    id: Schema.optional(Schema.String),
    fallbackText: Schema.optional(Schema.String),
  }),
  output: ContentOutput,
  execute: async (input) => {
    try {
      const props = validateCanvasProps(input.props);
      const id = input.id && /^[a-zA-Z0-9_-]{1,64}$/.test(input.id.trim()) ? input.id.trim() : undefined;
      const fallbackText = input.fallbackText?.trim().slice(0, 2_000) || `交互式界面${props.title ? `「${props.title}」` : ''}`;
      return { contentBlock: { type: 'ui', id, kind: 'canvas', props, content: fallbackText, fallbackText } };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  },
});

/** 校验 iframe 负载，防止异常大内容或跨宿主、网络能力穿透。 */
function validateCanvasProps(raw: unknown): { title?: string; description?: string; state: Record<string, string | number | boolean | null>; html: string; css?: string; script?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('canvas props 必须是对象');
  const props = raw as Record<string, unknown>;
  const html = typeof props.html === 'string' ? props.html.trim() : '';
  const script = typeof props.script === 'string' ? props.script.trim() : '';
  const css = typeof props.css === 'string' ? props.css : undefined;
  if (!html) throw new Error('canvas 必须包含非空 html fragment');
  if (html.length > 80_000 || script.length > 80_000 || (css?.length ?? 0) > 40_000) throw new Error('canvas html、css 或 script 超出长度限制');
  if (/<!doctype|<\s*(html|head|body|script|iframe|object|embed)\b/i.test(html) || /\son[a-z]+\s*=/i.test(html)) throw new Error('canvas html 必须是片段，且不得包含文档标签、脚本、嵌入内容或内联事件处理器');
  if (css && (/@import\b/i.test(css) || /url\(\s*['"]?https?:/i.test(css))) throw new Error('canvas css 不得加载远程资源');
  if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\b/.test(script) || /\b(parent|top|opener)\s*\./.test(script)) throw new Error('canvas script 不得访问网络或宿主窗口');
  const state: Record<string, string | number | boolean | null> = {};
  if (props.state && typeof props.state === 'object' && !Array.isArray(props.state)) {
    for (const [key, value] of Object.entries(props.state as Record<string, unknown>).slice(0, 40)) {
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) continue;
      if (value === null || typeof value === 'boolean') state[key] = value;
      else if (typeof value === 'number') state[key] = Number.isFinite(value) ? value : 0;
      else state[key] = String(value).slice(0, 1_000);
    }
  }
  return { title: typeof props.title === 'string' ? props.title.trim().slice(0, 160) : undefined, description: typeof props.description === 'string' ? props.description.trim().slice(0, 500) : undefined, state, html, css, script: script || undefined };
}
