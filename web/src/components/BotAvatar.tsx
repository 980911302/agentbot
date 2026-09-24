import { faceStateFromStatus, groupCompositeFaces } from '../features/chat/ui-chrome';
import {
  LivingAvatar,
  loadAvatarShape,
  resolveAvatarColorFromHex,
  type AvatarColor,
  type AvatarShape,
  type AvatarState,
} from './LivingAvatar';

export type { AvatarColor, AvatarShape, AvatarState };

export interface AvatarMember {
  id: string;
  name: string;
  color: string;
  status?: string;
  shape?: AvatarShape;
}

interface BotAvatarProps {
  name?: string;
  color?: string;
  size?: number;
  status?: string;
  className?: string;
  shape?: AvatarShape;
  avatarColor?: AvatarColor;
  agentId?: string;
  isGroup?: boolean;
  members?: AvatarMember[];
  title?: string;
  notice?: boolean;
}

export function resolveAvatarColor(color?: string): AvatarColor {
  return resolveAvatarColorFromHex(color);
}

export function BotAvatar({
  name = '',
  color = '#b89b6a',
  size = 38,
  status = 'idle',
  className = '',
  shape,
  avatarColor,
  agentId,
  isGroup = false,
  members,
  title,
  notice = false,
}: BotAvatarProps) {
  const label = title ?? name;
  const group = isGroup || (members !== undefined && members.length > 0);

  if (group) {
    const roster = members ?? [];
    const { faces, remainder } = groupCompositeFaces(roster);
    const faceSize = Math.max(14, Math.round(size * 0.58));
    return (
      <div
        className={`bot-avatar composite-avatar ${className}`}
        style={{ width: size, height: size }}
        title={label}
      >
        {faces.length === 0 ? (
          <LivingAvatar shape="squircle" color={resolveAvatarColor(color)} state="idle" size={size} frozen title={label} />
        ) : (
          faces.map((member, index) => {
            const working = faceStateFromStatus(member.status) === 'working'
              || faceStateFromStatus(member.status) === 'thinking';
            return (
              <span
                key={member.id || `${member.name}-${index}`}
                className="composite-face"
                style={{ zIndex: index + 1 }}
                title={member.name}
              >
                <LivingAvatar
                  shape={loadAvatarShape(member.id)}
                  color={resolveAvatarColor(member.color)}
                  state={faceStateFromStatus(member.status)}
                  size={faceSize}
                  title={member.name}
                  frozen={!working}
                />
              </span>
            );
          })
        )}
        {remainder > 0 ? <span className="composite-more">+{remainder}</span> : null}
      </div>
    );
  }

  const activeColor = avatarColor || resolveAvatarColor(color);
  const activeShape: AvatarShape = shape || loadAvatarShape(agentId);
  const activeState = faceStateFromStatus(status);

  return (
    <div
      className={`bot-avatar ${className}`}
      style={{ width: size, height: size, display: 'grid', placeItems: 'center' }}
      title={label}
    >
      <LivingAvatar
        shape={activeShape}
        color={activeColor}
        state={activeState}
        size={size}
        title={label}
        notice={notice}
      />
    </div>
  );
}
