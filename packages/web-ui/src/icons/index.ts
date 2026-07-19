/**
 * Aurevoy icons — local stroke SVGs only (no external icon library).
 *
 * Import from `../icons` (or `@/icons` if aliased). Keep chrome consistent via
 * `strokeIconAttrs` / `currentColor` so light & dark themes both work.
 *
 * Layout:
 *   props.ts          shared size/stroke helpers
 *   shell.tsx         sidebar / chrome
 *   workbench.tsx     workbench panels
 *   common.tsx        actions & status
 *   settings-nav.tsx  settings sidebar
 *   hero.tsx          home suggestion cards
 *   html.ts           string SVG for marked output
 */

export type { AppIconProps } from "./props";
export { DEFAULT_STROKE, strokeIconAttrs } from "./props";

export {
  IconPlus,
  IconSearch,
  IconSkills,
  IconSettings,
  IconSettings2,
  IconFolder,
  IconFolderOpen,
  IconChat,
  IconTrash,
  IconEye,
  IconChevron,
} from "./shell";

export {
  IconShowTree,
  IconHideTree,
  IconRefresh,
  IconClose,
  IconX,
  IconWorkbench,
  IconPanelLeftOpen,
  IconPanelLeftClose,
  IconPanelRightOpen,
  IconPanelRightClose,
} from "./workbench";

export {
  IconCheck,
  IconCopy,
  IconPencil,
  IconExternal,
  IconFile,
  IconImage,
  IconServer,
  IconDatabase,
  IconSparkles,
  IconStar,
  IconBrain,
  IconBook,
  IconChart,
  IconAlert,
  IconAlertCircle,
  IconBan,
  IconSquare,
  IconWrench,
  IconFork,
  IconGauge,
  IconArrowUp,
  IconAlignLeft,
  IconGlobe,
  IconLoader,
  IconClock,
  IconTerminal,
  IconBot,
  IconCompass,
} from "./common";

export {
  SettingsNavIcon,
  SettingsNavLucideIcon,
  type SettingsNavIconName,
} from "./settings-nav";

export { HeroSuggestionIcon } from "./hero";
export { copySvgHtml, lucideCopySvgHtml } from "./html";
