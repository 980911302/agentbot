import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconClose } from '../icons';
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
  const [submitted, setSubmitted] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (request.kind === 'secret') inputRef.current?.focus();
  }, [request.kind, request.id]);

  // 倒计时：让用户知道这张卡片会过期
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const left = secondsLeft(request.expiresAt, now);
  const expired = left <= 0;

  const submit = (answer: { value?: string; secret?: string; cancelled?: boolean }) => {
    if (submitted) return;
    setSubmitted(true);
    onAnswer(answer);
  };

  return (
    <div className={`interaction-card swap${request.kind === 'secret' ? ' secret' : ''}${expired ? ' expired' : ''}`}>
      <div className="interaction-head">
        <span className="interaction-agent">{request.agentName}</span>
        <span className="interaction-kind">{request.kind === 'secret' ? '密钥' : '需要你确认'}</span>
        <span className="interaction-timer">{expired ? '已超时' : `${left}s`}</span>
      </div>

      <p className="interaction-question">{request.question}</p>
      {request.detail ? <p className="interaction-detail">{request.detail}</p> : null}

      {request.kind === 'choice' ? (
        <>
          <div className="interaction-options">
            {(request.options ?? []).map((option) => (
              <button
                type="button"
                key={option.id}
                className="interaction-option"
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
              className="btn primary small"
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
            className="btn primary small"
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
