import type { ContentBlock } from "@aurevoy/shared";
import { generativeUiRegistry } from "./registry";
import "./generative-ui.css";

interface GenerativeUiBlockProps {
  block: ContentBlock;
  onChoiceSubmit?: (payload: { partId: string; actionId: string; selection: unknown }) => void;
}

export function GenerativeUiBlock({ block, onChoiceSubmit }: GenerativeUiBlockProps) {
  const kind = block.kind ?? "";
  const def = generativeUiRegistry[kind];

  if (!def) {
    return (
      <div className="gen-ui-fallback" role="status">
        <strong>未知 UI 组件</strong>
        <span>{kind || "(missing kind)"}</span>
        {block.fallbackText && <p>{block.fallbackText}</p>}
      </div>
    );
  }

  const parsed = def.validate(block.props);
  if (!parsed.ok) {
    return (
      <div className="gen-ui-fallback is-invalid" role="alert">
        <strong>组件数据无效</strong>
        <span>{kind}: {parsed.error}</span>
        {block.fallbackText && <p>{block.fallbackText}</p>}
      </div>
    );
  }

  const Component = def.component;
  return (
    <div className="gen-ui-root" data-kind={kind}>
      <Component
        id={block.id}
        props={block.props}
        data={parsed.data}
        onChoiceSubmit={onChoiceSubmit}
      />
    </div>
  );
}
