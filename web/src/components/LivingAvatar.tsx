import { useEffect, useState } from "react";

export const AVATAR_SHAPES = [
  "blob",
  "pebble",
  "bean",
  "egg",
  "squircle",
  "tablet",
  "capsule",
  "cylinder",
  "hex",
  "gem",
  "crystal",
  "wedge",
  "shield",
  "dome",
  "arch",
  "cloud",
  "teardrop",
  "leaf",
] as const;

export const AVATAR_COLORS = [
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "violet",
  "magenta",
  "gray",
] as const;

export type AvatarShape = (typeof AVATAR_SHAPES)[number];
export type AvatarColor = (typeof AVATAR_COLORS)[number];
export type AvatarState = "idle" | "thinking" | "working" | "waiting" | "blocked" | "done" | "paused";

const SHAPES: Record<AvatarShape, string> = {
  blob: "M32 8c11 0 20 9.4 20 22 0 13.2-8.4 24-20 24S12 43.2 12 30C12 17.4 21 8 32 8Z",
  pebble: "M32 12c12 0 20 8 20 20s-8 20-20 20S12 44 12 32 20 12 32 12Z",
  bean: "M22 14c10-8 24-4 28 10 4 14-4 28-16 30-12 2-22-8-22-20 0-8 3-14 10-20Z",
  egg: "M32 8c10 0 16 12 16 24S42 56 32 56 16 44 16 32 22 8 32 8Z",
  squircle: "M16 10h32c6 0 10 4 10 10v24c0 6-4 10-10 10H16c-6 0-10-4-10-10V20c0-6 4-10 10-10Z",
  tablet: "M12 16h40c4 0 6 3 6 7v18c0 4-2 7-6 7H12c-4 0-6-3-6-7V23c0-4 2-7 6-7Z",
  capsule: "M18 16h28c8 0 12 8 12 16s-4 16-12 16H18C10 48 6 40 6 32s4-16 12-16Z",
  cylinder: "M14 14h36c3 0 6 3 6 6v24c0 3-3 6-6 6H14c-3 0-6-3-6-6V20c0-3 3-6 6-6Z",
  hex: "M32 8l18 10v20L32 56 14 38V18Z",
  gem: "M32 8l18 16-18 32L14 24Z",
  crystal: "M32 6l14 12v20L32 58 18 38V18Z",
  wedge: "M32 8c8 6 18 20 18 32 0 10-8 16-18 16S14 50 14 40C14 28 24 14 32 8Z",
  shield: "M32 8l20 6v18c0 14-8 22-20 26C20 54 12 46 12 32V14Z",
  dome: "M12 34V28C12 16 20 10 32 10s20 6 20 18v6c0 12-8 20-20 20S12 46 12 34Z",
  arch: "M12 48V28C12 16 20 10 32 10s20 6 20 18v20c0 4-4 6-8 6H20c-4 0-8-2-8-6Z",
  cloud: "M20 40c-8 0-12-6-12-12 0-6 5-11 12-11 2-7 10-12 18-10 6 1 10 6 11 12 6 1 11 7 11 13 0 7-6 12-14 12H20Z",
  teardrop: "M32 8c12 14 18 22 18 30 0 10-8 18-18 18S14 48 14 38C14 30 20 22 32 8Z",
  leaf: "M14 42C14 22 24 10 44 8c2 20-4 34-20 42-6 2-10-2-10-8Z",
};

export const AVATAR_COLOR_HEX: Record<AvatarColor, string> = {
  black: "#1b1d22",
  brown: "#b89b6a",
  red: "#e24b4b",
  orange: "#f08a2c",
  yellow: "#e6c041",
  green: "#3cb86c",
  cyan: "#39c1c8",
  blue: "#3b82f6",
  violet: "#8b5cf6",
  magenta: "#d946a6",
  gray: "#8b93a7",
};

const COLORS = AVATAR_COLOR_HEX;

const SHAPE_STORAGE_PREFIX = 'agentbot.avatarShape.';
const DEFAULT_AGENT_COLORS: AvatarColor[] = ['red', 'magenta', 'orange', 'yellow', 'blue', 'cyan', 'green', 'violet', 'brown'];

function stableAvatarIndex(identity: string, count: number): number {
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i += 1) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

export function defaultAgentAvatarColor(identity?: string): AvatarColor {
  if (!identity) return 'brown';
  const score = [...identity].reduce((total, character, index) => total + character.codePointAt(0)! * (index + 1), 0);
  return DEFAULT_AGENT_COLORS[score % DEFAULT_AGENT_COLORS.length] || 'brown';
}

export function defaultAgentAvatarShape(identity?: string): AvatarShape {
  if (!identity) return 'squircle';
  const defaults: AvatarShape[] = ['hex', 'wedge', 'blob', 'shield', 'pebble', 'squircle'];
  return defaults[stableAvatarIndex(identity, defaults.length)] || 'squircle';
}

export function resolveAvatarColorFromHex(color?: string): AvatarColor {
  if (!color) return 'brown';
  const c = color.toLowerCase();
  if ((AVATAR_COLORS as readonly string[]).includes(c)) return c as AvatarColor;
  if (c.includes('a855f7') || c.includes('8b5cf6') || c.includes('7c3aed') || c.includes('purple') || c.includes('violet')) return 'violet';
  if (c.includes('3b82f6') || c.includes('60a5fa') || c.includes('blue') || c.includes('#2563eb')) return 'blue';
  if (c.includes('38bdf8') || c.includes('cyan') || c.includes('06b6d4') || c.includes('39c1c8')) return 'cyan';
  if (c.includes('30d158') || c.includes('10b981') || c.includes('green') || c.includes('22c55e') || c.includes('3cb86c')) return 'green';
  if (c.includes('f59e0b') || c.includes('eab308') || c.includes('yellow') || c.includes('e6c041') || c.includes('facc15')) return 'yellow';
  if (c.includes('f97316') || c.includes('orange') || c.includes('f08a2c')) return 'orange';
  if (c.includes('ef4444') || c.includes('f87171') || c.includes('red') || c.includes('e24b4b')) return 'red';
  if (c.includes('ec4899') || c.includes('d946a6') || c.includes('magenta')) return 'magenta';
  if (c.includes('8b93a7') || c.includes('gray') || c.includes('1b1d22') || c.includes('black')) return c.includes('1b1d22') || c.includes('black') ? 'black' : 'gray';
  if (/^#[0-9a-f]{6}$/i.test(c)) {
    const rgb = [1, 3, 5].map((offset) => Number.parseInt(c.slice(offset, offset + 2), 16));
    return AVATAR_COLORS.reduce((nearest, candidate) => {
      const hex = AVATAR_COLOR_HEX[candidate];
      const candidateRgb = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
      const distance = rgb.reduce((sum, value, index) => sum + (value - candidateRgb[index]!) ** 2, 0);
      const nearestHex = AVATAR_COLOR_HEX[nearest];
      const nearestRgb = [1, 3, 5].map((offset) => Number.parseInt(nearestHex.slice(offset, offset + 2), 16));
      const nearestDistance = rgb.reduce((sum, value, index) => sum + (value - nearestRgb[index]!) ** 2, 0);
      return distance < nearestDistance ? candidate : nearest;
    }, 'brown' as AvatarColor);
  }
  if (c.includes('8a5a32') || c.includes('b89b6a') || c.includes('93784a') || c.includes('ad8a54') || c.includes('b8924e') || c.includes('brown')) return 'brown';
  return 'brown';
}

export function loadAvatarShape(agentId?: string): AvatarShape {
  if (!agentId) return 'squircle';
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(`${SHAPE_STORAGE_PREFIX}${agentId}`);
  if (raw === 'squircle') return defaultAgentAvatarShape(agentId);
  if (raw === 'squircle:custom') return 'squircle';
  if (raw && (AVATAR_SHAPES as readonly string[]).includes(raw)) return raw as AvatarShape;
  return defaultAgentAvatarShape(agentId);
}

export function saveAvatarShape(agentId: string, shape: AvatarShape): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(`${SHAPE_STORAGE_PREFIX}${agentId}`, shape === 'squircle' ? 'squircle:custom' : shape);
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function LivingAvatar({
  shape = "blob",
  color = "violet",
  state = "idle",
  size = 38,
  title,
  className = "",
  frozen = false,
  notice = false,
}: {
  shape?: AvatarShape;
  color?: AvatarColor;
  state?: AvatarState;
  size?: number;
  title?: string;
  className?: string;
  /** 群复合头像里的闲置小脸、以及 reduced-motion 时冻结为静态一帧 */
  frozen?: boolean;
  /** 新开口的一闪，不循环 */
  notice?: boolean;
}) {
  const fill = COLORS[color];
  const eyes = "#151515";
  const reduced = usePrefersReducedMotion();
  const still = frozen || reduced;

  return (
    <svg
      className={`living-avatar ${className}`}
      data-state={still ? 'idle' : state}
      data-frozen={still ? 'true' : undefined}
      data-notice={notice && !still ? 'true' : undefined}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-label={title}
    >
      <style>{`
        .living-avatar[data-frozen="true"] .body,
        .living-avatar[data-frozen="true"] .eyes,
        .living-avatar[data-frozen="true"] .wrap { animation: none !important; transform: none !important; }
        .living-avatar[data-state="idle"] .body { animation: la-breathe 3.4s ease-in-out infinite; transform-origin: 32px 36px; }
        .living-avatar[data-state="idle"] .eyes { animation: la-blink 4.6s steps(2, jump-none) infinite; transform-origin: 32px 28px; }
        .living-avatar[data-state="thinking"] .body { animation: la-breathe 2.6s ease-in-out infinite; transform-origin: 32px 36px; }
        .living-avatar[data-state="thinking"] .eyes { animation: la-glance 1.8s ease-in-out infinite; }
        .living-avatar[data-state="working"] .body { animation: la-work 0.55s ease-in-out infinite; transform-origin: 32px 40px; }
        .living-avatar[data-state="working"] .eyes { animation: la-focus 0.55s ease-in-out infinite; transform-origin: 32px 28px; }
        .living-avatar[data-state="waiting"] .body { animation: la-breathe 2.8s ease-in-out infinite; transform-origin: 32px 36px; }
        .living-avatar[data-state="waiting"] .eyes { animation: la-lookup 2.2s ease-in-out infinite; }
        .living-avatar[data-state="blocked"] .wrap { transform: rotate(-8deg); transform-origin: 32px 32px; }
        .living-avatar[data-state="blocked"] .eyes { transform: scaleY(0.72); transform-origin: 32px 28px; }
        .living-avatar[data-state="done"] .body { animation: la-settle 1.2s ease-out 1; transform-origin: 32px 36px; }
        .living-avatar[data-state="paused"] .body { animation: none; filter: grayscale(60%); transform-origin: 32px 36px; }
        .living-avatar[data-state="paused"] .eyes { animation: none; transform: scaleY(0.18); transform-origin: 32px 28px; }
        .living-avatar[data-state="paused"] .wrap { animation: none; }
        .living-avatar[data-state="done"] .eyes { animation: la-happy 1.2s ease-out 1; transform-origin: 32px 28px; }
        .living-avatar[data-notice="true"] .wrap { animation: la-notice 0.32s var(--ease, cubic-bezier(0.16, 1, 0.3, 1)) 1; transform-origin: 32px 32px; }
        @keyframes la-notice { 0% { filter: brightness(1); } 40% { filter: brightness(1.45); } 100% { filter: brightness(1); } }
        @keyframes la-breathe { 0%,100% { transform: scale(1,1); } 50% { transform: scale(1.045, 0.97); } }
        @keyframes la-blink { 0%, 86%, 100% { transform: scaleY(1); } 90%, 92% { transform: scaleY(0.12); } }
        @keyframes la-glance { 0%,100% { transform: translateX(0); } 40% { transform: translateX(-2.2px); } 70% { transform: translateX(2.2px); } }
        @keyframes la-work { 0%,100% { transform: translateY(0) scale(1,1); } 50% { transform: translateY(-2.5px) scale(1.03, 0.96); } }
        @keyframes la-focus { 0%,100% { transform: scale(1, 0.82); } 50% { transform: scale(1.04, 0.7); } }
        @keyframes la-lookup { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-2.6px); } }
        @keyframes la-settle { 0% { transform: scale(1.08, 0.92); } 60% { transform: scale(0.98, 1.03); } 100% { transform: scale(1,1); } }
        @keyframes la-happy { 0%,100% { transform: scaleY(0.78); } 50% { transform: scaleY(0.62); } }
      `}</style>
      <g className="wrap">
        <path className="body" d={SHAPES[shape]} fill={fill} />
        <g className="eyes" fill={eyes}>
          <ellipse cx="24.5" cy="28" rx="4.1" ry="5.1" />
          <ellipse cx="39.5" cy="28" rx="4.1" ry="5.1" />
        </g>
      </g>
    </svg>
  );
}
