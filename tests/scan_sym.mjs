// Symmetry planes on the real scans: automatic search, then restarts from perturbed planes.
import { readFileSync } from 'node:fs';
import { unzipSync } from '../node_modules/three/examples/jsm/libs/fflate.module.js';
import * as C from '../src/core.js';
const load = (n) => {
  const m = C.parse3MF(unzipSync(new Uint8Array(readFileSync(`${process.env.MESH_ALIGN_SCANS || 'scans'}/${n}.3mf`)), { filter: (x) => /\.model$|\.rels$/i.test(x.name) }));
  return C.prepareMesh(m.positions, m.indices);
};
const ang = (a, b) => (Math.acos(Math.min(1, Math.abs(C.vec.dot(a, b)))) * 180) / Math.PI;
for (const n of process.argv.slice(2)) {
  const mesh = load(n);
  let t = Date.now();
  const r = C.findSymmetry(mesh, { tol: 0.2 });
  if (r.error) { console.log(n, r.error); continue; }
  console.log(`${n}: auto ${Date.now() - t} ms -> normal ${r.fit.normal.map((x) => x.toFixed(4))} mirrored ${(r.stats.mirrored * 100).toFixed(1)}% within 0.2 mm, rms ${r.stats.rms.toFixed(3)}`);
  console.log('   candidates: ' + r.candidates.map((c) => `${(c.mirrored * 100).toFixed(1)}% (${c.normal.map((x) => x.toFixed(2))})`).join('  '));
  const [u, v] = [C.vec.unit(C.vec.cross(r.fit.normal, [0.3, 0.5, 0.8])), null];
  const d0 = C.vec.dot(r.fit.normal, r.fit.point);
  for (const [deg, off] of [[3, 0], [0, 5], [5, -4], [8, 6]]) {
    const n0 = C.vec.unit(C.vec.add(r.fit.normal, C.vec.scl(u, Math.tan(deg * Math.PI / 180))));
    t = Date.now();
    const q = C.refineSymmetry(mesh, { normal: n0, d: C.vec.dot(n0, r.fit.point) + off }, { tol: 0.2 });
    if (q.error) { console.log(`   restart ${deg}°/${off} mm: ${q.error}`); continue; }
    const dd = Math.abs(C.vec.dot(r.fit.normal, q.fit.point) - d0);
    console.log(`   restart ${deg}°/${off} mm: ${Date.now() - t} ms, differs by ${ang(q.fit.normal, r.fit.normal).toFixed(4)}° and ${dd.toFixed(4)} mm, mirrored ${(q.stats.mirrored * 100).toFixed(1)}%`);
  }
}
