import type {
  DataStatusResponse,
  HealthDiagnosticCheck,
  HealthDiagnosticsResponse,
  LlmReadiness,
} from '@aurevoy/shared';

export interface HealthDiagnosticProbe {
  status: HealthDiagnosticCheck['status'];
  summary: string;
  details?: HealthDiagnosticCheck['details'];
}

export interface BuildHealthDiagnosticsInput {
  generatedAt: string;
  version: string;
  uptimeMs: number;
  llm: LlmReadiness;
  data: DataStatusResponse;
  database: HealthDiagnosticProbe;
  workspace: HealthDiagnosticProbe;
  embedding: HealthDiagnosticProbe;
  vectorStore: HealthDiagnosticProbe;
  knowledgeBase: HealthDiagnosticProbe;
}

/**
 * 统一诊断项顺序和协议投影，具体探测由 server 注入，便于单测不必启动 Fastify。
 */
export function buildHealthDiagnostics(
  input: BuildHealthDiagnosticsInput,
): HealthDiagnosticsResponse {
  return {
    generatedAt: input.generatedAt,
    version: input.version,
    uptimeMs: input.uptimeMs,
    checks: [
      { id: 'llm', ...buildLlmProbe(input.llm) },
      { id: 'database', ...input.database },
      { id: 'workspace', ...input.workspace },
      { id: 'embedding', ...input.embedding },
      { id: 'vector_store', ...input.vectorStore },
      { id: 'knowledge_base', ...input.knowledgeBase },
    ],
    data: input.data,
  };
}

function buildLlmProbe(llm: LlmReadiness): HealthDiagnosticProbe {
  if (llm.ready) {
    return {
      status: 'ok',
      summary: 'LLM provider is ready',
      details: { state: llm.state, provider: llm.provider, model: llm.model },
    };
  }
  return {
    status: 'warning',
    summary: `LLM is not ready: ${llm.state}`,
    details: { state: llm.state, provider: llm.provider, model: llm.model },
  };
}
