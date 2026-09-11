import type { BotStatus } from '../types';

interface BotFaceProps {
  color: string;
  status: BotStatus;
  size?: number;
  active?: boolean;
}

function eyeShape(status: BotStatus): 'dot' | 'up' | 'squint' | 'happy' | 'wide' | 'cross' {
  switch (status) {
    case 'thinking':
      return 'up';
    case 'working':
      return 'squint';
    case 'error':
      return 'cross';
    default:
      return 'dot';
  }
}

function mood(status: BotStatus): 'flat' | 'smile' | 'small' | 'frown' {
  switch (status) {
    case 'idle':
      return 'smile';
    case 'thinking':
      return 'small';
    case 'working':
      return 'flat';
    default:
      return 'frown';
  }
}

export function BotFace({ color, status, size = 40, active = false }: BotFaceProps) {
  const shape = eyeShape(status);
  const mouth = mood(status);
  const busy = status === 'thinking' || status === 'working';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={`face${busy ? ' busy' : ''}${active ? ' active' : ''}`}
      aria-hidden="true"
    >
      <circle cx="24" cy="24" r="23" fill={color} />
      <circle cx="24" cy="24" r="23" fill="url(#face-shade)" opacity="0.18" />
      <defs>
        <radialGradient id="face-shade" cx="0.3" cy="0.22" r="0.9">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.35" />
        </radialGradient>
      </defs>

      <g className="face-eyes">
        {shape === 'dot' ? (
          <>
            <ellipse cx="17" cy="21" rx="3.1" ry="3.4" fill="#141414" />
            <ellipse cx="31" cy="21" rx="3.1" ry="3.4" fill="#141414" />
          </>
        ) : null}

        {shape === 'up' ? (
          <>
            <ellipse cx="17" cy="19" rx="2.9" ry="3.2" fill="#141414" />
            <ellipse cx="31" cy="19" rx="2.9" ry="3.2" fill="#141414" />
            <circle cx="18.1" cy="17.7" r="1" fill="#fff" opacity="0.85" />
            <circle cx="32.1" cy="17.7" r="1" fill="#fff" opacity="0.85" />
          </>
        ) : null}

        {shape === 'squint' ? (
          <>
            <path
              d="M13.6 21.6c2.2-2.4 4.6-2.4 6.8 0"
              stroke="#141414"
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
            />
            <path
              d="M27.6 21.6c2.2-2.4 4.6-2.4 6.8 0"
              stroke="#141414"
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
            />
          </>
        ) : null}

        {shape === 'happy' ? (
          <>
            <path
              d="M13.8 22.4c2.1-2.9 4.3-2.9 6.4 0"
              stroke="#141414"
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
            />
            <path
              d="M27.8 22.4c2.1-2.9 4.3-2.9 6.4 0"
              stroke="#141414"
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
            />
          </>
        ) : null}

        {shape === 'wide' ? (
          <>
            <circle cx="17" cy="21" r="3.6" stroke="#141414" strokeWidth="2.4" fill="none" />
            <circle cx="31" cy="21" r="3.6" stroke="#141414" strokeWidth="2.4" fill="none" />
          </>
        ) : null}

        {shape === 'cross' ? (
          <>
            <path d="m14.4 18.2 5.2 5.2M19.6 18.2l-5.2 5.2" stroke="#141414" strokeWidth="2.8" strokeLinecap="round" />
            <path d="m28.4 18.2 5.2 5.2M33.6 18.2l-5.2 5.2" stroke="#141414" strokeWidth="2.8" strokeLinecap="round" />
          </>
        ) : null}
      </g>

      {mouth === 'smile' ? (
        <path
          d="M18.5 29.5c1.8 2.6 9.2 2.6 11 0"
          stroke="#141414"
          strokeWidth="2.6"
          strokeLinecap="round"
          fill="none"
        />
      ) : null}
      {mouth === 'small' ? (
        <circle cx="24" cy="30.4" r="1.7" fill="#141414" />
      ) : null}
      {mouth === 'flat' ? (
        <path d="M19.5 30.6h9" stroke="#141414" strokeWidth="2.6" strokeLinecap="round" />
      ) : null}
      {mouth === 'frown' ? (
        <path
          d="M18.8 32.4c1.8-2.6 8.6-2.6 10.4 0"
          stroke="#141414"
          strokeWidth="2.6"
          strokeLinecap="round"
          fill="none"
        />
      ) : null}
    </svg>
  );
}
