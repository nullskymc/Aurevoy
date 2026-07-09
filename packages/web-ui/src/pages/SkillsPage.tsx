import { useMemo, useState } from "react";
import type { SkillDescriptor, SkillInstallResponse } from "@aurevoy/shared";
import { t } from "../i18n";
import "./SkillsPage.css";

function formatAllowedTools(allowedTools?: string[]): string {
  if (!allowedTools || allowedTools.length === 0) return t("skillsPage.allTools");
  return allowedTools.join(" · ");
}

export function SkillsPage({
  skills,
  installing,
  installError,
  reloading,
  onInstall,
  onReload,
  onToggle,
}: {
  skills: SkillDescriptor[];
  installing: boolean;
  installError: string | null;
  reloading: boolean;
  onInstall: (url: string) => Promise<SkillInstallResponse>;
  onReload: () => Promise<void>;
  onToggle: (name: string, enabled: boolean) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [lastResult, setLastResult] = useState<SkillInstallResponse | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set(["workspace", "user", "system"]));

  const filtered = query.trim()
    ? skills.filter((s) => {
        const q = query.toLowerCase();
        return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
      })
    : skills;

  async function handleInstall() {
    const trimmed = url.trim();
    if (!trimmed) return;
    try {
      const result = await onInstall(trimmed);
      setLastResult(result);
      setUrl("");
      setInstallOpen(false);
    } catch {
      /* error shown via installError prop */
    }
  }

  function toggleGroup(id: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const groups = useMemo(() => {
    const map = new Map<string, SkillDescriptor[]>();
    for (const skill of filtered) {
      const key = skill.sourceDir;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(skill);
    }

    const order = ["workspace", "user", "system", "builtin"];
    const result: Array<{ key: string; labelKey: string; skills: SkillDescriptor[] }> = [];
    for (const key of order) {
      const items = map.get(key);
      if (items) {
        result.push({ key, labelKey: `skillsPage.group.${key}`, skills: items });
        map.delete(key);
      }
    }
    for (const [key, items] of map) {
      result.push({ key, labelKey: "skillsPage.group.other", skills: items });
    }
    return result;
  }, [filtered]);

  return (
    <section className="page-panel">
      <header className="skills-page-header">
        <div>
          <h1>{t("nav.skills")}</h1>
          <p className="skills-page-summary">{skills.length} skills</p>
        </div>
        <div className="skills-page-actions">
          <button
            type="button"
            className="ghost-btn"
            onClick={onReload}
            disabled={reloading}
            title={t("skillsPage.reload")}
          >
            {reloading ? t("skillsPage.reloading") : t("skillsPage.reload")}
          </button>
          {lastResult && !installError && (
            <span className="skill-install-success">
              {t("skillsPage.reloadSuccess")} ({lastResult.installedSkills?.length ?? skills.length})
            </span>
          )}
        </div>
      </header>

      <div className="skills-search-bar">
        <input
          type="text"
          className="skills-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("skillsPage.search")}
        />
        <button type="button" className="ghost-btn" onClick={() => setInstallOpen(!installOpen)}>
          {installOpen ? t("skillsPage.installHide") : t("skillsPage.installShow")}
        </button>
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
            <button type="button" className="btn-primary" onClick={handleInstall} disabled={installing || !url.trim()}>
              {installing ? t("skillsPage.installing") : t("skillsPage.install")}
            </button>
          </div>
          {installError && <p className="skill-install-error">{t("skillsPage.installFailed")}{installError}</p>}
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="page-empty">{query ? t("search.placeholder") : t("skillsPage.empty")}</p>
      ) : (
        groups.map((group) => (
          <section key={group.key} className="skills-group-section">
            <button
              type="button"
              className="skills-group-header"
              onClick={() => toggleGroup(group.key)}
              aria-expanded={expandedGroups.has(group.key)}
            >
              <span className="skills-group-arrow">{expandedGroups.has(group.key) ? "\u25be" : "\u25b8"}</span>
              <span>{t(group.labelKey as "skillsPage.group.workspace").replace("{n}", String(group.skills.length))}</span>
              <span className="skills-group-count">{group.skills.length}</span>
            </button>
            {expandedGroups.has(group.key) && (
              <div className="skills-group-body">
                {group.skills.map((skill) => (
                  <article key={skill.name} className="skills-card">
                    <header className="skills-card-head">
                      <label className="skills-card-toggle" title={skill.enabled ? t("memory.disable") : t("memory.enable")}>
                        <input type="checkbox" checked={skill.enabled} onChange={() => onToggle(skill.name, !skill.enabled)} />
                      </label>
                      <strong>{skill.name}</strong>
                      <span className={`skills-card-badge source-${skill.sourceDir}`}>{skill.sourcePath}</span>
                    </header>
                    <p className="skills-card-desc">{skill.description}</p>
                    <div className="skills-card-meta">
                      {skill.metadata?.version && <span className="skills-card-meta-item">{skill.metadata.version}</span>}
                      {skill.license && <span className="skills-card-meta-item">{skill.license}</span>}
                      <span className="skills-card-meta-item">{formatAllowedTools(skill.allowedTools)}</span>
                    </div>
                    {skill.installUrl && (
                      <p className="skills-card-source" title={skill.installUrl}>
                        {t("skillsPage.installedFrom")}: {skill.installUrl}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        ))
      )}
    </section>
  );
}
