# 记忆系统升级规划：混合检索（关键词 + 向量）+ 知识库 RAG

> 基于 M4/P5 现有记忆系统，按 M8 路线图引入向量检索，实现记忆 + 知识库双通道语义召回。

---

## 一、现状分析

### 现有成果（M4 + P5，已完成）
| 模块 | 状态 |
|---|---|
| SQLite `memories` 表 (CRUD) | ✅ |
| `remember` 工具（Jaccard 去重） | ✅ |
| `scoreMemories()` 关键词评分（目标+最近话题→关键词命中+分类加权+置信度+时间衰减） | ✅ |
| `[[link]]` 引用解析与展开 | ✅ |
| `buildMemorySystemMessage()` 注入 top-20 | ✅ |
| HTTP API (`/api/memories` CRUD) | ✅ |
| 前端 MemoryPanel（列表/新增/编辑/删除/启停） | ✅ |

### 缺失能力
| 能力 | 缺失原因 |
|---|---|
| ✗ 向量语义检索 | 关键词评分无法理解语义相似度（例如"用户喜欢简洁回复"与"偏好短平快风格"不会匹配） |
| ✗ 知识库文件索引 | 无文件分块、索引、语义检索管道 |
| ✗ 混合评分 | 纯关键词，无向量融合权重 |
| ✗ 本地 Embedding 能力 | 无 embedding Provider、无向量存储 |

---

## 二、参考设计

### Claude Code 记忆系统
- **文件式**: CLAUDE.md 层级（Managed → User → Project → Local）+ `memory/` 目录
- **MEMORY.md 索引**: 前 200 行/25KB 加载到上下文，按需展开子文件
- **Auto Memory**: 自动记录有用信息，跨会话持久
- **Dreams 管道**: 空闲时执行 pruning/merging/refreshing
- **局限**: 纯索引 + 关键词，无语义检索

### Cursor/Codex 记忆生态
- **MCP 架构**: 各记忆系统以 MCP Server 形式接入
- **趋势**: 混合检索（BM25 + Vector + Graph），如 PMB 达 94.5% recall@10
- **本地化**: 多数系统采用 sqlite-vec + Ollama embedding

### 本方案差异点
- **不引入 MCP 依赖**: 直接在 Agent 引擎内实现 Embedding Provider + 向量存储
- **延续现有架构**: 复用 LLM Provider 工厂模式，不引入额外服务进程
- **渐进增强**: 不影响现有记忆的 CRUD/注入/前端面板/API 契约

---

## 三、总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent 引擎 (Node.js)                       │
│                                                             │
│  ┌──────────────┐    ┌────────────────────────────────┐     │
│  │   现有记忆系统   │    │        新增：向量引擎             │     │
│  │  (M4/P5)      │    │                                │     │
│  │  memories 表   │    │  sqlite-vec 扩展               │     │
│  │  scoreMemories │◄──►│  vec0 虚拟表 (memory/kb 各一张) │     │
│  │  remember 工具  │    │  MemoryEmbeddingProvider       │     │
│  │  CRUD API      │    │  ── Ollama (本地)              │     │
│  │  MemoryPanel   │    │  ── OpenAI (远程)              │     │
│  └──────┬─────────┘    │  ── @xenova/transformers (降级) │     │
│         │              └────────────────────────────────┘     │
│         │                         │                           │
│         ▼                         ▼                           │
│  ┌─────────────────────────────────────────────────────┐     │
│  │    context.ts: 混合评分 (keyword + vector)           │     │
│  │    score = α * keyword_score + (1-α) * vector_score │     │
│  │    默认 α=0.5, 无 embedding 时纯关键词               │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐     │
│  │    知识库通道 (M8.1 新增)                            │     │
│  │    kb_dirs 表 + kb_chunks 表 + vec0 虚拟表           │     │
│  │    index_files / recall 工具                        │     │
│  │    前端：知识库设置面板 + 来源展示                      │     │
│  └─────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

---

## 四、分步实施

### Step 0：基础设施 — sqlite-vec + Embedding Provider

#### 0.1 安装依赖
```bash
npm install sqlite-vec
# 可选：npm install @xenova/transformers  # 全本地降级
```

#### 0.2 加载扩展
`store/db.ts` 中：
```typescript
import * as sqliteVec from 'sqlite-vec';
sqliteVec.load(db);
// 验证: db.prepare("SELECT vec_version()").get()
```

#### 0.3 Embedding Provider 工厂
新建 `src/embedding/` 目录，复用 LLM Provider 工厂模式：

| 文件 | 职责 |
|---|---|
| `types.ts` | `EmbeddingProvider` 接口 (`embed(text)`, `embedBatch(texts)`, `dimensions`, `model`) |
| `provider.ts` | `getEmbeddingProvider()` / `resetEmbeddingCache()` 工厂 |
| `ollama.ts` | Ollama 本地 embedding (`POST /api/embed`, model: `nomic-embed-text`) |
| `openai.ts` | OpenAI `text-embedding-3-small` API |
| `xenova.ts` | @xenova/transformers 进程内 embedding（无外部依赖，降级用） |

**配置项**（`config.ts` + settings）:
- `embedding.provider`: `'ollama' | 'openai' | 'xenova'`
- `embedding.model`: 各 provider 对应的模型名
- `embedding.baseUrl`: Ollama/OpenAI 的端点
- `embedding.apiKey`: OpenAI key（如有）
- `embedding.dimensions`: 向量维度，默认自动检测

#### 0.4 sqlite-vec 虚拟表
在 `store/db.ts` 中创建 `vec0` 表：
```sql
-- 记忆向量索引
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding FLOAT[768]
);

-- 知识库块向量索引
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunk_vec USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[768]
);
```

---

### Step 1：记忆向量化 — Hybrid Scoring

#### 1.1 memory 表扩展
- `memories` 表新增 `embedding_updated_at` 列（追踪哪些需要重算）
- 迁移脚本：对现有已启用记忆批量生成 embedding（后台低优先级）

#### 1.2 插入/更新时自动 embedding
修改 `memoryStore.create()` 和 `memoryStore.update()`：
1. 调用 `getEmbeddingProvider().embed(content)` 生成向量
2. 写入 `memory_vec` 虚拟表：`INSERT INTO memory_vec(memory_id, embedding) VALUES (?, ?)`
3. 记录 `embedding_updated_at`

#### 1.3 context.ts: 混合评分

新建 `scoreMemoriesHybrid()` 函数，替代原有的 `scoreMemories()`：

```typescript
async function scoreMemoriesHybrid(
  memories: MemoryEntry[],
  goal: string,
  recentTopics: string[],
  options: { alpha?: number } = {}
): Promise<ScoredMemory[]> {
  // 1. 关键词评分（复用现有 extractKeywords + 分类加权 + 置信度 + 时间衰减）
  const keywordScores = scoreMemories(memories, goal, recentTopics);

  // 2. 向量评分（如果有 embedding provider）
  let vectorScores = new Map<string, number>();
  try {
    const provider = getEmbeddingProvider();
    const query = `${goal} ${recentTopics.join(' ')}`.trim();
    if (query) {
      const queryVec = await provider.embed(query);
      // KNN 搜索：使用 MATCH 避免全表扫描（关键性能优化）
      const vecResults = db.prepare(`
        SELECT memory_id, distance 
        FROM memory_vec 
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance
      `).all(serializeVector(queryVec), MAX_INJECTED_MEMORIES * 2);
      for (const row of vecResults) {
        vectorScores.set(row.memory_id, 1 - row.distance);  // 余弦距离→相似度
      }
    }
  } catch {
    // 无 embedding provider → 纯关键词
    return keywordScores;
  }

  // 3. 混合评分
  const alpha = options.alpha ?? 0.5;
  return memories.map(m => {
    const kwScore = keywordScores.find(s => s.entry.id === m.id)?.score ?? 0;
    const vecScore = vectorScores.get(m.id) ?? 0;
    return {
      entry: m,
      score: alpha * kwScore + (1 - alpha) * vecScore
    };
  });
}
```

**性能关键**: 使用 vec0 的 `MATCH` + `k` 参数进行 KNN 搜索，**绝不**使用 `SELECT vec_distance_cosine() ORDER BY ... LIMIT`（后者慢 190×）。

#### 1.4 兼容性保障
- Embedding Provider 未配置 → `getEmbeddingProvider()` 抛错 → `catch` → 静默降级为纯关键词评分
- `memory_vec` 表中无某 memory_id 的记录 → vector_scores 中 count 为 0 → 纯关键词评分
- 配置了 embedding 但向量维度与存储不匹配 → 捕获异常，降级

---

### Step 2：知识库 RAG (M8.1)

#### 2.1 新增数据库表

```typescript
// store/db.ts 新增

// 知识库目录配置
CREATE TABLE IF NOT EXISTS kb_dirs (
  id TEXT PRIMARY KEY,
  dir_path TEXT NOT NULL UNIQUE,
  recursive INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

// 知识库文件索引状态
CREATE TABLE IF NOT EXISTS kb_files (
  id TEXT PRIMARY KEY,
  dir_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,     // SHA256 用于变更检测
  mtime TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT NOT NULL,
  FOREIGN KEY(dir_id) REFERENCES kb_dirs(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_files_path ON kb_files(file_path);

// 知识库块内容
CREATE TABLE IF NOT EXISTS kb_chunks (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  embedding_updated_at TEXT,
  FOREIGN KEY(file_id) REFERENCES kb_files(id) ON DELETE CASCADE
);

// 知识库块向量（sqlite-vec 虚拟表）
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunk_vec USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[768]
);
```

#### 2.2 文本分块策略

新建 `src/knowledge-base/chunker.ts`：
- 按 `\n\n` 段落分割，合并到 ~512 字符/块（可配置）
- 支持扩展名过滤器（`.ts`, `.js`, `.md`, `.txt` 等）
- 保留文件路径 + 行号范围元数据
- 最大文件大小限制（默认 1MB，可配置）

#### 2.3 新工具

**`index_files` 工具**（`safe` 风险）:
```
参数: { dirs?: string[], filePatterns?: string[], force?: boolean }
行为:
  - 遍历指定目录（默认使用已配置的 kb_dirs）
  - 计算文件 hash/mtime → 跳过未变更的
  - 对新增/变更文件: 分块 → embedding → 写入 kb_chunks + kb_chunk_vec
  - 对删除的文件: 清理对应 chunk 和向量
  - 返回: { indexed: number, skipped: number, removed: number, totalChunks: number }
```

**`recall` 工具**（`safe` 风险）:
```
参数: { query: string, topK?: number, dirs?: string[] }
行为:
  - 用 embedding provider 生成 query 向量
  - KNN 搜索 kb_chunk_vec，取 top-K
  - 返回: [{ file, snippet, score, chunkIndex }]
```

#### 2.4 设置/KB 配置 API

模仿现有 settings 模式：
```
GET  /api/knowledge-base/dirs        → 列出已配置目录
POST /api/knowledge-base/dirs        → 添加索引目录
DELETE /api/knowledge-base/dirs/:id  → 删除目录（同时清理索引）
GET  /api/knowledge-base/status      → 索引状态统计
POST /api/knowledge-base/reindex     → 手动触发重新索引
```

#### 2.5 上下文注入集成

在 `loop.ts` 中，在 memory 消息之后追加 KB 上下文（仅在 recall 工具有结果时）：
```
[envContextMessage, modeMessage, memoryMessage, kbContextMessage?, skillCatalogMessage, ...conversationMessages]
```

KB 上下文为以下之一：
- 用户显式调用了 `recall` 工具 → 结果已经融入对话，不需要额外注入
- Agent 自动触发（P5 风格）: 对当前目标做一次隐式 recall，结果压缩后注入

---

### Step 3：前端增强

#### 3.1 知识库设置面板
- 新增 `/settings/knowledge-base` 页面
- 目录列表（添加/删除/刷新按钮）
- 索引状态（已索引文件数、chunk 数、最后索引时间）
- 全局开关（启用/禁用 KB）

#### 3.2 MemoryPanel 增强
- 每条记忆显示是否已向量化（小徽章）
- 显示混合评分时的向量相似度贡献
- 现有功能完全保留，向后兼容

#### 3.3 任务结果中 KB 来源展示
- recall 工具的响应渲染为带来源标注的卡片
- 显示文件路径、片段预览、置信度

---

## 五、关键性能原则

### sqlite-vec 使用铁律
1. **必须用 `MATCH` + `k` 进行 KNN 搜索**
   ```sql
   -- ✅ 正确：~45ms (10K vectors)
   SELECT v.memory_id, v.distance
   FROM memory_vec v
   WHERE v.embedding MATCH ? AND k = 40
   ORDER BY v.distance
   
   -- ❌ 错误：~8,490ms (全表扫描)
   SELECT memory_id, vec_distance_cosine(embedding, ?) AS distance
   FROM memory_vec
   ORDER BY distance LIMIT 10
   ```
2. **维度一致性**: 创建虚拟表时指定维度必须与 embedding provider 输出一致
3. **批量插入**: 单条 `INSERT INTO vec0 VALUES` 是正常模式，不需要批量优化（better-sqlite3 同步 API 够快）

### Embedding 生成策略
| 场景 | 策略 |
|---|---|
| 首次启动 + 已有 N 条记忆 | 后台逐批生成，每批 5 条，间隔 100ms，不阻塞 Agent 循环 |
| 用户/Agent 新增记忆 | 同步生成（~50ms per 调用，可接受） |
| 知识库全量索引 | 批量 10 条并发，控制 Ollama 负载 |
| Embedding Provider 不可用 | 静默降级，记忆/知识库功能不受影响 |

### 降级路径
```
Embedding Provider 配置成功 → 混合评分 + 语义 KB
Embedding Provider 配置失败 → 纯关键词评分（现有行为）
sqlite-vec 加载失败        → 纯关键词评分（记录 warn 日志）
Ollama 未运行              → 检测到 1s 超时，标记不可用，降级
```

---

## 六、向后兼容

| 变更点 | 兼容策略 |
|---|---|
| 新增 `memory_vec` 表 | 不存在时查询返回空数组 → 降级纯关键词 |
| 新增 embedding provider 配置 | 未配置时 `getEmbeddingProvider()` 抛错 → 调用方 catch |
| 新增 memory 表列 | 列不存在时 migration 自动 ADD COLUMN（现有模式） |
| 新增 KB 表 | 与现有表独立，不影响已有功能 |
| context.ts 评分函数 | 新增 `scoreMemoriesHybrid`，不修改现有 `scoreMemories` 签名 |
| MemoryPanel 前端 | 新增徽章不可见时不影响现有渲染 |
| API 类型 | 新增 `RuntimeSettings` 字段可选；新增 KB API 独立路径 |

---

## 七、测试计划

### 单元测试/回归
```
scripts/m8-regression.mjs (新增):
  - caseMemoryVectorSearch: 创建两条记忆→验证向量检索 top-1
  - caseMemoryHybridScoring: 关键词+向量混合评分验证
  - caseEmbeddingFallback: 无embedding provider时降级
  - caseKbIndexAndRecall: 索引文件→验证recall结果
  - caseKbReindexOnChange: 文件变更→重新索引
  - caseKbCleanOnDirDelete: 删除目录→清理chunk和向量
```

### M4 回归不受影响
```
npm run regression:m4   # 应全部通过（兼容性保障）
```

---

## 八、实施顺序（按依赖关系）

```
Step 0.1  安装 sqlite-vec 依赖
Step 0.2  加载扩展 + 创建 vec0 虚拟表
Step 0.3  创建 Embedding Provider 工厂 (types, provider, ollama)
Step 0.4  集成 OpenAI embedding + @xenova 降级

Step 1.1  memory 表 extension: embedding_updated_at
Step 1.2  memory_store: 插入/更新时同步生成 embedding
Step 1.3  context.ts: scoreMemoriesHybrid 混合评分
Step 1.4  config: embedding 配置项

Step 2.1  KB 数据库表 (kb_dirs, kb_files, kb_chunks, kb_chunk_vec)
Step 2.2  文本分块器 (knowledge-base/chunker.ts)
Step 2.3  index_files 工具
Step 2.4  recall 工具
Step 2.5  KB API 端点
Step 2.6  KB 上下文注入集成

Step 3.1  前端 KB 设置面板
Step 3.2  MemoryPanel 增强（向量化状态）
Step 3.3  KB 来源展示组件

Step 4    回归测试 + 文档
```

---

## 九、风险与缓解

| 风险 | 缓解 |
|---|---|
| sqlite-vec 是 alpha 版本 | 评估：已广泛使用在多个生产项目中；0.1.x API 已稳定 |
| Ollama 用户不一定有 | 支持多个 Provider：Ollama / OpenAI / @xenova；未配置则降级 |
| 向量检索增加首次启动延迟 | 后台分批产生 embedding，不阻塞 Agent 循环 |
| better-sqlite3 原生模块需重编 | 已在 CI/CD 中验证 `npm rebuild`，Windows 有自动重编 |
