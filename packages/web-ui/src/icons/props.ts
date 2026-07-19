/**
 * Shared icon props for Aurevoy stroke icons.
 * All icons use `currentColor` so light/dark themes stay consistent.
 */

export type AppIconProps = {
  size?: number;
  className?: string;
  /** Default 1.4 matches original shell chrome. */
  strokeWidth?: number;
  /** Rarely used (e.g. filled stop square). Prefer stroke + currentColor. */
  fill?: string;
  color?: string;
};

export const DEFAULT_STROKE = 1.4;

export function strokeIconAttrs({
  size = 16,
  className,
  strokeWidth = DEFAULT_STROKE,
  fill = "none",
  color = "currentColor",
  viewBox = "0 0 16 16",
}: AppIconProps & { viewBox?: string } = {}) {
  return {
    viewBox,
    width: size,
    height: size,
    fill,
    stroke: color,
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true as const,
  };
}
