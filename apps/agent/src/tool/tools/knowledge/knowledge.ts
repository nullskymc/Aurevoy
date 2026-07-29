import { Schema } from 'effect';
import { make } from '../../framework/definition.js';

export const indexFilesTool = make({
  name: 'index_files',
  description: '索引指定目录中的代码/文档文件到知识库，支持语义搜索。对新增/变更文件做分块 + 向量化，已删除文件自动清理。需要先配置 embedding provider。',
  riskLevel: 'safe',
  executionPolicy: { parallelizable: false },
  input: Schema.Struct({ dirs: Schema.optional(Schema.Array(Schema.String)), force: Schema.optional(Schema.Boolean) }),
  output: Schema.Struct({ indexed: Schema.Number, totalChunks: Schema.Number, removed: Schema.Number, details: Schema.Unknown, note: Schema.String }),
  execute: async (input) => {
    const { indexKbDirs } = await import('../../../knowledge-base/index.js');
    const results = await indexKbDirs(input.dirs ? [...input.dirs] : undefined, input.force === true);
    const indexed = results.reduce((sum, result) => sum + result.indexed, 0);
    const totalChunks = results.reduce((sum, result) => sum + result.totalChunks, 0);
    const removed = results.reduce((sum, result) => sum + result.removed, 0);
    return { indexed, totalChunks, removed, details: results, note: indexed > 0 ? `已索引 ${indexed} 个文件（${totalChunks} 个文本块）` : '无变更，全部跳过' };
  },
});

export const recallTool = make({
  name: 'recall',
  description: '从知识库中语义搜索与当前任务相关的文件片段（不是长期记忆——记忆会自动注入上下文）。使用向量相似度匹配，需要先配置 embedding provider 并索引文件。返回结果包含文件路径、内容片段和相关度评分。',
  riskLevel: 'safe',
  input: Schema.Struct({ query: Schema.String, topK: Schema.optional(Schema.Number) }),
  output: Schema.Struct({ found: Schema.Number, results: Schema.Array(Schema.Struct({ file: Schema.String, snippet: Schema.String, score: Schema.Number })), citations: Schema.Unknown, note: Schema.String }),
  execute: async (input) => {
    const query = input.query.trim();
    if (!query) throw new Error('query 不能为空');
    const topK = input.topK && input.topK > 0 ? Math.min(input.topK, 20) : 5;
    const { recallKb } = await import('../../../knowledge-base/index.js');
    const { results, citations } = await recallKb(query, topK);
    if (results.length === 0) return { found: 0, results: [], citations: [], note: '未找到匹配结果。请先添加知识库目录并通过 index_files 工具索引文件，或检查 embedding provider 配置。' };
    return {
      found: results.length,
      results: results.map((result) => ({ file: result.filePath, snippet: result.content, score: Math.round(result.score * 100) / 100 })),
      citations,
      note: `找到 ${results.length} 个相关片段`,
    };
  },
});
