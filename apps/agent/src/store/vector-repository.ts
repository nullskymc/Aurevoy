import type Database from "better-sqlite3";

type VectorTableName = "memory_vec" | "kb_chunk_vec";

interface VectorTableConfig {
  tableName: VectorTableName;
  idColumn: "memory_id" | "chunk_id";
  resetSql: string;
}

export interface VectorStore {
  isVecLoaded(): boolean;
  serializeVector(vec: Float32Array): Buffer;
  deserializeVector(buffer: Buffer): Float32Array;
  detectVectorDimensions(tableName: string): number;
  upsertMemoryVec(memoryId: string, embedding: Float32Array): boolean;
  deleteMemoryVec(memoryId: string): void;
  searchMemoryVec(queryVec: Float32Array, k: number): Array<{ memoryId: string; distance: number }>;
  upsertKbChunkVec(chunkId: string, embedding: Float32Array): boolean;
  deleteKbChunkVec(chunkId: string): void;
  deleteKbChunkVec(chunkIds: string[]): void;
  searchKbChunkVec(queryVec: Float32Array, k: number): Array<{ chunkId: string; distance: number }>;
}

const VECTOR_TABLES: Record<VectorTableName, VectorTableConfig> = {
  memory_vec: {
    tableName: "memory_vec",
    idColumn: "memory_id",
    resetSql: "UPDATE memories SET embedding_updated_at = NULL",
  },
  kb_chunk_vec: {
    tableName: "kb_chunk_vec",
    idColumn: "chunk_id",
    resetSql: "UPDATE kb_chunks SET embedding_updated_at = NULL",
  },
};

function getVectorTableConfig(tableName: string): VectorTableConfig | undefined {
  return tableName === "memory_vec" || tableName === "kb_chunk_vec"
    ? VECTOR_TABLES[tableName]
    : undefined;
}

/** sqlite-vec repository；表结构、维度重建和 KNN 查询集中在此处。 */
export function createVectorStore(
  db: Database.Database,
  invalidateMemorySummary: () => void,
): VectorStore {
  function isVecLoaded(): boolean {
    try {
      db.prepare("SELECT vec_version()").get();
      return true;
    } catch {
      return false;
    }
  }

  function serializeVector(vec: Float32Array): Buffer {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  }

  function deserializeVector(buffer: Buffer): Float32Array {
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  }

  function detectVectorDimensions(tableName: string): number {
    if (!isVecLoaded()) return 0;
    const table = getVectorTableConfig(tableName);
    if (!table) return 0;
    try {
      const schema = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table.tableName) as { sql: string | null } | undefined;
      const schemaMatch = schema?.sql?.match(/embedding\s+FLOAT\[(\d+)\]/i);
      if (schemaMatch) return Number.parseInt(schemaMatch[1], 10);

      const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; type: string }>;
      const embeddingColumn = rows.find((row) => row.name === "embedding");
      const match = embeddingColumn?.type.match(/FLOAT\[(\d+)\]/i);
      return match ? Number.parseInt(match[1], 10) : 0;
    } catch {
      return 0;
    }
  }

  function upsertMemoryVec(memoryId: string, embedding: Float32Array): boolean {
    if (!ensureVectorTableDimensions(VECTOR_TABLES.memory_vec, embedding.length)) return false;
    return upsertVector(VECTOR_TABLES.memory_vec, memoryId, embedding);
  }

  function deleteMemoryVec(memoryId: string): void {
    if (!isVecLoaded()) return;
    try {
      db.prepare("DELETE FROM memory_vec WHERE memory_id = ?").run(memoryId);
    } catch {
      // 派生向量表不存在时按降级路径继续。
    }
  }

  function searchMemoryVec(
    queryVec: Float32Array,
    k: number,
  ): Array<{ memoryId: string; distance: number }> {
    if (!ensureVectorTableDimensions(VECTOR_TABLES.memory_vec, queryVec.length)) return [];
    try {
      const rows = db.prepare(`
        SELECT memory_id, distance
        FROM memory_vec
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance
      `).all(serializeVector(queryVec), k) as Array<{ memory_id: string; distance: number }>;
      return rows.map((row) => ({ memoryId: row.memory_id, distance: row.distance }));
    } catch (error) {
      console.warn("[db] memory_vec KNN 搜索失败:", error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  function upsertKbChunkVec(chunkId: string, embedding: Float32Array): boolean {
    if (!ensureVectorTableDimensions(VECTOR_TABLES.kb_chunk_vec, embedding.length)) return false;
    return upsertVector(VECTOR_TABLES.kb_chunk_vec, chunkId, embedding);
  }

  function deleteKbChunkVec(chunkId: string): void;
  function deleteKbChunkVec(chunkIds: string[]): void;
  function deleteKbChunkVec(arg: string | string[]): void {
    if (!isVecLoaded()) return;
    const ids = Array.isArray(arg) ? arg : [arg];
    if (ids.length === 0) return;
    try {
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(`DELETE FROM kb_chunk_vec WHERE chunk_id IN (${placeholders})`).run(...ids);
    } catch {
      // 派生向量表不存在时按降级路径继续。
    }
  }

  function searchKbChunkVec(
    queryVec: Float32Array,
    k: number,
  ): Array<{ chunkId: string; distance: number }> {
    if (!ensureVectorTableDimensions(VECTOR_TABLES.kb_chunk_vec, queryVec.length)) return [];
    try {
      const rows = db.prepare(`
        SELECT chunk_id, distance
        FROM kb_chunk_vec
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance
      `).all(serializeVector(queryVec), k) as Array<{ chunk_id: string; distance: number }>;
      return rows.map((row) => ({ chunkId: row.chunk_id, distance: row.distance }));
    } catch (error) {
      console.warn("[db] kb_chunk_vec KNN 搜索失败:", error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  function ensureVectorTableDimensions(table: VectorTableConfig, dimensions: number): boolean {
    if (!isVecLoaded() || !Number.isInteger(dimensions) || dimensions <= 0) return false;
    const exists = vectorTableExists(table);
    const currentDimensions = exists ? detectVectorDimensions(table.tableName) : 0;
    if (exists && currentDimensions === dimensions) return true;

    try {
      db.exec(`DROP TABLE IF EXISTS ${table.tableName}`);
      createVectorTable(table, dimensions);
      db.exec(table.resetSql);
      if (table.tableName === "memory_vec") invalidateMemorySummary();
      if (exists && currentDimensions > 0 && currentDimensions !== dimensions) {
        console.warn(`[db] ${table.tableName} 向量维度从 ${currentDimensions} 切换为 ${dimensions}，已重建索引并等待重新 embedding`);
      }
      return true;
    } catch (error) {
      console.warn(
        `[db] ${table.tableName} 向量表维度初始化失败:`,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  function upsertVector(table: VectorTableConfig, id: string, embedding: Float32Array): boolean {
    try {
      db.prepare(`INSERT INTO ${table.tableName} (${table.idColumn}, embedding) VALUES (?, ?)`)
        .run(id, serializeVector(embedding));
      return true;
    } catch {
      try {
        db.prepare(`DELETE FROM ${table.tableName} WHERE ${table.idColumn} = ?`).run(id);
        db.prepare(`INSERT INTO ${table.tableName} (${table.idColumn}, embedding) VALUES (?, ?)`)
          .run(id, serializeVector(embedding));
        return true;
      } catch {
        return false;
      }
    }
  }

  function vectorTableExists(table: VectorTableConfig): boolean {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table.tableName) as { name: string } | undefined;
    return Boolean(row);
  }

  function createVectorTable(table: VectorTableConfig, dimensions: number): void {
    db.exec(`
      CREATE VIRTUAL TABLE ${table.tableName} USING vec0(
        ${table.idColumn} TEXT PRIMARY KEY,
        embedding FLOAT[${dimensions}]
      )
    `);
  }

  return {
    isVecLoaded,
    serializeVector,
    deserializeVector,
    detectVectorDimensions,
    upsertMemoryVec,
    deleteMemoryVec,
    searchMemoryVec,
    upsertKbChunkVec,
    deleteKbChunkVec,
    searchKbChunkVec,
  };
}
