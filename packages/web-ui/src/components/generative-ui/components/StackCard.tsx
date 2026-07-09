import { GenerativeUiBlock } from "../GenerativeUiBlock";
import type { GenerativeUiComponentProps } from "../registry";
import type { ContentBlock } from "@aurevoy/shared";

export type StackProps = {
  children: Array<{ kind: string; props: unknown }>;
};

export function StackCard({
  id,
  data,
  onChoiceSubmit,
}: GenerativeUiComponentProps & { data: StackProps }) {
  return (
    <div className="gen-ui-stack">
      {data.children.map((child, i) => {
        const block: ContentBlock = {
          id: `${id}-child-${i}`,
          type: "ui",
          content: "",
          kind: child.kind,
          props: child.props,
        };
        return (
          <GenerativeUiBlock
            key={block.id}
            block={block}
            onChoiceSubmit={onChoiceSubmit}
          />
        );
      })}
    </div>
  );
}
