// Renders the SVG icons to the PNG sizes the PWA manifest and Android need.
// Usage: node scripts/gen-icons.mjs   (needs Playwright's Chromium)
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const icons = join(root, 'public/icons');
const res = join(root, 'android/app/src/main/res');

const jobs = [
  ['icon.svg', join(icons, 'icon-192.png'), 192],
  ['icon.svg', join(icons, 'icon-512.png'), 512],
  ['maskable.svg', join(icons, 'maskable-512.png'), 512],
  ['icon.svg', join(icons, 'apple-touch-icon.png'), 180],
];
// Android launcher icons: legacy square + round, and adaptive foreground layers.
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, scale] of Object.entries(densities)) {
  jobs.push(['maskable.svg', join(res, `mipmap-${d}/ic_launcher.png`), 48 * scale]);
  jobs.push(['maskable.svg', join(res, `mipmap-${d}/ic_launcher_round.png`), 48 * scale, true]);
  jobs.push(['foreground.svg', join(res, `mipmap-${d}/ic_launcher_foreground.png`), 108 * scale]);
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();
for (const [svg, out, size, round] of jobs) {
  const markup = readFileSync(join(icons, svg), 'utf8');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;${round ? 'border-radius:50%;overflow:hidden' : ''}">${markup.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`,
  );
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
console.log(`wrote ${jobs.length} icons`);

// Splash screens: Gauntlet mark centred on the app background, at the sizes Capacitor ships.
import { readdirSync, existsSync } from 'node:fs';
const splashBrowser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const sp = await splashBrowser.newPage();
const mark = readFileSync(join(icons, 'icon.svg'), 'utf8');
let splashes = 0;
if (existsSync(res)) {
  for (const dir of readdirSync(res).filter((d) => d.startsWith('drawable'))) {
    const file = join(res, dir, 'splash.png');
    if (!existsSync(file)) continue;
    const buf = readFileSync(file);
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    const size = Math.round(Math.min(w, h) * 0.28);
    await sp.setViewportSize({ width: w, height: h });
    await sp.setContent(
      `<html><body style="margin:0;background:#0c0c0d;display:flex;align-items:center;justify-content:center;width:${w}px;height:${h}px"><div style="width:${size}px;height:${size}px;border-radius:${size * 0.22}px;overflow:hidden">${mark.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`,
    );
    await sp.screenshot({ path: file, clip: { x: 0, y: 0, width: w, height: h } });
    splashes++;
  }
}
await splashBrowser.close();
console.log(`wrote ${splashes} splash screens`);
