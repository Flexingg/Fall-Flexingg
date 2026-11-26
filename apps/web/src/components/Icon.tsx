import type { MetricIcon } from '@gauntlet/shared';

export type IconName =
  | MetricIcon
  | 'today'
  | 'trophy'
  | 'friends'
  | 'trends'
  | 'back'
  | 'chevron'
  | 'share'
  | 'link'
  | 'refresh'
  | 'user'
  | 'check'
  | 'close'
  | 'settings'
  | 'bell';

const PATHS: Record<IconName, string> = {
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4',
  today: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8',
  trophy: 'M7 4h10v5a5 5 0 0 1-10 0zM9 20h6M12 14v6M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3',
  friends:
    'M9 5a3 3 0 1 0 0 6a3 3 0 1 0 0-6M17 6.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5M3 20c0-5 12-5 12 0M15 15c4-1 6 2 6 5',
  trends: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  steps:
    'M8 20c-2 0-3-2-2-4l2-4c1-2 3-1 3 1l-1 5c0 1-1 2-2 2zM16 14c2 0 3-2 2-4l-2-4c-1-2-3-1-3 1l1 5c0 1 1 2 2 2z',
  distance: 'M5 19l5-14 4 8 5-3',
  timer: 'M12 5a8 8 0 1 0 0 16a8 8 0 1 0 0-16M12 9v4l3 2M9 2h6',
  flame: 'M12 3c1 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-4 3-6 1 1 2 1 3-5z',
  dumbbell: 'M3 9v6M6 7v10M18 7v10M21 9v6M6 12h12',
  moon: 'M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z',
  pulse: 'M3 12h4l2-6 4 12 2-6h6',
  plus: 'M12 5v14M5 12h14',
  drop: 'M12 3c3 4 6 7.5 6 11a6 6 0 0 1-12 0c0-3.5 3-7 6-11z',
  fork: 'M7 3v8a2 2 0 0 0 4 0V3M9 11v10M16 3c-1.5 1-2 3-2 6s1 4 2 4v8',
  scale: 'M5 4h14l1 16H4zM12 8v3M9 8a3 3 0 0 0 6 0',
  hourglass: 'M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9',
  target: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 11.5v1',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 5l7 7-7 7',
  share: 'M12 3v12M7 8l5-5 5 5M5 14v5h14v-5',
  link: 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1',
  refresh: 'M20 11a8 8 0 1 0-2 5.3M20 4v7h-7',
  user: 'M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8M4 21c0-5 16-5 16 0',
  check: 'M5 12l5 5 9-10',
  close: 'M6 6l12 12M18 6L6 18',
  settings:
    'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M19 12l2-1-1-3-2 .3-1.4-1.4.3-2-3-1-1 2h-2l-1-2-3 1 .3 2L6 7.3 4 7 3 10l2 1v2l-2 1 1 3 2-.3 1.4 1.4-.3 2 3 1 1-2h2l1 2 3-1-.3-2 1.4-1.4 2 .3 1-3-2-1z',
};

export function Icon({
  name,
  size = 24,
  strokeWidth = 2,
  className,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
