import { useMemo } from 'react';
import type { AgentRoundData } from './timelineData';
import {
  flattenProcessActivityRows,
  resolveLiveStatusText,
  type ProcessActivityRow,
} from './timelineProcessData';
import { dedupeContentBlocks } from './timelineData';

export interface TimelineRoundViewModel {
  stepCount: number;
  hasProcess: boolean;
  showDelivery: boolean;
  liveStatusText: string;
  activityRows: ProcessActivityRow[];
  contentBlocks: NonNullable<AgentRoundData['contentBlocks']>;
}

/** Timeline 只消费这一层派生状态；动画和 DOM 结构留在组件中，避免状态计算散落。 */
export function useTimelineRoundViewModel(params: {
  data: AgentRoundData;
  busy: boolean;
  showOutput: boolean;
  phaseDetail?: string;
}): TimelineRoundViewModel {
  const { data, busy, showOutput, phaseDetail } = params;
  return useMemo(() => {
    const stepCount = data.planStepGroups.reduce((count, group) => count + group.steps.length, 0);
    const subagentRuns = data.subagentRuns ?? [];
    const hasProcess = stepCount > 0 || subagentRuns.length > 0;
    const hasRunningTools = data.planStepGroups
      .flatMap((group) => group.steps)
      .some((step) => step.status === 'running' || step.status === 'pending');
    const hasRunningSubagents = subagentRuns.some(
      (run) => run.status === 'running' || run.status === 'queued',
    );
    const suppressBusyDelivery = busy && (hasRunningTools || hasRunningSubagents);
    const showDelivery = showOutput
      && (data.markdownOutput?.trim().length ?? 0) > 0
      && !suppressBusyDelivery;

    return {
      stepCount,
      hasProcess,
      showDelivery,
      liveStatusText: resolveLiveStatusText({ phaseDetail, data }),
      activityRows: flattenProcessActivityRows(data),
      contentBlocks: dedupeContentBlocks(data.contentBlocks),
    };
  }, [busy, data, phaseDetail, showOutput]);
}
