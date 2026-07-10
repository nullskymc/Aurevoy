import { useEffect, useState } from "react";
import type { RuntimeSettings } from "@aurevoy/shared";
import { t } from "../../i18n";
import type { KbDir, KbIndexStatus } from "./types";
import { SettingsGroup } from "./layout";

export function KbSettings({ settings: _settings }: { settings: RuntimeSettings | null }) {
  const [dirs, setDirs] = useState<KbDir[]>([]);
  const [status, setStatus] = useState<KbIndexStatus | null>(null);
  const [dirInput, setDirInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const { listKbDirs, getKbStatus } = await import("../../api");
      setDirs(await listKbDirs());
      setStatus(await getKbStatus());
    } catch { setError(t("kb.statusFailed")); }
  }

  async function addDir() {
    const trimmed = dirInput.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      const { createKbDir } = await import("../../api");
      const dir = await createKbDir(trimmed);
      setDirs((prev) => [...prev, dir]);
      setDirInput("");
      setError("");
    } catch { setError(t("kb.addFailed")); }
    setAdding(false);
  }

  async function removeDir(id: string) {
    try {
      const { deleteKbDir } = await import("../../api");
      await deleteKbDir(id);
      setDirs((prev) => prev.filter((d) => d.id !== id));
    } catch { setError(t("kb.deleteFailed")); }
  }

return (
    <>
<SettingsGroup title={t("kb.dirsTitle")}>
        <div className="memory-add">
          <input
            className="memory-add-input"
            value={dirInput}
            placeholder={t("kb.addDirPlaceholder")}
            onChange={(e) => setDirInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addDir(); }}
          />
          <button type="button" className="memory-add-btn" onClick={addDir} disabled={adding || !dirInput.trim()}>
            {t("kb.addDir")}
          </button>
        </div>
        {error && <p className="memory-source" style={{ color: "var(--danger)", margin: "4px 0 0 14px" }}>{error}</p>}

        {dirs.length === 0 ? (
          <p className="memory-empty" style={{ padding: "12px 14px" }}>{t("kb.noDirs")}</p>
        ) : (
          <ul className="memory-list">
            {dirs.map((dir) => (
              <li key={dir.id} className="memory-item">
                <code className="memory-content">{dir.dirPath}</code>
                <div className="memory-item-foot">
                  <span className="memory-source">{dir.recursive ? "recursive" : "non-recursive"}</span>
                  <button type="button" className="memory-link danger" onClick={() => removeDir(dir.id)}>
                    {t("kb.removeDir")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>

      {status && (
        <SettingsGroup title={t("kb.statusTitle")}>
          <div className="settings-row">
            <div className="settings-info">
              <span className="settings-label">{t("kb.totalFiles")}: {status.totalFiles}</span>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-info">
              <span className="settings-label">{t("kb.totalChunks")}: {status.totalChunks}</span>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-info">
              <span className="settings-label">{t("kb.lastIndexed")}: {status.lastIndexed ? new Date(status.lastIndexed).toLocaleString() : t("kb.emptyStatus")}</span>
            </div>
          </div>
        </SettingsGroup>
      )}
    </>
  );
}
