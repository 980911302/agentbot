import type { BotStatus } from '../types';

interface BotAvatarProps {
  name?: string;
  color?: string;
  size?: number;
  status?: BotStatus;
  className?: string;
}

export function BotAvatar({
  name = '',
  color = '#8b5cf6',
  size = 38,
  className = '',
}: BotAvatarProps) {
  const isDevops = name.includes('测试') || name.includes('运维');
  const isKB = name.includes('知识库');
  const isBaize = name.includes('白泽团队') || (name.includes('白泽') && !name.includes('联调'));
  const isAI = name.includes('AI') || name.includes('智能');
  const isGroup = name.includes('联调') || name.includes('群') || name.includes('组');

  // 1. 白泽联调 - 复合群聊头像
  if (isGroup) {
    return (
      <div
        className={`bot-avatar composite-avatar ${className}`}
        style={{ width: size, height: size }}
        title={name}
      >
        <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
          {/* Background circle */}
          <circle cx="20" cy="20" r="19" fill="#181c24" stroke="#2a303c" strokeWidth="1.5" />

          {/* Mini Avatar 1: LZ */}
          <circle cx="13" cy="16" r="9" fill="#2d3342" stroke="#181c24" strokeWidth="1.5" />
          <text x="13" y="19" textAnchor="middle" fill="#93c5fd" fontSize="7" fontWeight="bold" fontFamily="sans-serif">
            LZ
          </text>

          {/* Mini Avatar 2: Dragon */}
          <circle cx="26" cy="16" r="9" fill="#3b2d54" stroke="#181c24" strokeWidth="1.5" />
          <path
            d="M22 19c1-3 3-4 5-3 1.5.8 2 2.5 1 4-1 1-3 1.2-4.5.5"
            stroke="#c084fc"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          <circle cx="25" cy="15" r="1" fill="#67e8f9" />

          {/* +2 Badge */}
          <rect x="11" y="24" width="18" height="11" rx="5.5" fill="#222834" stroke="#374151" strokeWidth="1" />
          <text x="20" y="32" textAnchor="middle" fill="#e5e7eb" fontSize="7.5" fontWeight="bold" fontFamily="sans-serif">
            +2
          </text>
        </svg>
      </div>
    );
  }

  // 2. 测试运维 - 服务器机柜与状态灯
  if (isDevops) {
    return (
      <div className={`bot-avatar ${className}`} style={{ width: size, height: size }} title={name}>
        <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="20" r="19" fill="#111827" stroke="#1f293d" strokeWidth="1.5" />
          {/* Server Rack 1 */}
          <rect x="10" y="10" width="20" height="5" rx="1.5" fill="#1e293b" stroke="#38bdf8" strokeWidth="1" />
          <line x1="13" y1="12.5" x2="21" y2="12.5" stroke="#38bdf8" strokeWidth="1.2" strokeLinecap="round" />
          <circle cx="26.5" cy="12.5" r="1" fill="#30d158" />

          {/* Server Rack 2 */}
          <rect x="10" y="17.5" width="20" height="5" rx="1.5" fill="#1e293b" stroke="#38bdf8" strokeWidth="1" />
          <line x1="13" y1="20" x2="21" y2="20" stroke="#38bdf8" strokeWidth="1.2" strokeLinecap="round" />
          <circle cx="26.5" cy="20" r="1" fill="#38bdf8" />

          {/* Server Rack 3 */}
          <rect x="10" y="25" width="20" height="5" rx="1.5" fill="#1e293b" stroke="#38bdf8" strokeWidth="1" />
          <line x1="13" y1="27.5" x2="21" y2="27.5" stroke="#38bdf8" strokeWidth="1.2" strokeLinecap="round" />
          <circle cx="26.5" cy="27.5" r="1" fill="#f59e0b" />
        </svg>
      </div>
    );
  }

  // 3. 知识库服务 - 知识拓扑网络
  if (isKB) {
    return (
      <div className={`bot-avatar ${className}`} style={{ width: size, height: size }} title={name}>
        <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="20" r="19" fill="#061c18" stroke="#0f3b32" strokeWidth="1.5" />
          {/* Radial Network Matrix */}
          <circle cx="20" cy="20" r="11" stroke="#10b981" strokeWidth="0.8" strokeDasharray="2 3" opacity="0.6" />
          <circle cx="20" cy="20" r="6" stroke="#34d399" strokeWidth="1" opacity="0.8" />
          <circle cx="20" cy="20" r="2.5" fill="#6ee7b7" />
          {/* Nodes */}
          <circle cx="13" cy="14" r="1.8" fill="#34d399" />
          <circle cx="27" cy="14" r="1.8" fill="#34d399" />
          <circle cx="11" cy="23" r="1.8" fill="#34d399" />
          <circle cx="29" cy="23" r="1.8" fill="#34d399" />
          <circle cx="20" cy="30" r="1.8" fill="#34d399" />
          {/* Connections */}
          <line x1="20" y1="20" x2="13" y2="14" stroke="#10b981" strokeWidth="0.8" opacity="0.7" />
          <line x1="20" y1="20" x2="27" y2="14" stroke="#10b981" strokeWidth="0.8" opacity="0.7" />
          <line x1="20" y1="20" x2="20" y2="30" stroke="#10b981" strokeWidth="0.8" opacity="0.7" />
          <line x1="13" y1="14" x2="11" y2="23" stroke="#10b981" strokeWidth="0.8" opacity="0.5" />
          <line x1="27" y1="14" x2="29" y2="23" stroke="#10b981" strokeWidth="0.8" opacity="0.5" />
        </svg>
      </div>
    );
  }

  // 4. 白泽团队 - 白泽兽神图腾
  if (isBaize) {
    return (
      <div className={`bot-avatar ${className}`} style={{ width: size, height: size }} title={name}>
        <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="20" r="19" fill="#1b1429" stroke="#382956" strokeWidth="1.5" />
          {/* Crest / Horns */}
          <path
            d="M13 14c2-4 6-6 7-6s5 2 7 6c-3-1-5 1-7 1s-4-2-7-1Z"
            fill="#e2e8f0"
            opacity="0.9"
          />
          {/* Beast face */}
          <path
            d="M14 17c1.5 5 3 9 6 12 3-3 4.5-7 6-12-3 1-6 1-12 0Z"
            fill="#f8fafc"
          />
          {/* Eyes */}
          <circle cx="17.5" cy="20.5" r="1.5" fill="#38bdf8" />
          <circle cx="22.5" cy="20.5" r="1.5" fill="#38bdf8" />
          {/* Forehead jewel */}
          <polygon points="20,15 21.5,17.5 20,20 18.5,17.5" fill="#c084fc" />
          {/* Whiskers */}
          <path d="M12 24c3 1 5 1 7 0" stroke="#cbd5e1" strokeWidth="1" strokeLinecap="round" />
          <path d="M28 24c-3 1-5 1-7 0" stroke="#cbd5e1" strokeWidth="1" strokeLinecap="round" />
        </svg>
      </div>
    );
  }

  // 5. AI服务 - 智能反应堆核心
  if (isAI) {
    return (
      <div className={`bot-avatar ${className}`} style={{ width: size, height: size }} title={name}>
        <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="20" r="19" fill="#081526" stroke="#132c4a" strokeWidth="1.5" />
          {/* Core glow */}
          <circle cx="20" cy="20" r="10" stroke="#0284c7" strokeWidth="1.2" opacity="0.6" />
          <circle cx="20" cy="20" r="6" stroke="#38bdf8" strokeWidth="1.5" />
          <circle cx="20" cy="20" r="3" fill="#38bdf8" />
          {/* Orbiting particles */}
          <line x1="20" y1="6" x2="20" y2="10" stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="20" y1="30" x2="20" y2="34" stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="6" y1="20" x2="10" y2="20" stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="30" y1="20" x2="34" y2="20" stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="13" cy="13" r="1.2" fill="#7dd3fc" />
          <circle cx="27" cy="27" r="1.2" fill="#7dd3fc" />
        </svg>
      </div>
    );
  }

  // 通用默认兜底
  return (
    <div className={`bot-avatar ${className}`} style={{ width: size, height: size }} title={name}>
      <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
        <circle cx="20" cy="20" r="19" fill={color} opacity="0.2" stroke={color} strokeWidth="1.5" />
        <circle cx="20" cy="20" r="11" fill={color} />
        <text
          x="20"
          y="24"
          textAnchor="middle"
          fill="#ffffff"
          fontSize="11"
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          {name.slice(0, 1) || 'B'}
        </text>
      </svg>
    </div>
  );
}
