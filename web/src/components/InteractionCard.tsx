import { useEffect, useRef, useState } from 'react';
import { IconAlert, IconCheck, IconClose } from '../icons';
import { answeredLabel, formatCountdown, type InteractionAnswer } from '../features/chat/interaction-view';
import type { InteractionRequest } from '../types';

interface InteractionCardProps {
  request: InteractionRequest;
  onAnswer: (answer: { value?: string; secret?: string; cancelled?: boolean }) => void;
}

function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/**
 * 交互卡片。
 *
 * 参见 docs/工具参考.md：让用户点一下，而不是打字。
 * 密钥类输入走遮罩框——值只在提交时发一次，不回显、不进对话。
 */
export function InteractionCard({ request, onAnswer }: InteractionCardProps) {
  const [freeText, setFreeText] = useState('');
  const [secret, setSecret] = useState('');
  /** 提交了什么：非空即已提交，卡片据此停表、锁定并回显所选项 */
  const [answer, setAnswer] = useState<InteractionAnswer | null>(null);
  const submitted = answer !== null;
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (request.kind === 'secret') inputRef.current?.focus();
  }, [request.kind, request.id]);

  const left = secondsLeft(request.expiresAt, now);
  const expired = left <= 0;

  // 倒计时：让用户知道这张卡片会过期；提交后或已超时就停表
  useEffect(() => {
    if (submitted || expired) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [submitted, expired]);

  const submit = (next: InteractionAnswer) => {
    if (submitted) return;
    setAnswer(next);
    onAnswer(next);
  };

  return (
    <div className={`interaction-card swap${request.kind === 'secret' ? ' secret' : ''}${expired ? ' expired' : ''}`}>
      <div className="interaction-head">
        <span className="interaction-agent">{request.agentName}</span>
        <span className="interaction-kind">{request.kind === 'secret' ? '密钥' : '需要你确认'}</span>
        <span className="interaction-timer" title={submitted || expired ? undefined : '剩余时间'}>
          {submitted ? '已提交' : expired ? '已超时' : formatCountdown(left)}
        </span>
      </div>

      <p className="interaction-question">{request.question}</p>
      {request.detail ? <p className="interaction-detail">{request.detail}</p> : null}

      {expired && !submitted ? (
        <div className="interaction-expired-banner">
          <IconAlert size={14} aria-hidden="true" />
          <span>该确认请求已超时，智能体已按预设逻辑继续或挂起</span>
        </div>
      ) : null}

      {answer ? (
        <p className="interaction-answered" role="status">
          <IconCheck size={14} aria-hidden="true" />
          {answeredLabel(answer, request.options ?? [])}
        </p>
      ) : null}

      {request.kind === 'choice' ? (
        <>
          <div className="interaction-options">
            {(request.options ?? []).map((option) => (
              <button
                type="button"
                key={option.id}
                className={`interaction-option${answer?.value === option.id ? ' selected' : ''}`}
                aria-pressed={answer ? answer.value === option.id : undefined}
                disabled={expired || submitted}
                onClick={() => submit({ value: option.id })}
              >
                <span className="interaction-option-label">{option.label}</span>
                {option.description ? (
                  <span className="interaction-option-desc">{option.description}</span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="interaction-other">
            <input
              value={freeText}
              placeholder="或者自己填一个…"
              disabled={expired || submitted}
              onChange={(event) => setFreeText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && freeText.trim()) {
                  submit({ value: `自定义：${freeText.trim()}` });
                }
              }}
            />
            <button
              type="button"
              className="btn primary sm"
              disabled={expired || submitted || !freeText.trim()}
              onClick={() => submit({ value: `自定义：${freeText.trim()}` })}
            >
              确定
            </button>
          </div>
        </>
      ) : (
        <div className="interaction-other">
          <input
            ref={inputRef}
            type="password"
            value={secret}
            placeholder={`粘贴「${request.name ?? '密钥'}」，不会进对话`}
            disabled={expired || submitted}
            autoComplete="off"
            onChange={(event) => setSecret(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && secret.trim()) submit({ secret: secret.trim() });
            }}
          />
          <button
            type="button"
            className="btn primary sm"
            disabled={expired || submitted || !secret.trim()}
            onClick={() => submit({ secret: secret.trim() })}
          >
            <IconCheck size={14} />
          </button>
        </div>
      )}

      <div className="interaction-foot">
        <span className="interaction-hint">
          {request.kind === 'secret'
            ? '值只保存在本机，不会出现在对话或记忆里'
            : '选一个，或自己填'}
        </span>
        <button
          type="button"
          className="interaction-cancel"
          disabled={submitted}
          onClick={() => submit({ cancelled: true })}
        >
          <IconClose size={13} />
          跳过
        </button>
      </div>
    </div>
  );
}
