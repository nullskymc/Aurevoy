import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  statfsSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';

export interface DatabaseFileCheck {
  path: string;
  bytes: number;
  quickCheck: 'ok' | 'error';
}

export interface DatabaseBackupResult extends DatabaseFileCheck {
  backupPath: string;
}

export interface DatabaseMaintenanceOptions {
  /** 测试或受控宿主可注入空间探针；生产调用默认使用 statfs。 */
  diskSpaceCheck?: (targetPath: string, requiredBytes: number) => boolean;
}

/** SQLite 的最小磁盘空间检查，避免在已知空间不足时开始复制。 */
export function hasEnoughDiskSpace(targetPath: string, requiredBytes: number): boolean {
  if (!Number.isFinite(requiredBytes) || requiredBytes < 0) return false;
  try {
    const stats = statfsSync(dirname(resolve(targetPath)));
    return Number(stats.bavail) * Number(stats.bsize) >= requiredBytes;
  } catch {
    // 某些受限文件系统不提供 statfs；真正写入失败时仍会返回可操作错误。
    return true;
  }
}

/** 对打开的 SQLite 连接执行快速完整性检查。 */
export function quickCheckDatabase(db: DatabaseType): 'ok' | 'error' {
  try {
    const result = db.prepare('PRAGMA quick_check(1)').get() as { quick_check?: string } | undefined;
    return result?.quick_check === 'ok' ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

/** 对独立数据库文件做只读检查，备份和恢复前都必须经过这一关。 */
export function checkDatabaseFile(filePath: string): DatabaseFileCheck {
  const path = resolve(filePath);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return {
      path,
      bytes: statSync(path).size,
      quickCheck: quickCheckDatabase(db),
    };
  } finally {
    db.close();
  }
}

/**
 * 使用 SQLite backup API 生成可恢复副本，并在返回前打开副本做 quick_check。
 * 调用方应把生成的文件作为下载或用户选择的备份文件交付，不写入应用配置。
 */
export async function createDatabaseBackup(
  db: DatabaseType,
  dbPath: string,
  destinationPath?: string,
  options: DatabaseMaintenanceOptions = {},
): Promise<DatabaseBackupResult> {
  const sourcePath = resolve(dbPath);
  const sourceBytes = existsSync(sourcePath) ? statSync(sourcePath).size : 0;
  const backupPath = resolve(
    destinationPath ?? resolve(dirname(sourcePath), `${basename(sourcePath)}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`),
  );
  mkdirSync(dirname(backupPath), { recursive: true });
  const diskSpaceCheck = options.diskSpaceCheck ?? hasEnoughDiskSpace;
  if (!diskSpaceCheck(backupPath, Math.max(sourceBytes * 2, 1024 * 1024))) {
    throw new Error('Not enough disk space to create SQLite backup');
  }

  try {
    await db.backup(backupPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no space|disk full|enospc/i.test(message)) {
      throw new Error(`SQLite backup failed because the disk is full: ${message}`, { cause: error });
    }
    throw new Error(`SQLite backup failed: ${message}`, { cause: error });
  }

  const checked = checkDatabaseFile(backupPath);
  if (checked.quickCheck !== 'ok') {
    throw new Error(`SQLite backup failed quick_check: ${backupPath}`);
  }
  return { ...checked, backupPath };
}

/**
 * 离线恢复数据库文件。运行中的 Agent 不应调用此函数；恢复后必须重启引擎，
 * 因此这里使用临时文件 + rename，避免留下半个目标文件。
 */
export function restoreDatabaseBackup(
  dbPath: string,
  backupPath: string,
  options: DatabaseMaintenanceOptions = {},
): DatabaseFileCheck {
  const targetPath = resolve(dbPath);
  const sourcePath = resolve(backupPath);
  if (targetPath === sourcePath) throw new Error('SQLite restore source and target must differ');
  const source = checkDatabaseFile(sourcePath);
  if (source.quickCheck !== 'ok') throw new Error(`SQLite restore source failed quick_check: ${sourcePath}`);
  const diskSpaceCheck = options.diskSpaceCheck ?? hasEnoughDiskSpace;
  if (!diskSpaceCheck(targetPath, source.bytes * 2)) {
    throw new Error('Not enough disk space to restore SQLite backup');
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.restore-${randomUUID()}.tmp`;
  try {
    copyFileSync(sourcePath, temporaryPath);
    renameSync(temporaryPath, targetPath);
    for (const sidecar of [`${targetPath}-wal`, `${targetPath}-shm`]) {
      try { unlinkSync(sidecar); } catch { /* sidecar 不存在时无需处理 */ }
    }
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* 清理失败不覆盖原始错误 */ }
    const message = error instanceof Error ? error.message : String(error);
    if (/no space|disk full|enospc/i.test(message)) {
      throw new Error(`SQLite restore failed because the disk is full: ${message}`, { cause: error });
    }
    throw new Error(`SQLite restore failed: ${message}`, { cause: error });
  }

  return checkDatabaseFile(targetPath);
}
