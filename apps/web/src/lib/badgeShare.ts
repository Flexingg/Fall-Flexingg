/**
 * Share a badge as a picture: a 1080x1350 card drawn on a canvas (the medal, its tier and name, who
 * earned it). The web hands the PNG to the system share sheet when the browser can share files and
 * otherwise saves it. The Android app can only share text and a link (no file-sharing plugin ships
 * with the app), so it shares those.
 */
import type { BadgeView } from '@gauntlet/shared';
import { BADGE_PATHS, MEDAL_COLORS, medalOf, type Medal } from '../components/BadgeIcon';
import { getApiBase } from './api';
import { earnedLine, tierLabelOf } from './badges';
import { isNative } from './platform';
import { shareLink } from './share';

const W = 1080;
const H = 1350;

/** The medal as an SVG string (same geometry as components/BadgeIcon.tsx). */
export function medalSvg(icon: BadgeView['icon'], medal: Medal): string {
  const c = MEDAL_COLORS[medal];
  const glyph = (BADGE_PATHS[icon] ?? BADGE_PATHS.medal).map((d) => `<path d="${d}"/>`).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 64 64">` +
    `<polygon points="32,3 58,18 58,46 32,61 6,46 6,18" fill="${c}" fill-opacity="0.16" stroke="${c}" stroke-width="3" stroke-linejoin="round"/>` +
    `<polygon points="32,9 53,21 53,43 32,55 11,43 11,21" fill="none" stroke="${c}" stroke-opacity="0.35" stroke-width="1" stroke-linejoin="round"/>` +
    `<g transform="translate(15.2 15.2) scale(1.4)" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${glyph}</g></svg>`
  );
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed'));
    img.src = src;
  });
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

export interface BadgeCard {
  badge: BadgeView;
  /** "Alex Morgan" or "You". */
  who: string;
  level?: number;
  /** Earned date, already formatted. */
  when?: string | null;
}

export async function drawBadgeCard(card: BadgeCard): Promise<Blob> {
  const { badge } = card;
  const medal = medalOf(badge) ?? 'single';
  const color = MEDAL_COLORS[medal];
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const bg = ctx.createRadialGradient(W / 2, 560, 80, W / 2, 560, 900);
  bg.addColorStop(0, '#1d2300');
  bg.addColorStop(1, '#0c0c0d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const font = (w: number, px: number) =>
    `${w} ${px}px "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#c6ff00';
  ctx.font = font(900, 40);
  ctx.fillText('G A U N T L E T', W / 2, 120);

  // The medal: an uploaded image sits inside it when there is one that loads.
  const svgUrl = URL.createObjectURL(
    new Blob([medalSvg(badge.icon, medal)], { type: 'image/svg+xml' }),
  );
  try {
    const img = await loadImage(svgUrl);
    ctx.drawImage(img, W / 2 - 320, 190, 640, 640);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
  if (badge.imageUrl) {
    try {
      const art = await loadImage(
        badge.imageUrl.startsWith('/') ? getApiBase() + badge.imageUrl : badge.imageUrl,
      );
      ctx.save();
      ctx.beginPath();
      ctx.arc(W / 2, 510, 190, 0, Math.PI * 2);
      ctx.fillStyle = '#0c0c0d';
      ctx.fill();
      ctx.clip();
      ctx.drawImage(art, W / 2 - 190, 320, 380, 380);
      ctx.restore();
    } catch {
      // The picture stays as the drawn medal.
    }
  }

  const tier = tierLabelOf(badge);
  ctx.fillStyle = color;
  ctx.font = font(900, 84);
  ctx.fillText((tier ?? 'Badge').toUpperCase(), W / 2, 930);
  ctx.fillStyle = '#f2f2f0';
  ctx.font = font(800, 60);
  const nameLines = wrap(ctx, badge.name, W - 160);
  nameLines.forEach((l, i) => ctx.fillText(l, W / 2, 1010 + i * 66));
  const y = 1010 + nameLines.length * 66 + 10;
  ctx.fillStyle = '#8b8b86';
  ctx.font = font(500, 34);
  const desc = wrap(ctx, badge.description, W - 200);
  desc.slice(0, 2).forEach((l, i) => ctx.fillText(l, W / 2, y + i * 44));
  ctx.fillStyle = '#c6ff00';
  ctx.font = font(800, 34);
  ctx.fillText(
    [card.who, card.level ? `Level ${card.level}` : null, card.when].filter(Boolean).join('  ·  '),
    W / 2,
    H - 70,
  );

  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not draw the card'))),
      'image/png',
    ),
  );
}

/** Share the card (or save it, or fall back to text). Returns what happened, for a toast. */
export async function shareBadge(
  card: BadgeCard,
): Promise<'shared' | 'saved' | 'copied' | 'failed'> {
  const text = `${card.who === 'You' ? 'I earned' : `${card.who} earned`} ${earnedLine(card.badge)} on Gauntlet.`;
  if (isNative) {
    const r = await shareLink('A badge on Gauntlet', text, window.location.origin);
    return r === 'failed' ? 'failed' : r === 'copied' ? 'copied' : 'shared';
  }
  try {
    const blob = await drawBadgeCard(card);
    const file = new File([blob], `gauntlet-${card.badge.key}.png`, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'A badge on Gauntlet', text });
        return 'shared';
      } catch (err) {
        if ((err as Error).name === 'AbortError') return 'shared';
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return 'saved';
  } catch {
    const r = await shareLink('A badge on Gauntlet', text, window.location.origin);
    return r === 'failed' ? 'failed' : r === 'copied' ? 'copied' : 'shared';
  }
}

export function toastForShare(r: Awaited<ReturnType<typeof shareBadge>>): string | null {
  return r === 'saved'
    ? 'Picture saved'
    : r === 'copied'
      ? 'Link copied'
      : r === 'failed'
        ? "Couldn't share. Try again."
        : null;
}
