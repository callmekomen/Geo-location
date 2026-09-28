/**
 * Copy Leaflet out of node_modules into public/vendor so the app never depends
 * on a CDN. A driver in Yola on 2G should not be waiting on unpkg.
 */
import { cp, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', 'leaflet', 'dist');
const target = join(root, 'public', 'vendor', 'leaflet');

try {
  await access(source);
} catch {
  process.stdout.write('leaflet not installed yet — skipping vendor step\n');
  process.exit(0);
}

await mkdir(target, { recursive: true });
for (const file of ['leaflet.js', 'leaflet.css', 'images']) {
  await cp(join(source, file), join(target, file), { recursive: true });
}
process.stdout.write('vendored leaflet -> public/vendor/leaflet\n');
