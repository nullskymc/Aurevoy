import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { useEffect, useMemo, useState } from "react";
import type { SkillDescriptor, SkillDetail, SkillInstallResponse } from "@aurevoy/shared";
import { fetchSkillDetail } from "../api";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { t } from "../i18n";
import { IconCheck, IconRefresh, IconSearch, IconX } from "../icons";
import "./SkillsPage.css";

type SourceTab = "personal" | "system";

/** 主列表默认可见条数；超出部分折叠，点击后在原网格继续展开 */
const VISIBLE_SKILL_LIMIT = 6;

function isPersonal(skill: SkillDescriptor): boolean {
  return skill.sourceDir === "user" || skill.sourceDir === "workspace";
}

function isSystem(skill: SkillDescriptor): boolean {
  return skill.sourceDir === "system" || skill.sourceDir === "builtin";
}

function canUninstall(skill: SkillDescriptor): boolean {
  return skill.sourceDir === "user" || skill.sourceDir === "system";
}

function matchesQuery(skill: SkillDescriptor, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q);
}

function formatOverflowLabel(overflow: SkillDescriptor[]): string {
  if (overflow.length === 0) return "";
  const a = overflow[0]?.name ?? "";
  const b = overflow[1]?.name ?? "";
  if (overflow.length === 1) {
    return t("skillsPage.overflowViewOne").replace("{a}", a);
  }
  if (overflow.length === 2) {
    return t("skillsPage.overflowViewTwo").replace("{a}", a).replace("{b}", b);
  }
  return t("skillsPage.overflowViewMore")
    .replace("{a}", a)
    .replace("{b}", b)
    .replace("{n}", String(overflow.length - 2));
}

export function SkillsPage({
  skills,
  installing,
  installError,
  reloading,
  onInstall,
  onReload,
  onToggle,
  onUninstall,
  onTrySkill,
}: {
  skills: SkillDescriptor[];
  installing: boolean;
  installError: string | null;
  reloading: boolean;
  onInstall: (url: string) => Promise<SkillInstallResponse>;
  onReload: () => Promise<void>;
  onToggle: (name: string, enabled: boolean) => Promise<void>;
  onUninstall: (name: string) => Promise<void>;
  /** 跳转对话并预填试用文案 */
  onTrySkill?: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sourceTab, setSourceTab] = useState<SourceTab>("personal");
  const [installOpen, setInstallOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [lastResult, setLastResult] = useState<SkillInstallResponse | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const filtered = useMemo(
    () => skills.filter((s) => matchesQuery(s, query.trim())),
    [skills, query],
  );

  const installed = filtered;
  const tabSkills = useMemo(
    () => filtered.filter((s) => (sourceTab === "personal" ? isPersonal(s) : isSystem(s))),
    [filtered, sourceTab],
  );

  async function handleInstall() {
    const trimmed = url.trim();
    if (!trimmed) return;
    try {
      const result = await onInstall(trimmed);
      setLastResult(result);
      setUrl("");
      setInstallOpen(false);
    } catch {
      /* error via installError prop */
    }
  }

  return (
    <section className="page-panel skills-page" aria-label={t("nav.skills")}>
      <header className="skills-hero">
        <div className="skills-hero-text">
          <h1>{t("nav.skills")}</h1>
          <p>{t("skillsPage.desc")}</p>
        </div>
        <div className="skills-hero-actions">
          <button
            type="button"
            className="skills-icon-btn"
            onClick={() => void onReload()}
            disabled={reloading}
            title={t("skillsPage.reload")}
            aria-label={t("skillsPage.reload")}
          >
            <ReloadIcon spinning={reloading} />
          </button>
          <button
            type="button"
            className="skills-create-btn"
            onClick={() => setInstallOpen((v) => !v)}
          >
            {installOpen ? t("skillsPage.installHide") : t("skillsPage.installShow")}
          </button>
        </div>
      </header>

      <div className="skills-search-shell">
        <SearchIcon />
        <input
          type="search"
          className="skills-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("skillsPage.search")}
          aria-label={t("skillsPage.search")}
        />
      </div>

      {installOpen && (
        <div className="skills-install-area">
          <div className="skills-install-row">
            <input
              type="text"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setLastResult(null);
              }}
              placeholder={t("skillsPage.installPlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleInstall();
              }}
              disabled={installing}
            />
            <button
              type="button"
              className="skills-install-submit"
              onClick={() => void handleInstall()}
              disabled={installing || !url.trim()}
            >
              {installing ? t("skillsPage.installing") : t("skillsPage.install")}
            </button>
          </div>
          {installError && (
            <p className="skill-install-error">
              {t("skillsPage.installFailed")}
              {installError}
            </p>
          )}
          {lastResult && !installError && (
            <p className="skill-install-success">
              {t("skillsPage.reloadSuccess")} ({lastResult.installedSkills?.length ?? 0})
            </p>
          )}
        </div>
      )}

      {installed.length === 0 ? (
        <p className="skills-empty">{query ? t("skillsPage.emptySearch") : t("skillsPage.empty")}</p>
      ) : (
        <>
          <section className="skills-section">
            <h2 className="skills-section-title">{t("skillsPage.installed")}</h2>
            <SkillsSectionList skills={installed} onOpen={(name) => setSelectedName(name)} />
          </section>

          <Tabs.Root
            className="skills-section"
            value={sourceTab}
            onValueChange={(value) => setSourceTab(value as SourceTab)}
          >
            <Tabs.List className="skills-source-tabs" aria-label={t("skillsPage.sourceTabs")}>
              <Tabs.Trigger
                value="personal"
                className="skills-source-tab"
                data-active={sourceTab === "personal"}
              >
                {t("skillsPage.tabPersonal")}
              </Tabs.Trigger>
              <Tabs.Trigger
                value="system"
                className="skills-source-tab"
                data-active={sourceTab === "system"}
              >
                {t("skillsPage.tabSystem")}
              </Tabs.Trigger>
            </Tabs.List>
            {tabSkills.length === 0 ? (
              <p className="skills-empty is-inline">{t("skillsPage.emptyTab")}</p>
            ) : (
              <SkillsSectionList
                key={sourceTab}
                skills={tabSkills}
                onOpen={(name) => setSelectedName(name)}
              />
            )}
          </Tabs.Root>
        </>
      )}

      {selectedName && (
        <SkillDetailModal
          name={selectedName}
          skill={skills.find((s) => s.name === selectedName) ?? null}
          onClose={() => setSelectedName(null)}
          onToggle={onToggle}
          onUninstall={onUninstall}
          onTrySkill={onTrySkill}
        />
      )}
    </section>
  );
}

function SkillsSectionList({
  skills,
  onOpen,
}: {
  skills: SkillDescriptor[];
  onOpen: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasOverflow = skills.length > VISIBLE_SKILL_LIMIT;
  const overflow = skills.slice(VISIBLE_SKILL_LIMIT);
  const shown = expanded || !hasOverflow ? skills : skills.slice(0, VISIBLE_SKILL_LIMIT);

  return (
    <>
      <div className="skills-grid">
        {shown.map((skill) => (
          <SkillListCard key={skill.name} skill={skill} onOpen={() => onOpen(skill.name)} />
        ))}
      </div>
      {hasOverflow && !expanded && (
        <button
          type="button"
          className="skills-overflow-trigger"
          onClick={() => setExpanded(true)}
          aria-label={t("skillsPage.overflowAria").replace("{n}", String(skills.length))}
        >
          <span className="skills-overflow-label">{formatOverflowLabel(overflow)}</span>
        </button>
      )}
      {hasOverflow && expanded && (
        <button
          type="button"
          className="skills-overflow-trigger"
          onClick={() => setExpanded(false)}
          aria-label={t("skillsPage.overflowCollapse")}
        >
          <span className="skills-overflow-label">{t("skillsPage.overflowCollapse")}</span>
        </button>
      )}
    </>
  );
}

function SkillListCard({ skill, onOpen }: { skill: SkillDescriptor; onOpen: () => void }) {
  return (
    <button type="button" className="skills-list-card" onClick={onOpen}>
      <div className="skills-list-card-copy">
        <span className="skills-list-card-name">{skill.name}</span>
        <span className="skills-list-card-desc">{skill.description}</span>
      </div>
      {skill.enabled ? (
        <span className="skills-list-card-check" aria-label={t("skillsPage.enabled")}>
          <CheckIcon />
        </span>
      ) : (
        <span className="skills-list-card-check is-off" aria-hidden="true" />
      )}
    </button>
  );
}

function SkillDetailModal({
  name,
  skill,
  onClose,
  onToggle,
  onUninstall,
  onTrySkill,
}: {
  name: string;
  skill: SkillDescriptor | null;
  onClose: () => void;
  onToggle: (name: string, enabled: boolean) => Promise<void>;
  onUninstall: (name: string) => Promise<void>;
  onTrySkill?: (name: string) => void;
}) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(skill?.enabled ?? true);

  useEffect(() => {
    setEnabled(skill?.enabled ?? true);
  }, [skill?.enabled, name]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchSkillDetail(name)
      .then((data) => {
        if (!cancelled) {
          setDetail(data);
          setEnabled(data.enabled);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  const display = detail ?? skill;
  const uninstallable = skill ? canUninstall(skill) : false;

  async function handleToggle() {
    const next = !enabled;
    setEnabled(next);
    setBusy(true);
    try {
      await onToggle(name, next);
    } catch {
      setEnabled(!next);
    } finally {
      setBusy(false);
    }
  }

  async function handleUninstall() {
    if (!window.confirm(t("skillsPage.deleteConfirm"))) return;
    setBusy(true);
    try {
      await onUninstall(name);
      onClose();
    } catch {
      /* parent surfaces error */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="skills-modal-backdrop" />
        <Dialog.Content
          className="skills-modal"
          aria-label={display?.name ?? name}
        >
          <div className="skills-modal-toolbar">
          <label className="skills-switch" title={enabled ? t("memory.disable") : t("memory.enable")}>
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy || !skill}
              onChange={() => void handleToggle()}
            />
            <span className="skills-switch-track" aria-hidden="true" />
          </label>
            <Dialog.Close asChild>
              <button type="button" className="skills-modal-close" aria-label={t("action.cancel")}>
                <CloseIcon />
              </button>
            </Dialog.Close>
          </div>

          <header className="skills-modal-head">
          <h2>
            {display?.name ?? name}
            <span className="skills-modal-head-suffix"> Skill</span>
          </h2>
          {display?.description && <p className="skills-modal-desc">{display.description}</p>}
          {display && (
            <div className="skills-modal-meta">
              <span className="skills-modal-pill">{display.sourcePath}</span>
              {display.metadata?.version && (
                <span className="skills-modal-pill">{display.metadata.version}</span>
              )}
              {display.installUrl && (
                <span className="skills-modal-pill" title={display.installUrl}>
                  {t("skillsPage.installedFrom")}
                </span>
              )}
            </div>
          )}
          </header>

          <div className="skills-modal-body">
          {loading && <p className="skills-modal-status">{t("skillsPage.loadingDetail")}</p>}
          {error && <p className="skills-modal-status is-error">{error}</p>}
          {!loading && !error && detail && (
            detail.body.trim() ? (
              <div className="skills-modal-markdown">
                <MarkdownRenderer content={detail.body} />
              </div>
            ) : (
              <p className="skills-modal-status">{t("skillsPage.noBody")}</p>
            )
          )}
          </div>

          <footer className="skills-modal-footer">
          {uninstallable ? (
            <button
              type="button"
              className="skills-modal-uninstall"
              onClick={() => void handleUninstall()}
              disabled={busy}
            >
              {t("skillsPage.uninstall")}
            </button>
          ) : (
            <span />
          )}
          {onTrySkill && (
            <button
              type="button"
              className="skills-modal-try"
              onClick={() => onTrySkill(name)}
              disabled={busy || !enabled}
            >
              {t("skillsPage.tryNow")}
            </button>
          )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SearchIcon() {
  return <IconSearch size={16} className="skills-search-icon" />;
}

function CheckIcon() {
  return <IconCheck size={16} strokeWidth={2} />;
}

function CloseIcon() {
  return <IconX size={16} />;
}

function ReloadIcon({ spinning }: { spinning?: boolean }) {
  return <IconRefresh size={16} className={spinning ? "skills-spin" : undefined} />;
}
