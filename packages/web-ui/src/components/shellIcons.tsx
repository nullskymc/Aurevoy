/** Shared stroke icons for app shell (sidebar / chrome). Matches workbench icon language. */

type IconProps = {
  size?: number;
  className?: string;
};

function iconProps({ size = 16, className }: IconProps) {
  return {
    viewBox: "0 0 16 16",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true as const,
  };
}

export function IconPlus(props: IconProps = {}) {
  return (
    <svg {...iconProps(props)}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  );
}

export function IconSearch(props: IconProps = {}) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="7.2" cy="7.2" r="4" />
      <path d="M10.2 10.2 13 13" />
    </svg>
  );
}

export function IconSkills(props: IconProps = {}) {
  return (
    <svg {...iconProps(props)}>
      <rect x="2.5" y="2.5" width="4.2" height="4.2" rx="0.8" />
      <rect x="9.3" y="2.5" width="4.2" height="4.2" rx="0.8" />
      <rect x="2.5" y="9.3" width="4.2" height="4.2" rx="0.8" />
      <rect x="9.3" y="9.3" width="4.2" height="4.2" rx="0.8" />
    </svg>
  );
}

export function IconSettings(props: IconProps = {}) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 2.4v1.7M8 11.9v1.7M13.6 8h-1.7M4.1 8H2.4M12 4l-1.2 1.2M5.2 10.8 4 12M12 12l-1.2-1.2M5.2 5.2 4 4" />
    </svg>
  );
}

export function IconFolder(props: IconProps = {}) {
  return (
    <svg {...iconProps(props)}>
      <path d="M2.4 5c0-.7.5-1.2 1.2-1.2h2.6l1.1 1.3h5.1c.7 0 1.2.5 1.2 1.2v5.3c0 .7-.5 1.2-1.2 1.2H3.6c-.7 0-1.2-.5-1.2-1.2V5z" />
    </svg>
  );
}

export function IconChat(props: IconProps = {}) {
  return (
    <svg {...iconProps(props)}>
      <path d="M2.8 4.2v5.8c0 .7.5 1.2 1.2 1.2h7.2l2.8 2.2V4.2c0-.7-.5-1.2-1.2-1.2H4c-.7 0-1.2.5-1.2 1.2z" />
    </svg>
  );
}

export function IconTrash(props: IconProps = {}) {
  return (
    <svg {...iconProps({ ...props, size: props.size ?? 14 })}>
      <path d="M3.8 4.5h8.4l-.7 8a.9.9 0 0 1-.9.7H5.4a.9.9 0 0 1-.9-.7l-.7-8zM6.2 4.5V3.4c0-.4.3-.7.7-.7h2.2c.4 0 .7.3.7.7v1.1M2.8 4.5h10.4" />
    </svg>
  );
}

/** 视觉 / 图片输入能力标记（小眼睛） */
export function IconEye(props: IconProps = {}) {
  return (
    <svg {...iconProps({ ...props, size: props.size ?? 14 })}>
      <path d="M1.8 8s2.2-3.8 6.2-3.8S14.2 8 14.2 8s-2.2 3.8-6.2 3.8S1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </svg>
  );
}

export function IconChevron(props: IconProps & { open?: boolean } = {}) {
  const { open, ...rest } = props;
  return (
    <svg
      {...iconProps({ ...rest, size: rest.size ?? 12 })}
      className={[rest.className, "shell-chevron", open ? "is-open" : ""].filter(Boolean).join(" ")}
    >
      <path d="M6 3.5 10 8 6 12.5" />
    </svg>
  );
}
