import { type AppIconProps, strokeIconAttrs } from "./props";

const base14 = (props: AppIconProps = {}) => strokeIconAttrs({ size: 14, ...props });

/** Open/show the directory explorer (right panel tree). */
export function IconShowTree(props: AppIconProps = {}) {
  return (
    <svg {...base14(props)}>
      <path d="M2.5 4.2h3.2l1.1 1.2H13.5v7.1a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V4.2z" />
      <path d="M9.2 8.2h3.3M11 6.5l1.7 1.7L11 9.9" />
    </svg>
  );
}

/** Hide/collapse the directory explorer. */
export function IconHideTree(props: AppIconProps = {}) {
  return (
    <svg {...base14(props)}>
      <path d="M2.5 4.2h3.2l1.1 1.2H13.5v7.1a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V4.2z" />
      <path d="M12.5 8.2H9.2M11 6.5 9.3 8.2 11 9.9" />
    </svg>
  );
}

/** Refresh file tree / reload. */
export function IconRefresh(props: AppIconProps = {}) {
  return (
    <svg {...base14(props)}>
      <path d="M12.8 6.2A5 5 0 1 0 13 9.2" />
      <path d="M12.8 3.5v2.8H10" />
    </svg>
  );
}

/** Close a document tab. */
export function IconClose(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 12, ...props })}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/** Alias for close / dismiss. */
export function IconX(props: AppIconProps = {}) {
  return <IconClose {...props} />;
}

/** Top-bar: toggle whole workbench (editor + tree). */
export function IconWorkbench(props: AppIconProps = {}) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={props.size ?? 18}
      height={props.size ?? 18}
      fill="none"
      className={props.className}
      aria-hidden="true"
    >
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

export function IconPanelLeftOpen(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 18, viewBox: "0 0 20 20", ...props })}>
      <path d="M3.8 4.2h12.4c.9 0 1.6.7 1.6 1.6v8.4c0 .9-.7 1.6-1.6 1.6H3.8c-.9 0-1.6-.7-1.6-1.6V5.8c0-.9.7-1.6 1.6-1.6zM7.4 4.5v11" />
      <path d="M10 7.2l2.8 2.8-2.8 2.8" />
    </svg>
  );
}

export function IconPanelLeftClose(props: AppIconProps = {}) {
  return (
    <svg {...strokeIconAttrs({ size: 18, viewBox: "0 0 20 20", ...props })}>
      <path d="M3.8 4.2h12.4c.9 0 1.6.7 1.6 1.6v8.4c0 .9-.7 1.6-1.6 1.6H3.8c-.9 0-1.6-.7-1.6-1.6V5.8c0-.9.7-1.6 1.6-1.6zM7.4 4.5v11" />
      <path d="M13 7.2l-2.8 2.8 2.8 2.8" />
    </svg>
  );
}

export function IconPanelRightOpen(props: AppIconProps = {}) {
  return <IconShowTree {...props} />;
}

export function IconPanelRightClose(props: AppIconProps = {}) {
  return <IconHideTree {...props} />;
}
