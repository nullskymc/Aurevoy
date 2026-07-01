import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { promises as fs } from "node:fs"

export interface FileSnapshot {
  id: string
  path: string
  callId: string
  createdAt: string
}

export interface SnapshotContext {
  taskId: string
  workspaceDir: string
  snapshots: FileSnapshot[]
}

const WRITE_TOOLS = new Set([
  "create_artifact", "apply_artifact", "copy_file", "move_file",
  "rename_file", "create_file", "write_file", "edit_lines", "append_file",
  "session_open", "session_write", "session_close",
  "write", "edit", "apply_artifact",
])

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName)
}

export function getSnapshotDir(taskId: string, workspaceDir: string): string {
  return resolve(workspaceDir, ".aurevoy-snapshots", taskId)
}

export async function captureFileSnapshot(
  filePath: string,
  taskId: string,
  workspaceDir: string,
): Promise<string | null> {
  try {
    const absolutePath = resolve(workspaceDir, filePath)
    const snapshotDir = getSnapshotDir(taskId, workspaceDir)
    await fs.mkdir(snapshotDir, { recursive: true })
    const snapshotId = randomUUID()
    const snapshotPath = resolve(snapshotDir, snapshotId)

    try {
      await fs.copyFile(absolutePath, snapshotPath)
    } catch {
      await fs.writeFile(snapshotPath, "")
    }

    return snapshotId
  } catch {
    return null
  }
}

export async function restoreFileFromSnapshot(
  filePath: string,
  taskId: string,
  workspaceDir: string,
  snapshotId: string,
): Promise<void> {
  const snapshotDir = getSnapshotDir(taskId, workspaceDir)
  const snapshotPath = resolve(snapshotDir, snapshotId)
  const absolutePath = resolve(workspaceDir, filePath)

  try {
    await fs.copyFile(snapshotPath, absolutePath)
  } catch {
    try { await fs.unlink(absolutePath) } catch {}
  }
}

export function createSnapshotManager(
  taskId: string,
  workspaceDir: string,
  existingSnapshots: FileSnapshot[] = [],
) {
  let snapshots = [...existingSnapshots]

  return {
    getSnapshots: () => snapshots as readonly FileSnapshot[],

    captureIfWriteTool: async (
      toolName: string,
      callId: string,
      args: Record<string, unknown>,
    ): Promise<void> => {
      if (!isWriteTool(toolName)) return
      const filePath = typeof args.path === "string" ? args.path : undefined
      if (!filePath) return

      const snapshotId = await captureFileSnapshot(filePath, taskId, workspaceDir)
      if (snapshotId) {
        snapshots.push({
          id: snapshotId,
          path: filePath,
          callId,
          createdAt: new Date().toISOString(),
        })
      }
    },

    restoreSnapshotsForCallIds: async (callIds: Set<string>): Promise<void> => {
      for (const snap of snapshots) {
        if (callIds.has(snap.callId)) {
          await restoreFileFromSnapshot(snap.path, taskId, workspaceDir, snap.id)
        }
      }
    },
  }
}
