/** Shared SVG icons for workbench controls — stroke icons for clear affordance. */

const base = {
  viewBox: "0 0 16 16",
  width: 14,
  height: 14,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
};

/** Open/show the directory explorer (right panel tree). */
export function IconShowTree() {
  return (
    <svg {...base}>
      {/* folder */}
      <path d="M2.5 4.2h3.2l1.1 1.2H13.5v7.1a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V4.2z" />
      {/* expand chevron on the right */}
      <path d="M9.2 8.2h3.3M11 6.5l1.7 1.7L11 9.9" />
    </svg>
  );
}

/** Hide/collapse the directory explorer. */
export function IconHideTree() {
  return (
    <svg {...base}>
      <path d="M2.5 4.2h3.2l1.1 1.2H13.5v7.1a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V4.2z" />
      <path d="M12.5 8.2H9.2M11 6.5 9.3 8.2 11 9.9" />
    </svg>
  );
}

/** Refresh file tree. */
export function IconRefresh() {
  return (
    <svg {...base}>
      <path d="M12.8 6.2A5 5 0 1 0 13 9.2" />
      <path d="M12.8 3.5v2.8H10" />
    </svg>
  );
}

/** Close a document tab. */
export function IconClose() {
  return (
    <svg {...base} width={12} height={12}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/** Top-bar: toggle whole workbench (editor + tree). */
export function IconWorkbench() {
  return (
    <svg viewBox="0 0 20 20" width={18} height={18} fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.35" />
      <path d="M12.5 3.5v13" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M14 7.2h2.2M14 9.5h2.2M14 11.8h1.4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
