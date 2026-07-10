/**
 * LLM Provider 图标 — 使用社区维护的 @lobehub/icons-static-svg
 * https://github.com/lobehub/lobe-icons · https://lobehub.com/icons
 *
 * 仅静态导入用到的 slug，避免把 800+ 图标全部打进 bundle。
 * 不引入 @lobehub/icons（依赖 antd / @lobehub/ui）。
 */

import type { CSSProperties } from "react";

import openai from "@lobehub/icons-static-svg/icons/openai.svg?url";
import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg?url";
import deepseekColor from "@lobehub/icons-static-svg/icons/deepseek-color.svg?url";
import geminiColor from "@lobehub/icons-static-svg/icons/gemini-color.svg?url";
import vertexaiColor from "@lobehub/icons-static-svg/icons/vertexai-color.svg?url";
import openrouter from "@lobehub/icons-static-svg/icons/openrouter.svg?url";
import githubcopilot from "@lobehub/icons-static-svg/icons/githubcopilot.svg?url";
import xai from "@lobehub/icons-static-svg/icons/xai.svg?url";
import groq from "@lobehub/icons-static-svg/icons/groq.svg?url";
import cerebrasColor from "@lobehub/icons-static-svg/icons/cerebras-color.svg?url";
import mistralColor from "@lobehub/icons-static-svg/icons/mistral-color.svg?url";
import moonshot from "@lobehub/icons-static-svg/icons/moonshot.svg?url";
import kimiColor from "@lobehub/icons-static-svg/icons/kimi-color.svg?url";
import zai from "@lobehub/icons-static-svg/icons/zai.svg?url";
import zhipuColor from "@lobehub/icons-static-svg/icons/zhipu-color.svg?url";
import xiaomimimo from "@lobehub/icons-static-svg/icons/xiaomimimo.svg?url";
import minimaxColor from "@lobehub/icons-static-svg/icons/minimax-color.svg?url";
import togetherColor from "@lobehub/icons-static-svg/icons/together-color.svg?url";
import fireworksColor from "@lobehub/icons-static-svg/icons/fireworks-color.svg?url";
import huggingfaceColor from "@lobehub/icons-static-svg/icons/huggingface-color.svg?url";
import nvidiaColor from "@lobehub/icons-static-svg/icons/nvidia-color.svg?url";
import vercel from "@lobehub/icons-static-svg/icons/vercel.svg?url";
import azureColor from "@lobehub/icons-static-svg/icons/azure-color.svg?url";
import bedrockColor from "@lobehub/icons-static-svg/icons/bedrock-color.svg?url";
import cloudflareColor from "@lobehub/icons-static-svg/icons/cloudflare-color.svg?url";
import opencode from "@lobehub/icons-static-svg/icons/opencode.svg?url";
import claudeColor from "@lobehub/icons-static-svg/icons/claude-color.svg?url";
import googleColor from "@lobehub/icons-static-svg/icons/google-color.svg?url";

export const PI_PROVIDER_OPTIONS = [
  { value: "openai", label: "OpenAI", popular: true, descKey: "settings.providerDesc.openai" },
  { value: "anthropic", label: "Anthropic", popular: true, descKey: "settings.providerDesc.anthropic" },
  { value: "deepseek", label: "DeepSeek", popular: true, descKey: "settings.providerDesc.deepseek" },
  { value: "google", label: "Google Gemini", popular: true, descKey: "settings.providerDesc.google" },
  { value: "openrouter", label: "OpenRouter", popular: true, descKey: "settings.providerDesc.openrouter" },
  { value: "github-copilot", label: "GitHub Copilot", popular: true, descKey: "settings.providerDesc.github-copilot" },
  { value: "xai", label: "xAI", popular: true, descKey: "settings.providerDesc.xai" },
  { value: "openai-compatible", label: "OpenAI-compatible / Custom", popular: true, descKey: "settings.providerDesc.openai-compatible" },
  { value: "azure-openai-responses", label: "Azure OpenAI Responses", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "ant-ling", label: "Ant Ling", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "google-vertex", label: "Google Vertex", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "groq", label: "Groq", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "cerebras", label: "Cerebras", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "mistral", label: "Mistral", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "moonshotai", label: "Moonshot AI", popular: true, descKey: "settings.providerDesc.moonshotai" },
  { value: "moonshotai-cn", label: "Moonshot AI CN", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "zai", label: "Z.ai", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "zai-coding-cn", label: "Z.ai Coding CN", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "xiaomi", label: "Xiaomi", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "xiaomi-token-plan-cn", label: "Xiaomi Token Plan CN", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "xiaomi-token-plan-ams", label: "Xiaomi Token Plan AMS", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "xiaomi-token-plan-sgp", label: "Xiaomi Token Plan SGP", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "minimax", label: "MiniMax", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "minimax-cn", label: "MiniMax CN", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "together", label: "Together AI", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "fireworks", label: "Fireworks", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "huggingface", label: "Hugging Face", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "nvidia", label: "NVIDIA", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "vercel-ai-gateway", label: "Vercel AI Gateway", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "openai-codex", label: "OpenAI Codex", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "amazon-bedrock", label: "Amazon Bedrock", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "cloudflare-workers-ai", label: "Cloudflare Workers AI", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "opencode", label: "OpenCode", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "opencode-go", label: "OpenCode Go", popular: false, descKey: "settings.providerDesc.generic" },
  { value: "kimi-coding", label: "Kimi Coding", popular: false, descKey: "settings.providerDesc.generic" },
] as const;

export type ProviderOption = (typeof PI_PROVIDER_OPTIONS)[number];

export function providerMeta(id: string): ProviderOption | undefined {
  return PI_PROVIDER_OPTIONS.find((item) => item.value === id);
}

export function providerLabel(id: string): string {
  return providerMeta(id)?.label ?? id;
}

export function providerMonogram(id: string): string {
  const label = providerLabel(id);
  const cleaned = label.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, "");
  return (cleaned.slice(0, 1) || id.slice(0, 1)).toUpperCase();
}

/** Pi provider id → Lobe 静态 SVG URL（优先 color） */
const PROVIDER_ICON_URL: Record<string, string> = {
  openai: openai,
  "openai-compatible": openai,
  "openai-codex": openai,
  "openai-response": openai,
  anthropic: anthropic,
  deepseek: deepseekColor,
  google: geminiColor,
  "google-vertex": vertexaiColor,
  openrouter: openrouter,
  "github-copilot": githubcopilot,
  xai: xai,
  groq: groq,
  cerebras: cerebrasColor,
  mistral: mistralColor,
  moonshotai: moonshot,
  "moonshotai-cn": moonshot,
  zai: zai,
  "zai-coding-cn": zhipuColor,
  xiaomi: xiaomimimo,
  "xiaomi-token-plan-cn": xiaomimimo,
  "xiaomi-token-plan-ams": xiaomimimo,
  "xiaomi-token-plan-sgp": xiaomimimo,
  minimax: minimaxColor,
  "minimax-cn": minimaxColor,
  together: togetherColor,
  fireworks: fireworksColor,
  huggingface: huggingfaceColor,
  nvidia: nvidiaColor,
  "vercel-ai-gateway": vercel,
  "azure-openai-responses": azureColor,
  "amazon-bedrock": bedrockColor,
  "cloudflare-ai-gateway": cloudflareColor,
  "cloudflare-workers-ai": cloudflareColor,
  opencode: opencode,
  "opencode-go": opencode,
  "kimi-coding": kimiColor,
  "ant-ling": claudeColor,
  // 额外别名
  gemini: geminiColor,
  claude: claudeColor,
  googlecloud: googleColor,
};

function normalizeProviderId(id: string): string {
  const raw = id.trim().toLowerCase();
  if (raw.startsWith("moonshot")) return "moonshotai";
  if (raw.startsWith("zai")) return raw.includes("coding") ? "zai-coding-cn" : "zai";
  if (raw.startsWith("xiaomi")) return "xiaomi";
  if (raw.startsWith("minimax")) return "minimax";
  if (raw.startsWith("cloudflare")) {
    return raw.includes("workers") ? "cloudflare-workers-ai" : "cloudflare-ai-gateway";
  }
  if (raw.startsWith("opencode")) return "opencode";
  if (raw.startsWith("google")) return raw.includes("vertex") ? "google-vertex" : "google";
  if (raw.includes("azure") && raw.includes("openai")) return "azure-openai-responses";
  if (raw === "bedrock" || raw === "amazon-bedrock") return "amazon-bedrock";
  if (raw.includes("kimi")) return "kimi-coding";
  if (raw === "openai-response") return "openai";
  return raw;
}

export function resolveProviderIconUrl(providerId: string): string | undefined {
  const id = normalizeProviderId(providerId);
  return PROVIDER_ICON_URL[id];
}

export function ProviderIcon({
  provider,
  className = "settings-provider-glyph",
  title,
  size,
}: {
  provider: string;
  className?: string;
  title?: string;
  size?: number;
}) {
  const id = provider.trim() || "unknown";
  const label = title ?? providerLabel(id);
  const url = resolveProviderIconUrl(id);
  const style: CSSProperties | undefined = size
    ? { width: size, height: size, minWidth: size, minHeight: size }
    : undefined;

  if (url) {
    return (
      <span
        className={`${className} is-logo`}
        data-provider={normalizeProviderId(id)}
        title={label}
        aria-hidden="true"
        style={style}
      >
        <img src={url} alt="" draggable={false} className="provider-icon-img" />
      </span>
    );
  }

  return (
    <span
      className={`${className} is-fallback`}
      data-provider={normalizeProviderId(id)}
      title={label}
      aria-hidden="true"
      style={style}
    >
      <span className="provider-icon-monogram">{providerMonogram(id)}</span>
    </span>
  );
}
