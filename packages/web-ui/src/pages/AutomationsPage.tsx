import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  Automation,
  AutomationCadence,
  AutomationRun,
  CreateAutomationRequest,
  Project,
  RunAutomationResponse,
  UpdateAutomationRequest,
} from "@aurevoy/shared";
import { IconBell, IconBook, IconChevron, IconClock, IconFile, IconSearch, IconTrash } from "../icons";
import { t, type TranslationKey } from "../i18n";
import "./AutomationsPage.css";

interface AutomationsPageProps {
  automations: Automation[];
  projects: Project[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onCreate: (body: CreateAutomationRequest) => Promise<Automation>;
  onUpdate: (id: string, body: UpdateAutomationRequest) => Promise<Automation>;
  onDelete: (id: string) => Promise<void>;
  onRun: (id: string) => Promise<RunAutomationResponse>;
  onLoadRuns: (id: string) => Promise<AutomationRun[]>;
  onOpenTask: (taskId: string) => void;
  onNotice: (message: string | null) => void;
}

interface AutomationDraft {
  name: string;
  goal: string;
  projectId: string;
  cadence: AutomationCadence;
  executionMode: "auto" | "plan";
  enabled: boolean;
}

type AutomationFilter = "all" | "enabled" | "paused";
type SuggestionIconKind = "daily" | "weekly" | "monitor";

interface AutomationSuggestion {
  id: string;
  titleKey: TranslationKey;
  scheduleKey: TranslationKey;
  goalKey: TranslationKey;
  cadence: AutomationCadence;
  executionMode: "auto" | "plan";
  icon: SuggestionIconKind;
}

const EMPTY_DRAFT: AutomationDraft = {
  name: "",
  goal: "",
  projectId: "",
  cadence: "manual",
  executionMode: "auto",
  enabled: false,
};

const SUGGESTIONS: readonly AutomationSuggestion[] = [
  {
    id: "daily-brief",
    titleKey: "automations.suggestion.daily.title",
    scheduleKey: "automations.suggestion.daily.schedule",
    goalKey: "automations.suggestion.daily.goal",
    cadence: "daily",
    executionMode: "auto",
    icon: "daily",
  },
  {
    id: "weekly-review",
    titleKey: "automations.suggestion.weekly.title",
    scheduleKey: "automations.suggestion.weekly.schedule",
    goalKey: "automations.suggestion.weekly.goal",
    cadence: "weekly",
    executionMode: "plan",
    icon: "weekly",
  },
  {
    id: "follow-up",
    titleKey: "automations.suggestion.monitor.title",
    scheduleKey: "automations.suggestion.monitor.schedule",
    goalKey: "automations.suggestion.monitor.goal",
    cadence: "daily",
    executionMode: "auto",
    icon: "monitor",
  },
];

export function AutomationsPage({
  automations,
  projects,
  loading,
  onRefresh,
  onCreate,
  onUpdate,
  onDelete,
  onRun,
  onLoadRuns,
  onOpenTask,
  onNotice,
}: AutomationsPageProps) {
  const [draft, setDraft] = useState<AutomationDraft>(EMPTY_DRAFT);
  const [filter, setFilter] = useState<AutomationFilter>("all");
  const [query, setQuery] = useState("");
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, AutomationRun[]>>({});

  useEffect(() => {
    void onRefresh().catch((error) => {
      onNotice(`自动化加载失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, [onRefresh]);

  useEffect(() => {
    if (!createDialogOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCreateDialogOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [createDialogOpen]);

  useEffect(() => {
    if (!createMenuOpen) return;
    const closeWhenOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest(".automation-create-menu")) {
        setCreateMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    return () => document.removeEventListener("pointerdown", closeWhenOutside);
  }, [createMenuOpen]);

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  const filteredAutomations = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return automations.filter((automation) => {
      if (filter === "enabled" && !automation.enabled) return false;
      if (filter === "paused" && automation.enabled) return false;
      if (!normalizedQuery) return true;
      const projectName = projectNames.get(automation.projectId ?? "") ?? "";
      return [automation.name, automation.goal, projectName]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [automations, filter, projectNames, query]);

  /** 打开创建入口；建议模板只负责预填，不会绕过用户最后的保存确认。 */
  function beginCreate(suggestion?: AutomationSuggestion): void {
    setDraft(suggestion ? {
      name: t(suggestion.titleKey),
      goal: t(suggestion.goalKey),
      projectId: "",
      cadence: suggestion.cadence,
      executionMode: suggestion.executionMode,
      enabled: true,
    } : EMPTY_DRAFT);
    setCreateMenuOpen(false);
    setCreateDialogOpen(true);
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!draft.name.trim() || !draft.goal.trim() || saving) return;
    setSaving(true);
    try {
      await onCreate({
        name: draft.name.trim(),
        goal: draft.goal.trim(),
        projectId: draft.projectId || undefined,
        cadence: draft.cadence,
        executionMode: draft.executionMode,
        enabled: draft.enabled,
      });
      setDraft(EMPTY_DRAFT);
      setCreateDialogOpen(false);
      onNotice("自动化配方已保存");
    } catch (error) {
      onNotice(`保存自动化失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleRefresh(): Promise<void> {
    try {
      await onRefresh();
    } catch (error) {
      onNotice(`自动化刷新失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function handleToggle(automation: Automation): Promise<void> {
    try {
      await onUpdate(automation.id, { enabled: !automation.enabled });
    } catch (error) {
      onNotice(`更新自动化失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function handleRun(automation: Automation): Promise<void> {
    if (runningId) return;
    setRunningId(automation.id);
    try {
      const result = await onRun(automation.id);
      onNotice("自动化任务已启动");
      onOpenTask(result.task.id);
    } catch (error) {
      onNotice(`启动自动化失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRunningId(null);
    }
  }

  async function handleExpand(automation: Automation): Promise<void> {
    if (expandedId === automation.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(automation.id);
    if (runs[automation.id]) return;
    try {
      const nextRuns = await onLoadRuns(automation.id);
      setRuns((prev) => ({ ...prev, [automation.id]: nextRuns }));
    } catch (error) {
      onNotice(`读取运行记录失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function handleDelete(automation: Automation): Promise<void> {
    if (!window.confirm(t("automations.deleteConfirm"))) return;
    try {
      await onDelete(automation.id);
      if (expandedId === automation.id) setExpandedId(null);
      onNotice("自动化配方已删除");
    } catch (error) {
      onNotice(`删除自动化失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <div className="automations-page">
      <header className="automations-page-head">
        <div>
          <h1>{t("automations.title")}</h1>
          <p>{t("automations.subtitle")}</p>
        </div>
        <div className="automation-create-menu">
          <button
            type="button"
            className="automation-create-button"
            aria-expanded={createMenuOpen}
            aria-haspopup="menu"
            onClick={() => setCreateMenuOpen((open) => !open)}
          >
            {t("automations.createButton")}
            <IconChevron className="automation-create-chevron" />
          </button>
          {createMenuOpen ? (
            <div className="automation-create-popover" role="menu">
              <button type="button" role="menuitem" onClick={() => beginCreate()}>
                <span className="automation-menu-plus">＋</span>
                <span>{t("automations.createTask")}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => beginCreate(SUGGESTIONS[0])}>
                <IconBell size={16} />
                <span>{t("automations.createFromSuggestion")}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => void handleRefresh()}>
                <IconClock size={16} />
                <span>{t("automations.refresh")}</span>
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="automation-search" role="search">
        <IconSearch size={21} />
        <input
          value={query}
          placeholder={t("automations.searchPlaceholder")}
          aria-label={t("automations.searchPlaceholder")}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button type="button" className="automation-search-clear" onClick={() => setQuery("")} aria-label={t("automations.clearSearch")}>
            ×
          </button>
        ) : null}
      </div>

      <div className="automation-filters" role="tablist" aria-label={t("automations.filterLabel")}>
        {(["all", "enabled", "paused"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            className={filter === value ? "is-active" : ""}
            onClick={() => setFilter(value)}
          >
            {t(`automations.filter.${value}` as TranslationKey)}
          </button>
        ))}
      </div>

      <section className="automation-list" aria-live="polite" aria-label={t("automations.scheduledLabel")}>
        {loading && automations.length === 0 ? <p className="automation-empty">{t("automations.loading")}</p> : null}
        {!loading && automations.length === 0 ? <p className="automation-empty">{t("automations.empty")}</p> : null}
        {!loading && automations.length > 0 && filteredAutomations.length === 0 ? <p className="automation-empty">{t("automations.noMatches")}</p> : null}
        {filteredAutomations.map((automation) => {
          const status = automation.lastStatus ?? "pending";
          const automationRuns = runs[automation.id] ?? [];
          return (
            <article key={automation.id} className="automation-row" data-enabled={automation.enabled} data-status={status}>
              <button
                type="button"
                className="automation-row-toggle"
                aria-label={automation.enabled ? t("automations.pause") : t("automations.enable")}
                title={automation.enabled ? t("automations.pause") : t("automations.enable")}
                onClick={() => void handleToggle(automation)}
              >
                <span className="automation-row-ring" aria-hidden="true" />
              </button>
              <div className="automation-row-main">
                <div className="automation-row-title-line">
                  <h2>{automation.name}</h2>
                  {status === "running" ? <span className="automation-running-badge">{t("automations.status.running")}</span> : null}
                </div>
                <div className="automation-row-schedule">
                  <span>{formatSchedule(automation)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatNextRun(automation.nextRunAt)}</span>
                  <span aria-hidden="true">·</span>
                  <span className="automation-local-status"><IconClock size={14} /> {t("automations.localScheduled")}</span>
                </div>
                {automation.lastError ? <p className="automation-row-error">{automation.lastError}</p> : null}
              </div>
              <div className="automation-row-actions">
                <button
                  type="button"
                  className="automation-row-action automation-row-action--text"
                  onClick={() => void handleRun(automation)}
                  disabled={runningId !== null || status === "running"}
                  title={t("automations.runNow")}
                >
                  {runningId === automation.id ? t("automations.running") : t("automations.runNow")}
                </button>
                <button type="button" className="automation-row-action" onClick={() => void handleExpand(automation)} title={t("automations.runs")} aria-expanded={expandedId === automation.id}>
                  <IconClock size={15} />
                </button>
                {automation.lastTaskId ? <button type="button" className="automation-row-action automation-row-action--text" onClick={() => onOpenTask(automation.lastTaskId!)}>{t("automations.openTask")}</button> : null}
                <button type="button" className="automation-row-action automation-row-action--danger" onClick={() => void handleDelete(automation)} aria-label={t("automations.delete")} title={t("automations.delete")}>
                  <IconTrash size={15} />
                </button>
              </div>
              {expandedId === automation.id ? (
                <div className="automation-runs">
                  {automationRuns.length === 0 ? <span>{t("automations.noRuns")}</span> : automationRuns.map((run) => (
                    <div key={run.id} className="automation-run-row">
                      <span className={`automation-run-status automation-run-${run.status}`}>{statusLabel(run.status)}</span>
                      <span>{formatTime(run.startedAt)}</span>
                      {run.taskId ? <button type="button" onClick={() => onOpenTask(run.taskId)}>{t("automations.openTask")}</button> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </article>
          );
        })}
      </section>

      <section className="automation-suggestions" aria-labelledby="automation-suggestions-title">
        <h2 id="automation-suggestions-title">{t("automations.suggestions")}</h2>
        <div className="automation-suggestion-list">
          {SUGGESTIONS.map((suggestion) => (
            <button key={suggestion.id} type="button" className={`automation-suggestion automation-suggestion--${suggestion.icon}`} onClick={() => beginCreate(suggestion)}>
              <span className="automation-suggestion-icon"><SuggestionIcon kind={suggestion.icon} /></span>
              <span className="automation-suggestion-copy">
                <span className="automation-suggestion-title">
                  <strong>{t(suggestion.titleKey)}</strong>
                  <span>{t(suggestion.scheduleKey)}</span>
                </span>
                <span className="automation-suggestion-goal">{t(suggestion.goalKey)}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {createDialogOpen ? (
        <AutomationCreateDialog
          draft={draft}
          projects={projects}
          saving={saving}
          onDraftChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
          onSubmit={(event) => void handleCreate(event)}
          onClose={() => setCreateDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}

interface AutomationCreateDialogProps {
  draft: AutomationDraft;
  projects: Project[];
  saving: boolean;
  onDraftChange: (patch: Partial<AutomationDraft>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}

/** 创建弹窗承载完整配置，主页面因此保持截图中的轻量列表结构。 */
function AutomationCreateDialog({
  draft,
  projects,
  saving,
  onDraftChange,
  onSubmit,
  onClose,
}: AutomationCreateDialogProps) {
  return (
    <div className="automation-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="automation-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-dialog-title">
        <div className="automation-dialog-head">
          <div>
            <h2 id="automation-dialog-title">{t("automations.createDialogTitle")}</h2>
            <p>{t("automations.createDialogSubtitle")}</p>
          </div>
          <button type="button" className="automation-dialog-close" onClick={onClose} aria-label={t("automations.cancel")}>×</button>
        </div>
        <form className="automation-form" onSubmit={onSubmit}>
          <label>
            <span>{t("automations.name")}</span>
            <input
              autoFocus
              value={draft.name}
              placeholder={t("automations.namePlaceholder")}
              maxLength={120}
              onChange={(event) => onDraftChange({ name: event.target.value })}
            />
          </label>
          <label className="automation-form-wide">
            <span>{t("automations.goal")}</span>
            <textarea
              value={draft.goal}
              placeholder={t("automations.goalPlaceholder")}
              rows={4}
              onChange={(event) => onDraftChange({ goal: event.target.value })}
            />
          </label>
          <label>
            <span>{t("automations.project")}</span>
            <select value={draft.projectId} onChange={(event) => onDraftChange({ projectId: event.target.value })}>
              <option value="">{t("automations.projectNone")}</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label>
            <span>{t("automations.cadence")}</span>
            <select value={draft.cadence} onChange={(event) => onDraftChange({ cadence: event.target.value as AutomationCadence })}>
              <option value="manual">{t("automations.cadence.manual")}</option>
              <option value="hourly">{t("automations.cadence.hourly")}</option>
              <option value="every_6_hours">{t("automations.cadence.every6")}</option>
              <option value="daily">{t("automations.cadence.daily")}</option>
              <option value="weekly">{t("automations.cadence.weekly")}</option>
            </select>
          </label>
          <label>
            <span>{t("automations.executionMode")}</span>
            <select value={draft.executionMode} onChange={(event) => onDraftChange({ executionMode: event.target.value as "auto" | "plan" })}>
              <option value="auto">{t("automations.mode.auto")}</option>
              <option value="plan">{t("automations.mode.plan")}</option>
            </select>
          </label>
          <label className="automation-checkbox">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => onDraftChange({ enabled: event.target.checked })} />
            <span>{t("automations.enabled")}</span>
          </label>
          <div className="automation-form-actions">
            <button type="button" className="automation-secondary" onClick={onClose} disabled={saving}>{t("automations.cancel")}</button>
            <button type="submit" className="automation-primary" disabled={saving || !draft.name.trim() || !draft.goal.trim()}>
              {saving ? t("automations.creating") : t("automations.save")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function SuggestionIcon({ kind }: { kind: SuggestionIconKind }) {
  if (kind === "daily") return <IconBell size={22} />;
  if (kind === "weekly") return <IconBook size={22} />;
  return <span className="automation-monitor-icon"><IconFile size={20} /><IconSearch size={11} /></span>;
}

function cadenceLabel(cadence: AutomationCadence): string {
  switch (cadence) {
    case "hourly": return t("automations.cadence.hourly");
    case "every_6_hours": return t("automations.cadence.every6");
    case "daily": return t("automations.cadence.daily");
    case "weekly": return t("automations.cadence.weekly");
    default: return t("automations.cadence.manual");
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "running": return t("automations.status.running");
    case "completed": return t("automations.status.completed");
    case "failed": return t("automations.status.failed");
    case "cancelled": return t("automations.status.cancelled");
    default: return t("automations.status.pending");
  }
}

function formatSchedule(automation: Automation): string {
  if (!automation.nextRunAt || automation.cadence === "manual") return cadenceLabel(automation.cadence);
  const date = new Date(automation.nextRunAt);
  if (Number.isNaN(date.getTime())) return cadenceLabel(automation.cadence);
  const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${weekday}（${t("automations.timeLabel")}：${time}）`;
}

function formatNextRun(value?: string): string {
  if (!value) return t("automations.never");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("automations.never");
  const delta = date.getTime() - Date.now();
  if (delta <= 0) return t("automations.nextRunSoon");
  if (delta < 24 * 60 * 60 * 1000) return t("automations.nextRunToday");
  const days = Math.ceil(delta / (24 * 60 * 60 * 1000));
  return t("automations.nextRunInDays").replace("{count}", String(days));
}

function formatTime(value?: string): string {
  if (!value) return t("automations.never");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? t("automations.never") : date.toLocaleString();
}
