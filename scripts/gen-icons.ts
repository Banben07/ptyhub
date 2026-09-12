/**
 * Rasterise the app icon.
 *
 * `web/assets/icon.svg` is the single source; every PNG and the .ico are
 * produced from it here and committed, so nothing at runtime depends on a
 * rasteriser and the repository has no binary assets that drifted from the
 * vector they came from.
 *
 *   npm run icons
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'web', 'static', 'icons');

function render(svgPath: string, size: number): Buffer {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  });
  return Buffer.from(resvg.render().asPng());
}

/**
 * Minimal ICO container. Writing it by hand avoids a dependency whose only job
 * would be to concatenate a header onto PNGs, which is all an .ico is.
 */
function buildIco(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries: Buffer[] = [];
  let offset = 6 + images.length * 16;

  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

function main(): void {
  fs.mkdirSync(outDir, { recursive: true });
  const master = path.join(root, 'web', 'assets', 'icon.svg');
  const maskable = path.join(root, 'web', 'assets', 'icon-maskable.svg');

  const outputs: { file: string; data: Buffer }[] = [
    { file: 'icon-192.png', data: render(master, 192) },
    { file: 'icon-512.png', data: render(master, 512) },
    { file: 'apple-touch-icon.png', data: render(master, 180) },
    { file: 'icon-maskable-512.png', data: render(maskable, 512) },
    {
      file: 'favicon.ico',
      data: buildIco([
        { size: 16, png: render(master, 16) },
        { size: 32, png: render(master, 32) },
        { size: 48, png: render(master, 48) },
      ]),
    },
  ];

  for (const { file, data } of outputs) {
    fs.writeFileSync(path.join(outDir, file), data);
    process.stdout.write(`  wrote web/static/icons/${file} (${data.length} bytes)\n`);
  }
}

main();
