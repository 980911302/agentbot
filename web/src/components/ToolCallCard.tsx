import { useState } from 'react';
import { Collapsible } from '../motion';
import { IconChevronRight, IconTool } from '../icons';
import { formatToolDuration } from '../features/chat/tool-call-view';
import type { ToolCallView } from '../types';

function prettyArguments(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function ToolCallCard({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyResult = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  const statusLabel =
    call.status === 'running'
      ? '执行中…'
      : call.status === 'error'
        ? '调用失败'
        : '完成';

  return (
    <div className={`tool-card-item ${call.status}`}>
      <button
        type="button"
        className="tool-card-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {/* 状态只由右侧徽标表达；外层「执行过程」摘要已有汇总状态点，这里不再重复画点 */}
        <div className="tool-card-left">
          <IconTool size={13} className="tool-card-icon" />
          <span className="tool-card-name">{call.name}</span>
        </div>

        <div className="tool-card-right">
          <span className={`tool-card-badge ${call.status}`}>
            {statusLabel}
            {formatToolDuration(call.durationMs) ? ` · ${formatToolDuration(call.durationMs)}` : ''}
          </span>
          <span className={`tool-card-chev${open ? ' open' : ''}`}>
            <IconChevronRight size={13} />
          </span>
        </div>
      </button>

      <Collapsible open={open}>
        <div className="tool-card-body">
          {call.arguments ? (
            <div className="tool-card-section">
              <div className="tool-section-label">入参</div>
              <pre className="tool-code-pre">{prettyArguments(call.arguments)}</pre>
            </div>
          ) : null}

          {call.result !== undefined ? (
            <div className="tool-card-section">
              <div className="tool-section-header">
                <span className="tool-section-label">输出结果</span>
                <button
                  type="button"
                  className={`tool-copy-btn${copied ? ' copied' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    copyResult(call.result ?? '');
                  }}
                  title="复制结果"
                >
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
              <pre className={`tool-code-pre out${call.status === 'error' ? ' error' : ''}`}>
                {call.result}
              </pre>
            </div>
          ) : null}
        </div>
      </Collapsible>
    </div>
  );
}

