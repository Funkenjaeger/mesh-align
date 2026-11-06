// How a plane fit on a real scan moves with tolerance, and a curved-face signal:
// boundary vertices whose normal still agrees with the plane but which sit outside the band.
import { readFileSync } from 'node:fs';
import { unzipSync } from '../node_modules/three/examples/jsm/libs/fflate.module.js';
import * as C from '../src/core.js';

const load = (f) => {
  const files = unzipSync(new Uint8Array(readFileSync(f)), { filter: (x) => /\.model$|\.rels$/i.test(x.name) });
  const m = C.parse3MF(files);
  return C.prepareMesh(m.positions, m.indices);
};
const ang = (a, b) => (Math.acos(Math.min(1, Math.abs(C.vec.dot(a, b)))) * 180) / Math.PI;

function bendRatio(mesh, r, cosA) {
  const inR = new Uint8Array(mesh.nV);
  for (const v of r.vertices) inR[v] = 1;
  const n = r.fit.normal, N = mesh.normals;
  let bend = 0, edge = 0;
  const seen = new Uint8Array(mesh.nV);
  for (const v of r.vertices) for (let k = mesh.adjStart[v]; k < mesh.adjStart[v + 1]; k++) {
    const w = mesh.adj[k];
    if (inR[w] || seen[w]) continue;
    seen[w] = 1;
    const c = N[3 * w] * n[0] + N[3 * w + 1] * n[1] + N[3 * w + 2] * n[2];
    if (c >= cosA) bend++; else edge++;
  }
  return bend / Math.max(1, bend + edge);
}

const cases = [['v1410', [73010, 9297, 427687]], ['rockit', [3859, 329189]], ['xb8', [1285921, 742431]]];
for (const [name, seeds] of cases) {
  const mesh = load(`${process.env.MESH_ALIGN_SCANS || 'scans'}/${name}.3mf`);
  for (const s of seeds) {
    let ref = null;
    const row = [];
    for (const tol of [0.1, 0.15, 0.2, 0.3, 0.4]) {
      const r = C.growFeature(mesh, 'plane', s, { tol, maxAngle: 20, seedRadius: 3 });
      if (r.error) { row.push(`tol ${tol}: ${r.error}`); continue; }
      ref = ref || r.fit.normal;
      row.push(`tol ${tol}: n=${r.stats.n} ${r.fit.extent.w.toFixed(0)}x${r.fit.extent.h.toFixed(0)} rms ${r.stats.rms.toFixed(3)} tilt ${ang(ref, r.fit.normal).toFixed(3)}° bend ${bendRatio(mesh, r, Math.cos(Math.PI / 9)).toFixed(2)}`);
    }
    console.log(`${name} seed ${s}\n  ` + row.join('\n  '));
  }
}
