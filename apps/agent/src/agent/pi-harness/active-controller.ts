import type { AgentHarness, ThinkingLevel as PiThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ImageContent as PiImageContent, Model as PiModel } from '@earendil-works/pi-ai/compat';
import type { Message } from '@aurevoy/shared';

interface HarnessInput {
  text: string;
  images: PiImageContent[];
}

type ConvertQueuedMessage = (message: Message) => Promise<HarnessInput>;

interface HarnessQueueAdapter {
  steerQueue?: unknown[];
  followUpQueue?: unknown[];
  emitQueueUpdate?: () => Promise<void>;
}

/**
 * 单个活动 run 的内存控制器。
 *
 * 它只负责取消和 Pi steering/follow-up 队列投递；消息格式转换由 runtime
 * 注入，避免该控制器依赖模型选择、附件读取等业务逻辑。
 */
export class ActivePiTaskController {
  private harness?: AgentHarness;
  private pendingSteering: Message[] = [];
  private pendingFollowUp: Message[] = [];

  constructor(private readonly convertMessage: ConvertQueuedMessage) {}

  attach(harness: AgentHarness): void {
    this.harness = harness;
    const steering = this.pendingSteering.splice(0);
    const followUps = this.pendingFollowUp.splice(0);
    for (const message of steering) this.enqueueSteering(message);
    for (const message of followUps) this.enqueueFollowUp(message);
  }

  abort(): void {
    void this.harness?.abort();
  }

  /** 运行中即时换模型；harness.setModel 会触发 model_update own-event 回写快照。 */
  async setModel(model: PiModel<any>): Promise<boolean> {
    if (!this.harness) return false;
    try {
      await this.harness.setModel(model);
      return true;
    } catch {
      return false;
    }
  }

  /** 运行中即时换推理档；触发 thinking_level_update own-event 回写快照。 */
  async setThinkingLevel(level: PiThinkingLevel): Promise<boolean> {
    if (!this.harness) return false;
    try {
      await this.harness.setThinkingLevel(level);
      return true;
    } catch {
      return false;
    }
  }

  enqueueSteering(message: Message): Promise<boolean> {
    if (!this.harness) {
      // harness 尚未 attach（run 刚启动）：先入缓冲队列，attach 时统一投递，视为已受理。
      this.pendingSteering.push(message);
      return Promise.resolve(true);
    }
    return this.deliverQueuedMessage('steer', message);
  }

  enqueueFollowUp(message: Message): Promise<boolean> {
    if (!this.harness) {
      this.pendingFollowUp.push(message);
      return Promise.resolve(true);
    }
    return this.deliverQueuedMessage('followUp', message);
  }

  /**
   * 撤回尚未注入模型上下文的排队消息。
   *
   * Pi 0.82.1 的 AgentHarness 暂未公开 clear queue 方法，但内部队列和
   * queue_update 事件是稳定运行契约。这里把版本耦合收口在单一适配点；
   * 若上游后续公开 API，只需替换此函数。
   */
  async clearQueue(kind: 'steering' | 'follow_up' | 'all'): Promise<boolean> {
    if (kind === 'steering' || kind === 'all') this.pendingSteering = [];
    if (kind === 'follow_up' || kind === 'all') this.pendingFollowUp = [];
    if (!this.harness) return true;

    const adapter = this.harness as unknown as HarnessQueueAdapter;
    if (
      (kind === 'steering' || kind === 'all') &&
      !Array.isArray(adapter.steerQueue)
    ) return false;
    if (
      (kind === 'follow_up' || kind === 'all') &&
      !Array.isArray(adapter.followUpQueue)
    ) return false;

    if (kind === 'steering' || kind === 'all') adapter.steerQueue!.splice(0);
    if (kind === 'follow_up' || kind === 'all') adapter.followUpQueue!.splice(0);
    await adapter.emitQueueUpdate?.();
    return true;
  }

  /** 实际投递到 harness；返回是否被接受。失败不抛出，由调用方决定是否向用户报错。 */
  private async deliverQueuedMessage(kind: 'steer' | 'followUp', message: Message): Promise<boolean> {
    if (!this.harness) return false;
    const input = await this.convertMessage(message);
    try {
      const options = input.images.length > 0 ? { images: input.images } : undefined;
      if (kind === 'steer') {
        await this.harness.steer(input.text, options);
      } else {
        await this.harness.followUp(input.text, options);
      }
      return true;
    } catch {
      // run 已结束或正在收敛时投递失败；由调用方据此向用户返回失败，而不是虚假成功。
      return false;
    }
  }
}
