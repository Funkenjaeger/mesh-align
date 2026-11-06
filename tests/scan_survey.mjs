// node --max-old-space-size=8192 tests/scan_survey.mjs <file.3mf> [tol]
// Load a real scan with the page's own core, then find its largest flat faces by
// seeding plane fits at random vertices (skipping vertices already claimed).
import { readFileSync } from 'node:fs';
import { unzipSync } from '../node_modules/three/examples/jsm/libs/fflate.module.js';
import * as C from '../src/core.js';

const file = process.argv[2], tol = +(process.argv[3] || 0.15);
let t = Date.now();
const files = unzipSync(new Uint8Array(readFileSync(file)), { filter: (f) => /\.model$|\.rels$/i.test(f.name) });
const unz = Date.now() - t; t = Date.now();
const m = C.parse3MF(files);
const parse = Date.now() - t; t = Date.now();
const mesh = C.prepareMesh(m.positions, m.indices);
const prep = Date.now() - t;
const { min, max } = mesh.bbox;
console.log(`${file}: ${mesh.nV.toLocaleString()} verts, ${mesh.nT.toLocaleString()} tris, unit ${m.unit}`);
console.log(`  unzip ${unz} ms, parse ${parse} ms, prep ${prep} ms`);
console.log(`  bbox as scanned: ${[0, 1, 2].map((k) => (max[k] - min[k]).toFixed(1)).join(' x ')} mm`);

// edge length stats (mesh density)
let el = 0, ne = 0;
for (let i = 0; i < Math.min(mesh.nT, 200000); i++) {
  const a = mesh.indices[3 * i], b = mesh.indices[3 * i + 1];
  el += Math.hypot(...[0, 1, 2].map((k) => mesh.positions[3 * a + k] - mesh.positions[3 * b + k])); ne++;
}
console.log(`  mean edge ${(el / ne).toFixed(3)} mm`);

const claimed = new Uint8Array(mesh.nV);
let s = 12345;
const rand = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
const planes = [];
t = Date.now();
for (let k = 0; k < 400 && Date.now() - t < 120000; k++) {
  const v = Math.floor(rand() * mesh.nV);
  if (claimed[v]) continue;
  const r = C.growFeature(mesh, 'plane', v, { tol, maxAngle: 20, seedRadius: 3 });
  if (r.error) continue;
  for (const w of r.vertices) claimed[w] = 1;
  if (r.stats.n < 2000) continue;
  planes.push({ seed: v, ...r });
}
planes.sort((a, b) => b.stats.n - a.stats.n);
console.log(`  plane search ${Date.now() - t} ms, ${planes.length} planes with >= 2000 pts`);
const top = planes.slice(0, 8);
top.forEach((p, i) => {
  const e = p.fit.extent;
  console.log(`  #${i} n=${String(p.stats.n).padStart(7)} ${e.w.toFixed(1)}x${e.h.toFixed(1)} mm  rms ${p.stats.rms.toFixed(4)}  pv ${p.stats.pv.toFixed(3)}  normal ${p.fit.normal.map((x) => x.toFixed(3)).join(',')}  seed ${p.seed}`);
});
// angles between the top planes
const ang = (a, b) => (Math.acos(Math.min(1, Math.abs(C.vec.dot(a, b)))) * 180) / Math.PI;
const lines = [];
for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++)
  lines.push(`#${i}-#${j} ${ang(top[i].fit.normal, top[j].fit.normal).toFixed(2)}°`);
console.log('  angles: ' + lines.join('  '));
