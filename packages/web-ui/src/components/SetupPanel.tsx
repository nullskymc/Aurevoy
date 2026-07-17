import type { LlmReadiness } from "@aurevoy/shared";
import { t } from "../i18n";
import "./SetupPanel.css";

export type SetupPanelProps = {
  online: boolean | null;
  llm: LlmReadiness | null | undefined;
  /** hero：空态大卡；dock：对话底条紧凑提示 */
  variant?: "hero" | "dock";
  onConnectProvider: () => void;
  onSelectModel: () => void;
};

type StepId = "engine" | "credential" | "model";

type Step = {
  id: StepId;
  done: boolean;
  label: string;
  hint: string;
};

/**
 * 首次 / 未就绪时的 Setup 引导。
 * 与 health.llm 就绪态对齐：拦发送不够，要把「下一步做什么」说清楚。
 */
export function SetupPanel({
  online,
  llm,
  variant = "hero",
  onConnectProvider,
  onSelectModel,
}: SetupPanelProps) {
  const state = llm?.state;
  const engineDone = online === true;
  const credentialDone =
    state === "ready" || state === "no_model";
  const modelDone = state === "ready";

  // 引擎离线或仍在检测时，不抢 Setup（Composer 已有离线提示）
  if (online !== true) return null;
  // 已就绪：不展示
  if (!llm || llm.ready) return null;

  const steps: Step[] = [
    {
      id: "engine",
      done: engineDone,
      label: t("setup.step.engine"),
      hint: t("setup.step.engineHint"),
    },
    {
      id: "credential",
      done: credentialDone,
      label: t("setup.step.credential"),
      hint: t("setup.step.credentialHint"),
    },
    {
      id: "model",
      done: modelDone,
      label: t("setup.step.model"),
      hint: t("setup.step.modelHint"),
    },
  ];

  const next: StepId =
    !credentialDone ? "credential" : !modelDone ? "model" : "engine";

  const primaryLabel =
    next === "credential"
      ? t("setup.cta.connect")
      : t("setup.cta.selectModel");

  function runPrimary(): void {
    if (next === "credential") onConnectProvider();
    else onSelectModel();
  }

  if (variant === "dock") {
    return (
      <div className="setup-dock" role="status">
        <p className="setup-dock-text">
          {next === "credential" ? t("setup.dock.needCredential") : t("setup.dock.needModel")}
        </p>
        <button type="button" className="setup-dock-cta" onClick={runPrimary}>
          {primaryLabel}
        </button>
      </div>
    );
  }

  return (
    <section className="setup-hero" aria-label={t("setup.title")}>
      <div className="setup-hero-head">
        <h2 className="setup-hero-title">{t("setup.title")}</h2>
        <p className="setup-hero-desc">{t("setup.desc")}</p>
      </div>
      <ol className="setup-steps">
        {steps.map((step, index) => (
          <li
            key={step.id}
            className="setup-step"
            data-done={step.done ? "true" : undefined}
            data-current={!step.done && step.id === next ? "true" : undefined}
          >
            <span className="setup-step-index" aria-hidden="true">
              {step.done ? "✓" : index + 1}
            </span>
            <div className="setup-step-body">
              <span className="setup-step-label">{step.label}</span>
              <span className="setup-step-hint">{step.hint}</span>
            </div>
          </li>
        ))}
      </ol>
      <div className="setup-hero-actions">
        <button type="button" className="setup-primary" onClick={runPrimary}>
          {primaryLabel}
        </button>
        {next === "model" && (
          <button
            type="button"
            className="setup-secondary"
            onClick={onConnectProvider}
          >
            {t("setup.cta.manageProviders")}
          </button>
        )}
      </div>
    </section>
  );
}
