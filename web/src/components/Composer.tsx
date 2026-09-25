import { useCallback, useEffect, useRef, useState } from 'react';
import { useClickOutside } from '../hooks';
import { IconArrowUp, IconCheck, IconChevronDown, IconMic, IconPlus, IconTool } from '../icons';
import { BotAvatar } from './BotAvatar';
import { mentionCandidateList } from '../features/chat/ui-chrome';
import { composerAreaSize, composerPlaceholder } from '../features/chat/composer-view';
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
  onModelChange: (model: string, option?: ModelOption) => void;
  onManageModels?: () => void;
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
  onManageModels,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [plusOpen, setPlusOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [voiceToast, setVoiceToast] = useState(false);

  // Mention State
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionPos, setMentionPos] = useState<number>(-1);

  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  const closePlus = useCallback(() => setPlusOpen(false), []);
  const closeModel = useCallback(() => setModelOpen(false), []);
  const plusRef = useClickOutside<HTMLDivElement>(plusOpen, closePlus);
  const modelRef = useClickOutside<HTMLDivElement>(modelOpen, closeModel);

  const currentModel = models.find((option) => option.id === model);
  const currentLabel = currentModel?.label || model || '选择模型';

  const mentionCandidates = isGroup ? mentionCandidateList(members, mentionQuery) : [];

  // 高度按行数算（1~8 行，超出内部滚动），常量在 features/chat/composer-view.ts
  const resize = () => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = 'auto';
    const { height } = composerAreaSize(area.scrollHeight);
    area.style.height = `${height}px`;
  };

  useEffect(() => {
    const onUsePrompt = (event: Event) => {
      const customEvent = event as CustomEvent<string>;
      if (typeof customEvent.detail === 'string') {
        setValue(customEvent.detail);
        window.requestAnimationFrame(() => {
          resize();
          areaRef.current?.focus();
        });
      }
    };
    window.addEventListener('agentbot:use_prompt', onUsePrompt);
    return () => window.removeEventListener('agentbot:use_prompt', onUsePrompt);
  }, []);

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

    if (match && isGroup) {
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
    // 忙也照发：新句插队开新回合（见 docs/架构设计.md「插话、停止和等待」）
    if (!text) return;
    onSend(text);
    setValue('');
    setMentionOpen(false);
    window.requestAnimationFrame(resize);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组合中（拼音选词、日文变换等）：方向键 / 回车 / Tab / Esc 都归输入法，
    // 这里一个都不接管——否则 @ 菜单会吃掉选词的方向键，回车会把拼音当成员插入。
    // keyCode 229 兜底：部分浏览器组合结束那一下 isComposing 已为 false。
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

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

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const placeholder = composerPlaceholder({ busy, isGroup, botName });

  return (
    <div className="composer-capsule-wrapper">
      {voiceToast ? (
        <div className="composer-voice-toast">语音输入功能适配中，请使用键盘输入</div>
      ) : null}

      {/* Mention Auto-complete Popover：键盘上下选、Enter/Tab 插入、Esc 只关菜单 */}
      {mentionOpen && mentionCandidates.length > 0 ? (
        <div className="composer-mention-popover">
          <div className="mention-header" id="composer-mention-label">选择要 @ 的成员 ({mentionCandidates.length})</div>
          <div className="mention-list" role="listbox" id="composer-mention-list" aria-labelledby="composer-mention-label">
            {mentionCandidates.map((member, idx) => (
              <button
                type="button"
                key={member.id}
                id={`composer-mention-option-${member.id}`}
                role="option"
                aria-selected={idx === mentionIndex}
                className={`mention-item${idx === mentionIndex ? ' selected' : ''}`}
                onMouseEnter={() => setMentionIndex(idx)}
                onClick={() => insertMention(member)}
              >
                <BotAvatar name={member.name} color={member.color} size={22} agentId={member.id} />
                <span className="mention-name">{member.name === 'everyone' ? '@everyone' : member.name}</span>
                <span className="mention-tag">{member.name === 'everyone' ? '全员' : '@唤醒'}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="composer-capsule">
        <div className="capsule-row">
        {/* Left Circular + Button */}
        <div ref={plusRef} className="capsule-slot">
          <button
            type="button"
            className={`capsule-plus-btn${plusOpen ? ' active' : ''}`}
            aria-label="操作与工具"
            title="查看工具"
            onClick={() => setPlusOpen((open) => !open)}
          >
            <IconPlus size={16} />
          </button>

          {plusOpen ? (
            <div className="menu up left capsule-menu">
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

        {isGroup ? (
          <div className="capsule-group-tag" title="当前为群聊协作模式，输入 @ 唤醒指定成员">
            <span className="group-tag-dot" />
            <span>群聊</span>
          </div>
        ) : null}

        {/* Center Input Field */}
        <textarea
          ref={areaRef}
          className="capsule-input"
          rows={1}
          value={value}
          placeholder={placeholder}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          aria-label={isGroup ? '群消息输入框' : '消息输入框'}
          aria-expanded={mentionOpen && mentionCandidates.length > 0}
          aria-controls="composer-mention-list"
          aria-activedescendant={
            mentionOpen && mentionCandidates[mentionIndex]
              ? `composer-mention-option-${mentionCandidates[mentionIndex]?.id}`
              : undefined
          }
        />

        {/* Right: Send / Mic——界面不做停止入口；打「停」走停止令全链（见 docs/架构设计.md「插话、停止和等待」） */}
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

      {/* 底部行与输入框同属一张卡片（对齐白泽观智的输入区排法）：
          模型与思考选择器紧挨在左下，上面一条细分隔线，不再单独漂一行 */}
      <div className="composer-model-bar">
        <div ref={modelRef} className="composer-model-slot">
          <button
            type="button"
            className={`composer-model-trigger${modelOpen ? ' open' : ''}`}
            aria-label="当前模型"
            title={currentModel && currentModel.label !== currentModel.id ? `实际调用：${currentModel.id}` : '选择模型'}
            onClick={() => {
              setModelOpen((open) => !open);
            }}
          >
            {/* 折叠态只显示一个名字：并排展示名称和模型标识会被读成两个模型。
                真实标识放在 title 提示和下拉行里，需要时能看到。 */}
            <span className="composer-model-name">{currentLabel}</span>
            <IconChevronDown size={12} />
          </button>
          {modelOpen ? (
            <div className="menu up left composer-model-menu">
              {models.length === 0 ? (
                <div className="menu-row read-only">
                  <span className="menu-row-text">
                    <span className="menu-row-title">还没有可用模型</span>
                    <span className="menu-row-hint">在模型设置里启用供应商并添加模型</span>
                  </span>
                </div>
              ) : (
                models.map((option) => (
                  <button
                    type="button"
                    key={`${option.providerId ?? ''}:${option.modelConfigId ?? option.id}`}
                    className={`menu-row${option.id === model ? ' selected' : ''}`}
                    onClick={() => {
                      onModelChange(option.id, option);
                      setModelOpen(false);
                    }}
                  >
                    <span className="menu-row-icon">
                      {option.id === model ? <IconCheck size={14} /> : null}
                    </span>
                    <span className="menu-row-text">
                      <span className="menu-row-title">{option.label}</span>
                      <span className="menu-row-hint">
                        {option.label === option.id ? option.hint : `${option.id}${option.hint ? ` · ${option.hint}` : ''}`}
                      </span>
                    </span>
                  </button>
                ))
              )}
              <div className="menu-divider" />
              <button
                type="button"
                className="menu-row composer-manage-models"
                onClick={() => {
                  setModelOpen(false);
                  onManageModels?.();
                }}
              >
                <span className="menu-row-text">
                  <span className="menu-row-title">管理模型</span>
                  <span className="menu-row-hint">打开设置 → 模型设置</span>
                </span>
              </button>
            </div>
          ) : null}
        </div>
        {/* 规范 §5.9：模型 chip 与快捷提示同一行 */}
        <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
      </div>
      </div>
    </div>
  );
}


