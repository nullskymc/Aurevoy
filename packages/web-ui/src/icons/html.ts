import { DEFAULT_STROKE } from "./props";

/**
 * Copy glyph as inline SVG markup for HTML string injection (e.g. marked code blocks).
 * Prefer `IconCopy` in React trees.
 */
export function copySvgHtml(size = 14, strokeWidth = DEFAULT_STROKE): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" ` +
    `stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<rect x="5.5" y="5.5" width="7" height="8" rx="1.2"/>` +
    `<path d="M3.5 10.5V3.5a1 1 0 0 1 1-1h6"/>` +
    `</svg>`
  );
}

/** @deprecated use copySvgHtml */
export const lucideCopySvgHtml = copySvgHtml;
