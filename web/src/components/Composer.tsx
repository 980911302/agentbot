import { useCallback, useEffect, useRef, useState } from 'react';
import { useClickOutside } from '../hooks';
import { IconArrowUp, IconCheck, IconMic, IconPlus, IconTool } from '../icons';
import { BotAvatar } from './BotAvatar';
import type { ModelOption, ToolInfo } from '../types';

export interface ChannelMemberItem {
  id: string;
  name: string;
  color: string;
}

interface ComposerProps {
  busy: boolean;
  botName: string;
  model: string;
  models: ModelOption[];
  tools: ToolInfo[];
  isGroup?: boolean;
  members?: ChannelMemberItem[];
  onSend: (text: string) => void;
  onModelChange: (model: string) => void;
}

export function Composer({
  busy,
  botName,
  model,
  models,
  tools,
  isGroup = false,
  members = [],
  onSend,
  onModelChange,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [plusOpen, setPlusOpen] = useState(false);
  const [voiceToast, setVoiceToast] = useState(false);

  // Mention State
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionPos, setMentionPos] = useState<number>(-1);

  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  const closePlus = useCallback(() => setPlusOpen(false), []);
  const plusRef = useClickOutside<HTMLDivElement>(plusOpen, closePlus);

  const mentionCandidates = members.filter((m) =>
    mentionQuery ? m.name.toLowerCase().includes(mentionQuery.toLowerCase()) : true,
  );

  const resize = () => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, 140)}px`;
  };

  const handleVoiceClick = () => {
    setVoiceToast(true);
    window.setTimeout(() => setVoiceToast(false), 2000);
  };

  const insertMention = (member: ChannelMemberItem) => {
    const area = areaRef.current;
    if (!area || mentionPos === -1) return;
    const before = value.slice(0, mentionPos);
    const after = value.slice(area.selectionStart);
    const nextVal = `${before}@${member.name} ${after}`;
    setValue(nextVal);
    setMentionOpen(false);
    setMentionPos(-1);
    setMentionQuery('');

    window.requestAnimationFrame(() => {
      area.focus();
      const newCursor = before.length + member.name.length + 2;
      area.setSelectionRange(newCursor, newCursor);
      resize();
    });
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    const cursor = e.target.selectionStart;
    setValue(text);
    resize();

    // Check if cursor is right after an '@' or typing a mention name
    const textBeforeCursor = text.slice(0, cursor);
    const match = textBeforeCursor.match(/@([^@\s]*)$/);

    if (match && members.length > 0) {
      setMentionOpen(true);
      setMentionPos(cursor - match[0].length);
      setMentionQuery(match[1] ?? '');
      setMentionIndex(0);
    } else {
      setMentionOpen(false);
      setMentionPos(-1);
      setMentionQuery('');
    }
  };

  const submit = () => {
    const text = value.trim();
    // 忙也照发：新句插队开新回合（《停止与插话.md》§6）
    if (!text) return;
    onSend(text);
    setValue('');
    setMentionOpen(false);
    window.requestAnimationFrame(resize);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen && mentionCandidates.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex((prev) => (prev + 1) % mentionCandidates.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex((prev) => (prev - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const candidate = mentionCandidates[mentionIndex];
        if (candidate) {
          insertMention(candidate);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionOpen(false);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const placeholder = isGroup
    ? '在群聊中发消息，输入 @ 唤醒指定成员… (Enter 发送)'
    : `问问 ${botName}… (Enter 发送，Shift+Enter 换行)`;

  return (
    <div className="composer-capsule-wrapper">
      {voiceToast ? (
        <div className="composer-voice-toast">语音输入功能适配中，请使用键盘输入</div>
      ) : null}

      {/* Mention Auto-complete Popover */}
      {mentionOpen && mentionCandidates.length > 0 ? (
        <div className="composer-mention-popover">
          <div className="mention-header">选择要 @ 的成员 ({mentionCandidates.length})</div>
          <div className="mention-list">
            {mentionCandidates.map((member, idx) => (
              <button
                type="button"
                key={member.id}
                className={`mention-item${idx === mentionIndex ? ' selected' : ''}`}
                onMouseEnter={() => setMentionIndex(idx)}
                onClick={() => insertMention(member)}
              >
                <BotAvatar name={member.name} color={member.color} size={22} />
                <span className="mention-name">{member.name}</span>
                <span className="mention-tag">@唤醒</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="composer-capsule">
        {/* Left Circular + Button */}
        <div ref={plusRef} className="capsule-slot">
          <button
            type="button"
            className={`capsule-plus-btn${plusOpen ? ' active' : ''}`}
            aria-label="操作与工具"
            title="选择模型与查看工具"
            onClick={() => setPlusOpen((open) => !open)}
          >
            <IconPlus size={16} />
          </button>

          {plusOpen ? (
            <div className="menu up left capsule-menu">
              <div className="menu-label">当前模型</div>
              <div className="capsule-model-selector">
                {models.map((option) => (
                  <button
                    type="button"
                    key={option.id}
                    className={`menu-row${option.id === model ? ' selected' : ''}`}
                    onClick={() => {
                      onModelChange(option.id);
                      setPlusOpen(false);
                    }}
                  >
                    <span className="menu-row-icon">
                      {option.id === model ? <IconCheck size={14} /> : null}
                    </span>
                    <span className="menu-row-text">
                      <span className="menu-row-title">{option.label}</span>
                      <span className="menu-row-hint">{option.hint}</span>
                    </span>
                  </button>
                ))}
              </div>

              <div className="menu-divider" />
              <div className="menu-label">可用工具 ({tools.length})</div>
              <div className="capsule-tools-list">
                {tools.map((tool) => (
                  <div className="menu-row read-only" key={tool.name}>
                    <span className="menu-row-icon">
                      <IconTool size={14} />
                    </span>
                    <span className="menu-row-text">
                      <span className="menu-row-title">{tool.name}</span>
                      <span className="menu-row-hint">{tool.description}</span>
                    </span>
                    <span className="menu-row-icon dim">
                      <IconCheck size={13} />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {/* Center Input Field */}
        <textarea
          ref={areaRef}
          className="capsule-input"
          rows={1}
          value={value}
          placeholder={placeholder}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
        />

        {/* Right: Send / Mic——界面不做停止入口；打「停」走停止令全链（《停止与插话.md》§9） */}
        {value.trim() || busy ? (
          <button
            type="button"
            className="capsule-action-btn send"
            aria-label={busy ? '插队发送' : '发送消息'}
            title={busy ? '它正忙着——新句会插队开新回合' : '发送 (Enter)'}
            onClick={submit}
          >
            <IconArrowUp size={18} />
          </button>
        ) : (
          <button
            type="button"
            className="capsule-action-btn mic"
            aria-label="语音输入"
            title="语音输入"
            onClick={handleVoiceClick}
          >
            <IconMic size={18} />
          </button>
        )}
      </div>
    </div>
  );
}


