/**
 * A badge drawn as a medal: a hexagon in the tier's colour (bronze, silver, gold, platinum with a
 * sheen, or lime for one-tier badges) with a simple stroked glyph in the middle, the same 24x24
 * line style as Icon.tsx. An uploaded image replaces the glyph. Locked badges are dim and grey, and
 * a secret nobody has found yet is a "?".
 */
import {
  tierName,
  type BadgeIcon as BadgeIconName,
  type BadgeView,
  type TierName,
} from '@gauntlet/shared';
import { useId } from 'react';
import { getApiBase } from '../lib/api';
import '../styles/badges.css';

export type Medal = TierName | 'single';

export const MEDAL_COLORS: Record<Medal, string> = {
  bronze: '#c98a4b',
  silver: '#c0c6cf',
  gold: '#f2c94c',
  platinum: '#b8f3ff',
  single: '#c6ff00',
};
const LOCKED = '#5a5a60';

/** Each glyph is one or more stroked paths on a 24x24 grid. */
export const BADGE_PATHS: Record<BadgeIconName, string[]> = {
  shoe: ['M4 17v-7l4 2 2-3 3 3h4a3 3 0 0 1 3 3v2z', 'M4 20h16'],
  steps: [
    'M8 20c-2 0-3-2-2-4l2-4c1-2 3-1 3 1l-1 5c0 1-1 2-2 2zM16 14c2 0 3-2 2-4l-2-4c-1-2-3-1-3 1l1 5c0 1 1 2 2 2z',
  ],
  route: [
    'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    'M18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    'M8 17h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7',
  ],
  mountain: ['M3 19l6-11 4 7 3-4 5 8z'],
  bike: [
    'M6 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M6 16l4-7h5l3 7M10 9l3 7M9 6h3',
  ],
  wave: [
    'M2 11c3-4 5-4 7 0s4 4 7 0 4-4 6 0M2 15c3-4 5-4 7 0s4 4 7 0 4-4 6 0M2 19c3-3 5-3 7 0s4 3 7 0 4-3 6 0',
  ],
  run: ['M14 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M8 21l3-6-2-3 4-3 3 3h3M11 9l-4 2'],
  walk: [
    'M13 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    'M10 21l1-6-2-3 2-5 3 2 2 3M11 12l-3 2M13 14l2 7',
  ],
  hike: ['M12 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M8 21l2-7-2-3 3-5 3 3 2 2M17 8v13'],
  flame: ['M12 3c1 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-4 3-6 1 1 2 1 3-5z'],
  bolt: ['M13 2L5 14h6l-1 8 9-12h-6z'],
  heart: ['M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z'],
  timer: ['M12 5a8 8 0 1 0 0 16 8 8 0 1 0 0-16M12 9v4l3 2M9 2h6'],
  stopwatch: ['M12 8a7 7 0 1 0 0 14 7 7 0 0 0 0-14M12 12v3M10 2h4M12 2v3M18 6l1.5-1.5'],
  calendar: ['M4 6h16v14H4zM4 10h16M8 3v4M16 3v4'],
  streak: ['M4 8l2 2 3-4M4 16l2 2 3-4M13 8h7M13 16h7'],
  sunrise: ['M3 18h18M7 18a5 5 0 0 1 10 0M12 5v4M5 11l2 2M19 11l-2 2'],
  moon: ['M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z'],
  star: ['M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z'],
  crown: ['M3 8l4 4 5-7 5 7 4-4-2 11H5z'],
  trophy: ['M7 4h10v5a5 5 0 0 1-10 0zM9 20h6M12 14v6M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3'],
  medal: ['M9 3l3 6 3-6', 'M12 10a5 5 0 1 0 0 10 5 5 0 0 0 0-10'],
  podium: ['M3 20h18M3 20v-6h6v6M9 20V8h6v12M15 20v-9h6v9'],
  flag: ['M5 21V4M5 4h13l-3 4 3 4H5'],
  target: ['M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18M12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8M12 11.5v1'],
  rocket: [
    'M12 2c4 2 6 6 5 11l-3 3h-4l-3-3c-1-5 1-9 5-11zM12 9a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3',
    'M7 14l-3 3 4 1M17 14l3 3-4 1M10 20l2 2 2-2',
  ],
  dumbbell: ['M3 9v6M6 7v10M18 7v10M21 9v6M6 12h12'],
  kettlebell: ['M12 9a6 6 0 1 0 0 12 6 6 0 0 0 0-12', 'M8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5'],
  barbell: ['M2 12h20M5 7v10M8 5v14M16 5v14M19 7v10'],
  muscle: ['M4 15c2-6 6-8 9-6l3-3 3 3-3 3c1 4-2 8-8 8-3 0-4-2-4-5z'],
  hourglass: ['M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9'],
  drop: ['M12 3c3 4 6 7.5 6 11a6 6 0 0 1-12 0c0-3.5 3-7 6-11z'],
  leaf: ['M5 19C4 9 10 4 20 4c0 10-5 16-13 15M5 19l8-8'],
  snowflake: ['M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 4l3 2 3-2M9 20l3-2 3 2'],
  sun: [
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  ],
  gift: [
    'M4 11h16v9H4zM3 8h18v3H3zM12 8v12',
    'M12 8c-2-4-6-4-5-1 0 1 3 1 5 1zM12 8c2-4 6-4 5-1 0 1-3 1-5 1z',
  ],
  party: ['M4 20l4-12 8 8z', 'M13 4v2M18 7l-1.5 1.5M20 12h-2M10 3l1 2'],
  handshake: ['M2 11l4-3 4 1 3-2 5 3 4-1', 'M2 11l5 6 3-1 2 2 3-1 1 1 4-5M10 9l4 4'],
  chat: ['M4 5h16v11H10l-4 4v-4H4z'],
  clap: ['M8 11l-2-3M11 8L9 4M14 8l1-4', 'M7 13l4 7a6 6 0 0 0 10-5l-3-6-4 2-3-5-3 2z'],
  fire_emoji: [
    'M12 21c-4 0-6-3-6-6 0-4 3-5 3-9 3 2 3 4 3 5 1-1 2-2 2-4 3 2 4 6 4 8 0 4-3 6-6 6z',
    'M12 21c-2 0-3-1-3-3 0-2 3-3 3-5 2 1 3 3 3 5 0 2-1 3-3 3',
  ],
  swords: ['M4 4l10 10M20 4L10 14M4 4v5l4 1M20 4v5l-4 1M6 18l-2 2M18 18l2 2M9 15l-3 3M15 15l3 3'],
  shield: ['M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z'],
  skull: [
    'M12 3a8 8 0 0 0-5 14v3h10v-3a8 8 0 0 0-5-14',
    'M9 11.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2M15 11.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2M11 17v3M13 17v3',
  ],
  ghost: ['M5 21V11a7 7 0 0 1 14 0v10l-3-2-2 2-2-2-2 2-2-2z', 'M9 11v1M15 11v1'],
  owl: [
    'M6 5l3 2h6l3-2v10a6 6 0 0 1-12 0z',
    'M9.5 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4M14.5 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4M12 14l-1 2h2z',
  ],
  coffee: ['M4 8h13v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 10h2a2 2 0 0 1 0 4h-2M8 2v3M12 2v3'],
  dice: ['M4 4h16v16H4zM8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01'],
  globe: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18'],
  compass: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M15.5 8.5l-2 5-5 2 2-5z'],
  map: ['M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14'],
  camera: ['M3 8h4l2-3h6l2 3h4v11H3z', 'M12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7'],
  sparkle: ['M12 3l2 6 6 3-6 3-2 6-2-6-6-3 6-3z'],
  gem: ['M6 4h12l4 5-10 12L2 9zM2 9h20M9 4l-2 5 5 12 5-12-2-5'],
  infinity: ['M12 12c-2-3-3-4-5-4a4 4 0 0 0 0 8c2 0 3-1 5-4s3-4 5-4a4 4 0 0 1 0 8c-2 0-3-1-5-4'],
  hundred: ['M3 8l2-1v10M9 7h4v10H9zM15 7h4v10h-4z'],
  turtle: ['M4 15a8 6 0 0 1 16 0zM7 15l-2 3M17 15l2 3M20 14l2-2 1 2M9 11l2 2M13 11l-2 2M12 9v2'],
  rabbit: [
    'M9 3c-1 3 0 6 1 7M15 3c1 3 0 6-1 7M7 14a5 5 0 0 1 10 0v2a5 5 0 0 1-10 0zM10 14h.01M14 14h.01',
  ],
  lightning: ['M7 2l-3 11h5l-2 9 10-13h-6l3-7z'],
  anchor: ['M12 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4M12 5v16M7 11h10M4 14c0 4 4 7 8 7s8-3 8-7'],
};

export const BADGE_ICON_SIZES = { sm: 28, md: 48, lg: 72, xl: 120 } as const;
export type BadgeIconSize = keyof typeof BADGE_ICON_SIZES;

/** Which medal a badge view wears: its reached tier, or (for a locked one) nothing. */
export function medalOf(b: Pick<BadgeView, 'tier' | 'tiers'>): Medal | null {
  if (b.tier <= 0) return null;
  return tierName(b.tier, b.tiers.length) ?? 'single';
}

export function BadgeIcon({
  icon,
  imageUrl,
  medal,
  hidden,
  size = 'md',
  title,
}: {
  icon: BadgeIconName;
  imageUrl?: string | null;
  /** The tier colour; null or left out means locked (dim grey). */
  medal?: Medal | null;
  /** An unearned secret: a "?" in place of the glyph. */
  hidden?: boolean;
  size?: BadgeIconSize | number;
  title?: string;
}) {
  const uid = useId().replace(/:/g, '');
  const px = typeof size === 'number' ? size : BADGE_ICON_SIZES[size];
  const locked = !medal || hidden;
  const color = locked ? LOCKED : MEDAL_COLORS[medal];
  const glyph = BADGE_PATHS[icon] ?? BADGE_PATHS.medal;
  const src = imageUrl ? (imageUrl.startsWith('/') ? getApiBase() + imageUrl : imageUrl) : null;
  return (
    <svg
      className={`bi${locked ? ' locked' : ''}${medal === 'platinum' ? ' platinum' : ''}`}
      width={px}
      height={px}
      viewBox="0 0 64 64"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-medal={locked ? 'locked' : medal}
    >
      <defs>
        <linearGradient id={`${uid}s`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.5" />
          <stop offset="0.4" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.8" stopColor="#fff" stopOpacity="0.2" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${uid}c`}>
          <circle cx="32" cy="32" r="19" />
        </clipPath>
      </defs>
      <polygon
        points="32,3 58,18 58,46 32,61 6,46 6,18"
        fill={color}
        fillOpacity={locked ? 0.08 : 0.16}
        stroke={color}
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <polygon
        points="32,9 53,21 53,43 32,55 11,43 11,21"
        fill="none"
        stroke={color}
        strokeOpacity="0.35"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      {medal === 'platinum' && (
        <polygon
          points="32,3 58,18 58,46 32,61 6,46 6,18"
          fill={`url(#${uid}s)`}
          className="bi-sheen"
        />
      )}
      {hidden ? (
        <text x="32" y="41" textAnchor="middle" fontSize="26" fontWeight="900" fill={color}>
          ?
        </text>
      ) : src ? (
        <image
          href={src}
          x="13"
          y="13"
          width="38"
          height="38"
          clipPath={`url(#${uid}c)`}
          preserveAspectRatio="xMidYMid slice"
        />
      ) : (
        <g
          transform="translate(15.2 15.2) scale(1.4)"
          fill="none"
          stroke={color}
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {glyph.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
      )}
    </svg>
  );
}
