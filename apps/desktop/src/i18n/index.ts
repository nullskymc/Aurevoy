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
