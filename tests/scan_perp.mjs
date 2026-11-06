// XB8: free mirror M1, then the second mirror found perpendicular to it, and the same from clicks.
import { readFileSync } from 'node:fs';
import { unzipSync } from '../node_modules/three/examples/jsm/libs/fflate.module.js';
import * as C from '../src/core.js';
const V = C.vec, ang = (a, b) => (Math.acos(Math.min(1, Math.abs(V.dot(a, b)))) * 180) / Math.PI;
const m = C.parse3MF(unzipSync(new Uint8Array(readFileSync(`${process.env.MESH_ALIGN_SCANS || 'scans'}/xb8.3mf`)), { filter: (x) => /\.model$|\.rels$/i.test(x.name) }));
const mesh = C.prepareMesh(m.positions, m.indices), opts = { tol: 0.2 };
const M1 = C.findSymmetry(mesh, opts);
console.log(`M1 ${(M1.stats.mirrored * 100).toFixed(1)}%`);
let t = Date.now();
const M2 = C.findSymmetryPerp(mesh, M1.fit.normal, opts);
console.log(`perp search ${Date.now() - t} ms: ${(M2.stats.mirrored * 100).toFixed(1)}% mirrors, rms ${M2.stats.rms.toFixed(3)}, ${ang(M2.fit.normal, M1.fit.normal).toFixed(4)}° from M1; peaks ${M2.candidates.map((c) => (c.mirrored * 100).toFixed(0) + '%').join(' ')}`);
// Unconstrained second mirror from the same start, for comparison.
const free = C.refineSymmetry(mesh, { normal: M2.fit.normal, d: V.dot(M2.fit.normal, M2.fit.point), point: M2.fit.point }, opts);
console.log(`unconstrained from there: ${(free.stats.mirrored * 100).toFixed(1)}%, ${ang(free.fit.normal, M1.fit.normal).toFixed(3)}° from M1, ${ang(free.fit.normal, M2.fit.normal).toFixed(3)}° from the constrained one`);
// Constrained clicks: two points straddling M2, deliberately off (a few mm and degrees).
const c = M2.fit.point, n2 = M2.fit.normal, w = V.unit(V.cross(n2, M1.fit.normal));
for (const [k, skew] of [[0, 0], [1, 8], [2, -15]]) {
  const p1 = V.add(V.sub(c, V.scl(n2, 40)), V.scl(w, skew)), p2 = V.add(V.add(c, V.scl(n2, 45)), V.scl(w, -skew));
  t = Date.now();
  const r = C.symmetryFromPoints(mesh, p1, p2, { ...opts, perpTo: M1.fit.normal });
  console.log(`clicks ${k}: ${Date.now() - t} ms, ${r.error || `${(r.stats.mirrored * 100).toFixed(1)}%, ${ang(r.fit.normal, n2).toFixed(4)}° and ${Math.abs(V.dot(n2, V.sub(r.fit.point, c))).toFixed(4)} mm from the search result`}`);
}
// Where does M2 fail to mirror? Bin the sampled surface by height along the long axis.
{
  const P = mesh.positions, N = mesh.normals;
  const ax = V.unit(V.cross(M1.fit.normal, M2.fit.normal));
  const n = M2.fit.normal, d = V.dot(n, M2.fit.point);
  const g = C.__test.symGrid(mesh);
  const bins = Array.from({ length: 10 }, () => [0, 0]);
  let lo = Infinity, hi = -Infinity;
  for (let v = 0; v < mesh.nV; v += 7) { const t = V.dot([P[3 * v], P[3 * v + 1], P[3 * v + 2]], ax); lo = Math.min(lo, t); hi = Math.max(hi, t); }
  for (let v = 0; v < mesh.nV; v += 61) {
    const q = [P[3 * v], P[3 * v + 1], P[3 * v + 2]], s = 2 * (V.dot(n, q) - d);
    const qr = [q[0] - s * n[0], q[1] - s * n[1], q[2] - s * n[2]];
    const mm = C.__test.nearest(g, qr, 2);
    const b = Math.min(9, Math.floor(((V.dot(q, ax) - lo) / (hi - lo)) * 10));
    bins[b][1]++;
    if (mm >= 0) { const r = Math.abs(V.dot([N[3 * mm], N[3 * mm + 1], N[3 * mm + 2]], V.sub(qr, [P[3 * mm], P[3 * mm + 1], P[3 * mm + 2]]))); if (r <= 0.2) bins[b][0]++; }
  }
  console.log('M2 mirrors within 0.2 mm, by tenth of height (one end to the other): ' + bins.map(([a, b]) => `${Math.round((100 * a) / Math.max(1, b))}%`).join(' '));
  // Refit using only the middle 80% of the height.
  const keep = (v) => { const t = (V.dot([P[3 * v], P[3 * v + 1], P[3 * v + 2]], ax) - lo) / (hi - lo); return t > 0.1 && t < 0.9; };
  const mid = C.refineSymmetry(mesh, { normal: n, d, point: M2.fit.point }, { ...opts, perpTo: M1.fit.normal, sourceFilter: keep });
  console.log(`refit on the middle 80% only: ${ang(mid.fit.normal, n).toFixed(4)}° and ${Math.abs(V.dot(n, V.sub(mid.fit.point, M2.fit.point))).toFixed(4)} mm from the whole-part fit`);
}
