import { type AppIconProps, strokeIconAttrs } from "./props";

export function IconCheck(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 15, viewBox: "0 0 20 20", ...props })}>
      <path d="M4.5 10.5l3.2 3.2L15.5 6" strokeWidth={props.strokeWidth ?? 1.7} />
    </svg>
  );
}

export function IconCopy(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 15, viewBox: "0 0 20 20", ...props })}>
      <rect x="6.5" y="6.5" width="9" height="9" rx="2" />
      <path d="M13 6.5V5a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h1.5" />
    </svg>
  );
}

export function IconPencil(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 15, viewBox: "0 0 20 20", ...props })}>
      <path d="M4 14.5l-.6 2.6 2.6-.6L16 6.5a1.5 1.5 0 00-2.1-2.1L4 14.5z" />
    </svg>
  );
}

export function IconExternal(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 14, ...props })}>
      <path d="M6 3H3.5A1.5 1.5 0 002 4.5v8A1.5 1.5 0 003.5 14h8a1.5 1.5 0 001.5-1.5V10" />
      <path d="M10 2h4v4M14 2L8 8" />
    </svg>
  );
}

export function IconFile(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 14, ...props })}>
      <path d="M4 2.5h5.2L12 5.3V13a1 1 0 01-1 1H4a1 1 0 01-1-1V3.5a1 1 0 011-1z" />
      <path d="M9 2.5V5h3" />
    </svg>
  );
}

export function IconImage(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 14, viewBox: "0 0 14 14", ...props })}>
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.2" strokeWidth={1.1} />
      <circle cx="5" cy="5.5" r="1.2" strokeWidth={0.9} />
      <path d="M2 9.5l3-3 2.5 2.5L10 6.5l2 3" strokeWidth={1} />
    </svg>
  );
}

export function IconServer(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 17, viewBox: "0 0 20 20", ...props })}>
      <rect x="3.5" y="4" width="13" height="4.8" rx="1.3" strokeWidth={1.35} />
      <rect x="3.5" y="11.2" width="13" height="4.8" rx="1.3" strokeWidth={1.35} />
      <path d="M6.2 6.4h.1M6.2 13.6h.1" strokeWidth={1.8} />
    </svg>
  );
}

export function IconDatabase(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 17, viewBox: "0 0 20 20", ...props })}>
      <ellipse cx="10" cy="5.3" rx="5.8" ry="2.4" strokeWidth={1.35} />
      <path
        d="M4.2 5.3v7.8c0 1.3 2.6 2.4 5.8 2.4s5.8-1.1 5.8-2.4V5.3M4.2 9.2c0 1.3 2.6 2.4 5.8 2.4s5.8-1.1 5.8-2.4"
        strokeWidth={1.35}
      />
    </svg>
  );
}

export function IconSparkles(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 17, viewBox: "0 0 20 20", ...props })}>
      <path
        d="M10 3.5l1.4 3.9 3.9 1.4-3.9 1.4L10 14.1l-1.4-3.9-3.9-1.4 3.9-1.4L10 3.5z"
        strokeWidth={1.35}
      />
      <path d="M15.2 13.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconStar(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 17, viewBox: "0 0 20 20", ...props })}>
      <path
        d="M10 2.8l2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 13.6 5.8 15.8l.8-4.7L3.2 7.8l4.7-.7L10 2.8z"
        strokeWidth={1.35}
      />
    </svg>
  );
}

export function IconBrain(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 17, viewBox: "0 0 20 20", ...props })}>
      <circle cx="10" cy="10" r="6.5" strokeWidth={1.35} />
      <path d="M10 6.5V10l2.5 1.5" strokeWidth={1.35} />
    </svg>
  );
}

export function IconBook(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 17, viewBox: "0 0 20 20", ...props })}>
      <path d="M4 3.5h12v13H4z" strokeWidth={1.35} />
      <path d="M7 7.5h6M7 10.5h4" strokeWidth={1.35} />
    </svg>
  );
}

export function IconChart(props: AppIconProps = {}) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={props.size ?? 17}
      height={props.size ?? 17}
      className={props.className}
      aria-hidden="true"
    >
      <rect x="2.5" y="7" width="3.5" height="9" rx="0.5" fill="currentColor" opacity="0.4" />
      <rect x="7" y="3" width="3.5" height="13" rx="0.5" fill="currentColor" opacity="0.55" />
      <rect x="11.5" y="5" width="3.5" height="11" rx="0.5" fill="currentColor" opacity="0.8" />
      <rect x="16" y="2" width="1.5" height="14" rx="0.5" fill="currentColor" />
    </svg>
  );
}

export function IconAlert(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 14, viewBox: "0 0 20 20", ...props })}>
      <path d="M10 3.2 17.2 16H2.8L10 3.2z" strokeWidth={1.4} />
      <path d="M10 8.2v3.2M10 13.5h.01" strokeWidth={1.5} />
    </svg>
  );
}

export function IconAlertCircle(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 14, viewBox: "0 0 20 20", ...props })}>
      <circle cx="10" cy="10" r="7" strokeWidth={1.4} />
      <path d="M10 6.5v4.2M10 13.2h.01" strokeWidth={1.6} />
    </svg>
  );
}

export function IconBan(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 13, ...props })}>
      <circle cx="8" cy="8" r="5.2" strokeWidth={1.5} />
      <path d="M4.6 4.6l6.8 6.8" strokeWidth={1.5} />
    </svg>
  );
}

export function IconSquare(props: AppIconProps = {}) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={props.size ?? 14}
      height={props.size ?? 14}
      className={props.className}
      aria-hidden="true"
    >
      <rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

export function IconWrench(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 16, viewBox: "0 0 24 24", strokeWidth: 1.6, ...props })}>
      <path d="M14.5 5.5l4 4M8 18l-2.2.6c-.5.1-.9-.3-.8-.8L5.6 15.6 13.2 8a2.2 2.2 0 013.1 0l.1.1a2.2 2.2 0 010 3.1L8 18z" />
    </svg>
  );
}

export function IconFork(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 15, viewBox: "0 0 20 20", strokeWidth: 1.3, ...props })}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="14" cy="5" r="2" />
      <circle cx="10" cy="15" r="2" />
      <path d="M6 7v2a4 4 0 004 4M14 7v2a4 4 0 01-4 4" />
    </svg>
  );
}

export function IconGauge(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 14, viewBox: "0 0 20 20", strokeWidth: 1.4, ...props })}>
      <path d="M4 5.5h12v9H4zM7 5.5V4.2a1 1 0 011-1h4a1 1 0 011 1v1.3" />
      <path d="M4 9.5h12" />
    </svg>
  );
}

export function IconArrowUp(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 18, viewBox: "0 0 20 20", strokeWidth: 1.8, ...props })}>
      <path d="M10 15.5v-11M5 9.5L10 4.5l5 5" />
    </svg>
  );
}

export function IconAlignLeft(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs(props)}>
      <path d="M3 4h10M3 8h10M3 12h6" />
    </svg>
  );
}

export function IconGlobe(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 15, ...props, strokeWidth: 1.25 })}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M2.2 8h11.6M8 1.8c1.7 1.8 2.6 3.8 2.6 6.2S9.7 12.4 8 14.2M8 1.8C6.3 3.6 5.4 5.6 5.4 8s.9 4.4 2.6 6.2" strokeWidth={1.05} />
    </svg>
  );
}

export function IconLoader(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 15, ...props, strokeWidth: 1.4 })}>
      <circle cx="8" cy="8" r="5.6" strokeDasharray="18" />
    </svg>
  );
}

export function IconClock(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 15, ...props, strokeWidth: 1.25 })}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.4v4l2.6 1.5" />
    </svg>
  );
}

export function IconBell(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 17, viewBox: "0 0 20 20", ...props })}>
      <path d="M5.2 9a4.8 4.8 0 019.6 0v2.4l1.5 2.2H3.7l1.5-2.2V9z" />
      <path d="M8 15.2a2.2 2.2 0 004 0M10 2.2v1" />
    </svg>
  );
}

export function IconTerminal(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 14, ...props })}>
      <path d="M3 4.5h10v7H3z" />
      <path d="M5 7l2 1.5L5 10M8.5 10.2H11" />
    </svg>
  );
}

export function IconBot(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 14, ...props })}>
      <rect x="3.5" y="5" width="9" height="7.5" rx="1.5" />
      <path d="M8 3v2M6 8h.01M10 8h.01M6.5 10.5h3" />
    </svg>
  );
}

export function IconCompass(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 16, viewBox: "0 0 24 24", strokeWidth: 1.6, ...props })}>
      <path d="M6 14.5c0-2.5 2.2-4.5 5-4.5s5 2 5 4.5M8 10V7.5a4 4 0 018 0V10" />
      <path d="M7.5 14.5h9l.8 4.2a1.2 1.2 0 01-1.2 1.4H7.9a1.2 1.2 0 01-1.2-1.4L7.5 14.5z" />
      <path d="M10 6.2l1.2-2.4h1.6L14 6.2" />
    </svg>
  );
}
