// Curved-face flags on the real scans, and a worked V1410 alignment written to a 3MF.
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8 } from '../node_modules/three/examples/jsm/libs/fflate.module.js';
import * as C from '../src/core.js';

const DIR = process.env.MESH_ALIGN_SCANS || 'scans';  // the scans are not in the repo
const load = (n) => {
  const files = unzipSync(new Uint8Array(readFileSync(`${DIR}/${n}.3mf`)), { filter: (x) => /\.model$|\.rels$/i.test(x.name) });
  const m = C.parse3MF(files);
  return C.prepareMesh(m.positions, m.indices);
};
const opts = { tol: 0.2, maxAngle: 20, seedRadius: 3 };
const ang = (a, b) => (Math.acos(Math.min(1, Math.abs(C.vec.dot(a, b)))) * 180) / Math.PI;
const describe = (name, r) => console.log(`  ${name}: n=${r.stats.n} ${r.fit.extent.w.toFixed(1)}x${r.fit.extent.h.toFixed(1)} mm rms ${r.stats.rms.toFixed(3)} ` +
  `grow@2tol ${(r.stats.wideGrow * 100).toFixed(1)}% rms x${r.stats.wideRms.toFixed(2)} -> ${r.stats.curved ? 'NOT FLAT' : 'flat'}`);

for (const [n, seeds] of [['rockit', [3859, 329189]], ['xb8', [1285921, 742431]]]) {
  const mesh = load(n);
  console.log(n);
  for (const s of seeds) describe(`seed ${s}`, C.growFeature(mesh, 'plane', s, opts));
}

const mesh = load('v1410');
console.log('v1410');
const feats = [];
for (const [id, seed] of [['A', 73010], ['B', 9297], ['E', 427687]]) {
  const r = C.growFeature(mesh, 'plane', seed, opts);
  describe(`${id} (seed ${seed})`, r);
  feats.push({ id, name: id, type: 'plane', ...r });
}
const [A, B, E] = feats;
console.log(`  A vs B ${ang(A.fit.normal, B.fit.normal).toFixed(3)}° apart; A vs end plate E ${ang(A.fit.normal, E.fit.normal).toFixed(3)}°`);
const thick = Math.abs(C.vec.dot(A.fit.normal, C.vec.sub(B.fit.point, A.fit.point)));
console.log(`  distance A to B (measured along A's normal at B's centroid): ${thick.toFixed(3)} mm`);

const spec = {
  primary: { feature: 'A', axis: 'z', flip: true },
  secondary: { feature: 'E', to: '', axis: 'x', flip: true },
  origin: { x: { src: 'f:E' }, y: { src: 'bbox:min' }, z: { src: 'f:A' } },
};
const r = C.solveAlignment(feats, spec, mesh);
if (!r.ok) { console.log('  alignment failed:', r.message); process.exit(1); }
console.log(`  aligned: secondary ${r.secondaryAngle.toFixed(3)}° from primary; origin X ${r.originFrom[0]}, Y ${r.originFrom[1]}, Z ${r.originFrom[2]}`);
const P2 = C.transformPositions(mesh.positions, r.matrix);
const ext = [0, 1, 2].map((k) => { let lo = Infinity, hi = -Infinity; for (let i = k; i < P2.length; i += 3) { lo = Math.min(lo, P2[i]); hi = Math.max(hi, P2[i]); } return [lo, hi]; });
console.log('  aligned extents: ' + ext.map(([lo, hi], k) => `${'XYZ'[k]} ${lo.toFixed(2)}..${hi.toFixed(2)}`).join(', '));
// Re-measure the faces after alignment: A should be Z=0 with normal -Z, E at X=0.
const enc = new TextEncoder();
const tjson = JSON.stringify({ tool: 'Mesh Align', version: 1, source: 'v1410.3mf', units: 'mm', matrix_row_major: r.matrix,
  note: 'aligned = M · [x, y, z, 1], with source coordinates in millimeters', spec });
const parts = C.build3MF(P2, mesh.indices, { Title: 'v1410-aligned', Application: 'Mesh Align' }, tjson);
const model = parts['3D/3dmodel.model'].map((c) => enc.encode(c));
const total = new Uint8Array(model.reduce((a, p) => a + p.length, 0));
let off = 0; for (const p of model) { total.set(p, off); off += p.length; }
const zip = zipSync({ '[Content_Types].xml': strToU8(parts['[Content_Types].xml']), '_rels/.rels': strToU8(parts['_rels/.rels']), '3D/3dmodel.model': [total, { level: 6 }] });
writeFileSync(`${DIR}/v1410-aligned.3mf`, zip);
console.log(`  wrote ${DIR}/v1410-aligned.3mf (${(zip.length / 1e6).toFixed(1)} MB)`);

// Round trip: re-open the written file and re-fit face A; it should now be Z = 0, normal -Z.
const back = C.prepareMesh(...(() => { const m = C.parse3MF(unzipSync(zip)); return [m.positions, m.indices]; })());
const A2 = C.growFeature(back, 'plane', 73010, opts);
console.log(`  re-fit A on the written file: normal ${A2.fit.normal.map((x) => x.toFixed(5)).join(', ')}, z at centroid ${A2.fit.point[2].toFixed(4)} mm`);
