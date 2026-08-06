import { useMemo } from 'react';
import type { ContentBlock, Message, PlanStep, SubagentRun } from '@aurevoy/shared';
import type { LiveOutputStore } from '../app/liveOutputStore';
import {
  buildLiveAgentRoundData,
  dedupeContentBlocks,
  type AgentRoundData,
} from './Timeline';
import {
  buildConversationViewModel,
  type ConversationViewModel,
} from './conversationWorkflow';
import {
  buildToolResultMap,
  currentTurnMessages,
  currentTurnSubagentRuns,
  type ToolActivity,
  type ToolResultInfo,
} from './conversationData';

export interface ConversationDerivedView {
  resultMap: Map<string, ToolResultInfo>;
  viewModel: ConversationViewModel<ToolActivity>;
  liveOutputMessages: Message[];
  liveTurnSubagentRuns: SubagentRun[];
  liveRoundData: AgentRoundData | null;
}

/**
 * 集中管理 Conversation 的派生状态；组件本身只消费稳定的视图模型并负责交互/渲染。
 * 高频 outputStore 不参与内容计算，只用来让 live 子树订阅增量正文。
 */
export function useConversationViewModel(params: {
  messages: Message[];
  subagentRuns?: SubagentRun[];
  plan: PlanStep[];
  phase?: string | null;
  output: string;
  outputStore?: LiveOutputStore;
  liveToolActivity: ToolActivity[];
  hasLiveTail: boolean;
  liveContentBlocks: ContentBlock[];
}): ConversationDerivedView {
  const {
    messages,
    subagentRuns = [],
    plan,
    phase,
    output,
    outputStore,
    liveToolActivity,
    hasLiveTail,
    liveContentBlocks,
  } = params;

  const resultMap = useMemo(() => buildToolResultMap(messages), [messages]);
  const viewModel = useMemo(
    () => buildConversationViewModel({
      messages,
      liveToolActivity,
      // outputStore 有独立订阅；父级只需保留兼容旧调用方的直接 output。
      output: outputStore ? '' : output,
      hasLiveTail,
    }),
    [hasLiveTail, liveToolActivity, messages, output, outputStore],
  );
  const liveOutputMessages = useMemo(() => currentTurnMessages(messages), [messages]);
  const liveTurnSubagentRuns = useMemo(
    () => currentTurnSubagentRuns(liveOutputMessages, subagentRuns),
    [liveOutputMessages, subagentRuns],
  );
  const liveOnlyContentBlocks = useMemo(() => {
    const historicalContentBlockIds = new Set(
      messages.flatMap((message) => dedupeContentBlocks(message.contentBlocks).map((block) => block.id)),
    );
    return dedupeContentBlocks(liveContentBlocks).filter(
      (block) => !historicalContentBlockIds.has(block.id),
    );
  }, [liveContentBlocks, messages]);
  const liveRoundData = useMemo(
    () => hasLiveTail
      ? buildLiveAgentRoundData({
          plan,
          liveToolActivity: viewModel.liveToolActivity,
          output: viewModel.liveOutput,
          phase,
          contentBlocks: liveOnlyContentBlocks,
          subagentRuns: liveTurnSubagentRuns,
        })
      : null,
    [hasLiveTail, liveOnlyContentBlocks, liveTurnSubagentRuns, phase, plan, viewModel.liveOutput, viewModel.liveToolActivity],
  );

  return { resultMap, viewModel, liveOutputMessages, liveTurnSubagentRuns, liveRoundData };
}
