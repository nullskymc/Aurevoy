import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 测试默认使用独立临时目录，避免导入 agent store 时触碰用户数据库。 */
if (!process.env.AUREVOY_DB_PATH) {
  const testRoot = mkdtempSync(join(tmpdir(), "aurevoy-vitest-"));
  process.env.AUREVOY_DB_PATH = join(testRoot, "aurevoy.sqlite");
  process.env.AUREVOY_WORKSPACE_DIR = join(testRoot, "workspace");
}
