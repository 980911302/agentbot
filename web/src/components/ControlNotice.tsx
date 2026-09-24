import { useState } from 'react';
import { IconInfo } from '../icons';
import { resumeAgent, retryAgentMail } from '../api';
import { toast } from './ui/Toast.js';
import { resumeOutcomeMessage, retryOutcomeMessage } from '../features/chat/control-view.js';
import { controlNoticeState, type ControlAction, type ControlNoticeInput } from '../features/chat/control-view.js';

export interface ControlNoticeProps {
  /** 当前智能体（1:1）；群没有单智能体许可态，不显示 */
  agentId: string | null;
  input: ControlNoticeInput;
  /** 操作成功后让父组件刷新数据 */
  onChanged?: () => void;
}

/**
 * 控制状态条（UI 设计规范 5.8 / §6）：时间线底部、输入条上方，
 * 宽度同阅读列。告知「停止中 / 已暂停 / 来信失败」等真实控制状态，
 * 并给出「恢复自动处理」「重试失败来信」两个入口；成功失败都用 Toast 反馈。
 *
 * 不修改后端暂停/许可语义，只读 + 调用既有 resume/retry 接口。
 */
export function ControlNotice({ agentId, input, onChanged }: ControlNoticeProps) {
  const [pending, setPending] = useState<ControlAction | null>(null);
  const state = controlNoticeState(input);
  if (!state || !agentId) return null;

  const run = async (action: ControlAction) => {
    setPending(action);
    try {
      if (action === 'resume') {
        await resumeAgent(agentId);
        toast(resumeOutcomeMessage(true));
      } else {
        const retried = await retryAgentMail(agentId);
        toast(retryOutcomeMessage(true, retried));
      }
      onChanged?.();
    } catch {
      toast(action === 'resume' ? resumeOutcomeMessage(false) : retryOutcomeMessage(false, 0));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className={`control-notice ${state.kind}`} role="status">
      <span className="control-notice-icon" aria-hidden="true">
        <IconInfo size={15} />
      </span>
      <span className="control-notice-text">{state.detail}</span>
      {state.actions.includes('resume') ? (
        <button
          type="button"
          className="btn primary sm"
          disabled={pending !== null}
          onClick={() => void run('resume')}
        >
          {pending === 'resume' ? '处理中…' : '恢复自动处理'}
        </button>
      ) : null}
      {state.actions.includes('retry') ? (
        <button
          type="button"
          className="btn ghost sm"
          disabled={pending !== null}
          onClick={() => void run('retry')}
        >
          {pending === 'retry' ? '处理中…' : '重试失败来信'}
        </button>
      ) : null}
    </div>
  );
}
