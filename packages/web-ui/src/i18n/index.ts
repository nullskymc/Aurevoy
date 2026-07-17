import { zh } from "./locales/zh";
import { en } from "./locales/en";
import { ko } from "./locales/ko";
import { ja } from "./locales/ja";

/**
 * 轻量 i18n 层（零依赖）。当前支持中文、英文、韩文和日文，所有 UI 文案统一从字典取，
 * 为后续接入更多语言或运行时切换语言预留入口，而不必到处改硬编码字符串。
 *
 * 需要运行时切换语言并触发 React 重渲染时，可在此基础上加一个 Context/Hook 包装 t()。
 */
export type Locale = "zh" | "en" | "ko" | "ja";
export type TranslationKey = keyof typeof zh;

export const SUPPORTED_LOCALES = ["zh", "en", "ko", "ja"] as const;

const dictionaries: Record<Locale, Record<TranslationKey, string>> = { zh, en, ko, ja };

let currentLocale: Locale = "en";

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

/** 按当前语言取文案；缺失时回退为 key 本身，便于发现未翻译项。 */
export function t(key: TranslationKey): string {
  return dictionaries[currentLocale][key] ?? key;
}

/**
 * 将 BCP 47 语言标签映射到应用 Locale。
 * 只认主语言（zh-CN / zh-TW → zh；en-US → en 等）；无匹配返回 null。
 */
export function mapLanguageTagToLocale(tag: string): Locale | null {
  const normalized = tag.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return null;
  const primary = normalized.split("-")[0] ?? "";
  if (primary === "zh" || normalized.startsWith("zh-")) return "zh";
  if (primary === "ja") return "ja";
  if (primary === "ko") return "ko";
  if (primary === "en") return "en";
  return null;
}

/**
 * 根据系统 / 浏览器语言列表选择 Locale。
 * 按 languages 优先级取第一个可映射项；全部未知则 en。
 * @param languages 可注入以便单测；默认读 navigator.languages / language
 */
export function detectSystemLocale(
  languages?: readonly string[] | null,
): Locale {
  const tags = resolveLanguageCandidates(languages);
  for (const tag of tags) {
    const mapped = mapLanguageTagToLocale(tag);
    if (mapped) return mapped;
  }
  return "en";
}

function resolveLanguageCandidates(
  languages?: readonly string[] | null,
): string[] {
  if (languages && languages.length > 0) {
    return [...languages];
  }
  if (typeof navigator === "undefined") {
    return [];
  }
  const list: string[] = [];
  if (Array.isArray(navigator.languages)) {
    list.push(...navigator.languages);
  }
  if (navigator.language) {
    list.push(navigator.language);
  }
  return list;
}
