import { Schema } from 'effect';
import { make } from '../../framework/definition.js';

export const runDreamsTool = make({
  name: 'run_dreams',
  description: '执行记忆后台维护：补全向量索引、合并重复记忆、自动禁用低置信度记忆。通常在任务结束后自动触发，也可手动调用查看维护报告。',
  riskLevel: 'safe',
  executionPolicy: { parallelizable: false },
  input: Schema.Struct({
    backfillEmbeddings: Schema.optional(Schema.Boolean),
    dedupMerge: Schema.optional(Schema.Boolean),
    lowConfidenceSweep: Schema.optional(Schema.Boolean),
  }),
  output: Schema.Unknown,
  execute: async (input) => {
    const { runDreams } = await import('../../../memory/dreams.js');
    const report = await runDreams({
      backfillEmbeddings: input.backfillEmbeddings !== false,
      dedupMerge: input.dedupMerge !== false,
      lowConfidenceSweep: input.lowConfidenceSweep !== false,
    });
    return {
      ...report,
      note: report.errors.length > 0
        ? `维护完成（${report.durationMs}ms），${report.errors.length} 个错误`
        : `维护完成（${report.durationMs}ms），无错误`,
    };
  },
});
