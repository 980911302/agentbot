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
export function attributedText(message: Message, text: string): string {
  const label = messageIdentity(message).originLabel;
  return label ? `[${label}]\n${text}` : text;
}
