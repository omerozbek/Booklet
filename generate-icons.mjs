/**
 * Run once with: node generate-icons.mjs
 * Generates icon-192.png, icon-512.png, and apple-touch-icon.png in frontend/public/
 * Requires: npm install canvas  (run from root)
 */
import { createCanvas } from 'canvas';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

function makeIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const r = size * 0.16; // corner radius

  // Background
  ctx.fillStyle = '#1a1a2e';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, r);
  ctx.fill();

  // Book body (left page)
  const bx = size * 0.22, by = size * 0.18, bw = size * 0.27, bh = size * 0.64;
  ctx.fillStyle = '#16213e';
  ctx.strokeStyle = '#e94560';
  ctx.lineWidth = size * 0.02;
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, size * 0.03);
  ctx.fill();
  ctx.stroke();

  // Book body (right page)
  const rx2 = size * 0.51;
  ctx.beginPath();
  ctx.roundRect(rx2, by, bw, bh, size * 0.03);
  ctx.fill();
  ctx.stroke();

  // Spine
  ctx.fillStyle = '#e94560';
  ctx.fillRect(size * 0.48, by, size * 0.04, bh);

  // Panel lines (left)
  ctx.strokeStyle = 'rgba(233,69,96,0.55)';
  ctx.lineWidth = size * 0.015;
  for (const frac of [0.38, 0.52, 0.66]) {
    ctx.beginPath();
    ctx.moveTo(bx + size * 0.03, by + bh * frac);
    ctx.lineTo(bx + bw - size * 0.03, by + bh * frac);
    ctx.stroke();
  }
  // Panel lines (right)
  for (const frac of [0.38, 0.55]) {
    ctx.beginPath();
    ctx.moveTo(rx2 + size * 0.03, by + bh * frac);
    ctx.lineTo(rx2 + bw - size * 0.03, by + bh * frac);
    ctx.stroke();
  }

  return canvas.toBuffer('image/png');
}

const outDir = join(__dir, 'frontend', 'public');
writeFileSync(join(outDir, 'icon-192.png'), makeIcon(192));
writeFileSync(join(outDir, 'icon-512.png'), makeIcon(512));
writeFileSync(join(outDir, 'apple-touch-icon.png'), makeIcon(180));

console.log('Icons generated in frontend/public/');
