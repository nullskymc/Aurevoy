import { useEffect, useState } from "react";
import type { RuntimeSettings } from "@aurevoy/shared";
import { t } from "../../i18n";
import type { KbDir, KbIndexStatus } from "./types";
import { SettingsGroup } from "./layout";

export function KbSettings({
  settings,
  onRecallChange,
  }: {
    settings: RuntimeSettings | null;
  onRecallChange: (enabled: boolean) => void | Promise<void>;
}) {
  const [dirs, setDirs] = useState<KbDir[]>([]);
  const [status, setStatus] = useState<KbIndexStatus | null>(null);
  const [dirInput, setDirInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [recallSaving, setRecallSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const { listKbDirs, getKbStatus } = await import("../../api");
      setDirs(await listKbDirs());
      setStatus(await getKbStatus());
      setError("");
    } catch {
      setError(t("kb.statusFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function addDir() {
    const trimmed = dirInput.trim();
    if (!trimmed) return;
    setAdding(true);
    setError("");
    try {
      const { createKbDir } = await import("../../api");
      const dir = await createKbDir(trimmed);
      setDirs((prev) => [...prev, dir]);
      setDirInput("");
      setError("");
    } catch {
      setError(t("kb.addFailed"));
    }
    setAdding(false);
  }

  async function removeDir(id: string) {
    if (removingId || adding) return;
    setRemovingId(id);
    setError("");
    try {
      const { deleteKbDir } = await import("../../api");
      await deleteKbDir(id);
      setDirs((prev) => prev.filter((d) => d.id !== id));
    } catch {
      setError(t("kb.deleteFailed"));
    } finally {
      setRemovingId(null);
    }
  }

  async function changeRecall(enabled: boolean): Promise<void> {
    if (recallSaving) return;
    setRecallSaving(true);
    setError("");
    try {
      await Promise.resolve(onRecallChange(enabled));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setError(`${t("kb.actionFailed")}${detail}`);
    } finally {
      setRecallSaving(false);
    }
  }

  return (
    <>
      <SettingsGroup title={t("kb.autoRecall")}>
        <label className="settings-row">
          <span>
            <strong>{t("kb.autoRecall")}</strong>
            <small>{t("kb.autoRecallHint")}</small>
          </span>
          <input
            type="checkbox"
            checked={settings?.kbRecallEnabled ?? false}
            disabled={recallSaving}
            onChange={(event) => void changeRecall(event.target.checked)}
          />
        </label>
      </SettingsGroup>
      <SettingsGroup title={t("kb.dirsTitle")}>
        <div className="memory-add">
          <input
            className="memory-add-input"
            value={dirInput}
            placeholder={t("kb.addDirPlaceholder")}
            onChange={(e) => setDirInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void addDir(); }}
          />
          <button
            type="button"
            className="memory-add-btn"
            onClick={() => void addDir()}
            disabled={adding || !dirInput.trim()}
          >
            {adding ? t("kb.adding") : t("kb.addDir")}
          </button>
        </div>

        {error && (
          <p className="memory-empty" style={{ color: "var(--danger)" }} role="alert">{error}</p>
        )}

        {loading ? (
          <p className="memory-empty" aria-live="polite">{t("kb.loading")}</p>
        ) : dirs.length === 0 ? (
          <p className="memory-empty">{t("kb.noDirs")}</p>
        ) : (
          <ul className="memory-list">
            {dirs.map((dir) => (
              <li key={dir.id} className="memory-item">
                <code className="memory-content">{dir.dirPath}</code>
                <div className="memory-item-foot">
                  <span className="memory-source">
                    {dir.recursive ? "recursive" : "non-recursive"}
                  </span>
                  <span className="memory-item-actions">
                    <button
                      type="button"
                      className="memory-link danger"
                      disabled={removingId !== null || adding}
                      onClick={() => void removeDir(dir.id)}
                    >
                      {removingId === dir.id ? t("kb.removing") : t("kb.removeDir")}
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>

      {status && (
        <SettingsGroup title={t("kb.statusTitle")}>
          <div className="settings-row">
            <span>
              <strong>{t("kb.totalFiles")}</strong>
            </span>
            <em>{status.totalFiles}</em>
          </div>
          <div className="settings-row">
            <span>
              <strong>{t("kb.totalChunks")}</strong>
            </span>
            <em>{status.totalChunks}</em>
          </div>
          <div className="settings-row">
            <span>
              <strong>{t("kb.lastIndexed")}</strong>
            </span>
            <em>
              {status.lastIndexed
                ? new Date(status.lastIndexed).toLocaleString()
                : t("kb.emptyStatus")}
            </em>
          </div>
        </SettingsGroup>
      )}
    </>
  );
}
