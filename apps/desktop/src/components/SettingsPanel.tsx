import type { HealthResponse, ToolDescriptor } from "@aurevoy/shared";

interface SettingsPanelProps {
  health: HealthResponse | null;
  tools: ToolDescriptor[];
}

export function SettingsPanel({ health, tools }: SettingsPanelProps) {
  return (
    <section id="settings" className="settings-strip" aria-label="运行设置">
      <div>
        <span>Provider</span>
        <strong>Mock</strong>
      </div>
      <div>
        <span>Agent Engine</span>
        <strong>{health ? health.version : "离线"}</strong>
      </div>
      <div>
        <span>Tools</span>
        <strong>{tools.length}</strong>
      </div>
      <div id="memory">
        <span>Memory</span>
        <strong>本地优先</strong>
      </div>
    </section>
  );
}
