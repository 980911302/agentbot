import type { Message } from './sse.js';

/** 模型 role 是协议角色；actor 才是产品里的真实发送者。 */
export interface MessageActor { kind: 'user' | 'agent' | 'system'; id: string; name: string; color?: string; avatar?: string }
export interface Correspondence {
  id: string;
  from: MessageActor;
  to: MessageActor;
  text: string;
  images?: import('./input-image.js').InputImage[];
  createdAt: number;
}
export interface MessageIdentity {
  role: 'user' | 'assistant';
  source?: Message['source'];
  sender?: MessageActor;
  senderName?: string;
  senderColor?: string;
  senderAvatar?: string;
  originLabel?: string;
}

export function messageIdentity(message: Message): MessageIdentity {
  const incoming = message.role === 'user';
  const room = Boolean(message.roomId || message.source === 'room');
  const peer = incoming && (message.source === 'agent' || message.sender?.kind === 'agent');
  const sender = message.sender;
  // 旧群 assistant 的 speaker 曾错误继承入站作者，不能据此冒充该作者。
  const name = sender?.name ?? (incoming ? message.speaker : undefined);
  const own = incoming && !room && !peer && (!sender || sender.kind === 'user');
  return {
    role: own ? 'user' : 'assistant', source: message.source, sender,
    senderName: name ?? (incoming && (peer || room) ? '来源未记录' : undefined), senderColor: sender?.color, senderAvatar: sender?.avatar,
    originLabel: room ? `${incoming ? '消息来自' : '发言于'}「${message.roomName || '群聊'}」${incoming ? ` · ${name || '来源未记录'}` : ''}`
      : peer ? `消息来自 ${name || '同事（来源未记录）'}`
        : incoming && sender?.kind === 'system' ? '系统通知' : undefined,
  };
}

/** 给模型与摘要的来源标签；不把协作输入误称为用户指令。 */
export function attributedText(message: Message, text: string, includeWork = true): string {
  const label = attributionLabel(message, includeWork);
  return label ? `[${label}]\n${text}` : text;
}

/**
 * 消息所属工作（E4.6）。只做来源标注：工作事实（完成/取消/进度）一律以 WorkItem 为准，
 * 旧消息、摘要和记忆都不能据此改写工作状态。
 */
export function workLabel(message: Message): string | undefined {
  return message.workId ? `工作 ${message.workId}` : undefined;
}

/**
 * 模型上下文、压缩摘要与记忆抽取共用的完整来源标签：**谁说的、在哪个频道、属于哪件工作**。
 *
 * 只标哪些消息、不标哪些消息是有意为之：本人私聊里的话不额外加标签
 * （role=user 本身已经说明「这是当前用户当面说的」），否则会改变既有上下文形状；
 * 但一旦带上 workId 或群/同事来源就一定要标——压缩一次以后，没有标签就再也分不清
 * 哪句话出自谁、属于哪件事。
 *
 * `includeWork=false` 只给两个地方用：当前这一句（工作由回合 brief 权威说明，不重复标），
 * 和记忆抽取（那里按 USER/AGENT_INPUT 分人，工作 id 是无用噪声）。
 */
export function attributionLabel(message: Message, includeWork = true): string | undefined {
  const label = [messageIdentity(message).originLabel, includeWork ? workLabel(message) : undefined]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  return label || undefined;
}
