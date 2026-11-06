// Symmetry-based setups for the rounded scans: mirror plane(s) plus a flat end face if there is one.
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8 } from '../node_modules/three/examples/jsm/libs/fflate.module.js';
import * as C from '../src/core.js';
const DIR = process.env.MESH_ALIGN_SCANS || 'scans';  // the scans are not in the repo
const V = C.vec;
const ang = (a, b) => (Math.acos(Math.min(1, Math.abs(V.dot(a, b)))) * 180) / Math.PI;

for (const name of process.argv.slice(2)) {
  const m = C.parse3MF(unzipSync(new Uint8Array(readFileSync(`${DIR}/${name}.3mf`)), { filter: (x) => /\.model$|\.rels$/i.test(x.name) }));
  const mesh = C.prepareMesh(m.positions, m.indices);
  const P = mesh.positions, N = mesh.normals, opts = { tol: 0.2, maxAngle: 20, seedRadius: 3 };
  console.log(`\n${name}`);
  const M1 = C.findSymmetry(mesh, opts);
  console.log(`  M1 normal ${M1.fit.normal.map((x) => x.toFixed(4))}: ${(M1.stats.mirrored * 100).toFixed(1)}% mirrors, rms ${M1.stats.rms.toFixed(3)}`);
  // Second mirror: refine from the best candidate that is roughly perpendicular to M1.
  const cand = M1.candidates.filter((c) => ang(c.normal, M1.fit.normal) > 60).sort((a, b) => b.mirrored - a.mirrored);
  const feats = [{ id: 'M1', name: 'M1', type: 'symmetry', ...M1 }];
  let M2 = null;
  for (const c of cand) {
    const cn = V.unit(V.sub(c.normal, V.scl(M1.fit.normal, V.dot(c.normal, M1.fit.normal))));
    const cen = M1.fit.point;
    const r = C.refineSymmetry(mesh, { normal: cn, d: V.dot(cn, cen) }, opts);
    if (r.error) continue;
    console.log(`  candidate second mirror ${r.fit.normal.map((x) => x.toFixed(3))}: ${(r.stats.mirrored * 100).toFixed(1)}%, ${ang(r.fit.normal, M1.fit.normal).toFixed(2)}° from M1`);
    if (!M2 || r.stats.mirrored > M2.stats.mirrored) M2 = r;
  }
  if (M2 && M2.stats.mirrored > 0.6) feats.push({ id: 'M2', name: 'M2', type: 'symmetry', ...M2 });
  // Long axis = perpendicular to M1 and (if any) M2; else the PCA candidate least like M1 with lowest mirror score.
  const longAx = M2 ? V.unit(V.cross(M1.fit.normal, M2.fit.normal)) : V.unit(cand[cand.length - 1]?.normal || [0, 0, 1]);
  // Flat end faces: grow planes from vertices at each extreme along the long axis whose normal points along it.
  const proj = (v) => V.dot([P[3 * v], P[3 * v + 1], P[3 * v + 2]], longAx);
  let lo = Infinity, hi = -Infinity;
  for (let v = 0; v < mesh.nV; v++) { const t = proj(v); lo = Math.min(lo, t); hi = Math.max(hi, t); }
  const ends = [];
  for (const side of [-1, 1]) {
    let best = null;
    for (let v = 0, tries = 0; v < mesh.nV && tries < 60; v += 97) {
      const t = proj(v), nn = [N[3 * v], N[3 * v + 1], N[3 * v + 2]];
      if ((side < 0 ? t - lo : hi - t) > 0.15 * (hi - lo)) continue;
      if (V.dot(nn, longAx) * side < Math.cos(Math.PI / 12)) continue;
      tries++;
      const r = C.growFeature(mesh, 'plane', v, opts);
      if (r.error) continue;
      if (!best || r.stats.n > best.stats.n) best = r;
    }
    if (best) {
      console.log(`  end ${side < 0 ? 'low' : 'high'}: plane ${best.fit.extent.w.toFixed(1)}x${best.fit.extent.h.toFixed(1)} mm, n=${best.stats.n}, rms ${best.stats.rms.toFixed(3)}, ${best.stats.curved ? 'NOT FLAT' : 'flat'}, ${ang(best.fit.normal, M1.fit.normal).toFixed(2)}° from M1`);
      ends.push({ side, ...best });
    }
  }
  const base = ends.filter((e) => !e.stats.curved).sort((a, b) => b.stats.n - a.stats.n)[0];
  if (base) feats.push({ id: 'B', name: 'B', type: 'plane', ...base });
  const spec = base ? {
    primary: { feature: 'B', axis: 'z', flip: true },
    secondary: { feature: 'M1', to: '', axis: 'x', flip: false },
    origin: { x: { src: 'f:M1' }, y: { src: M2 && feats.find((f) => f.id === 'M2') ? 'f:M2' : 'bbox:mid' }, z: { src: 'f:B' } },
  } : {
    primary: { feature: 'M1', axis: 'x', flip: false },
    secondary: { feature: feats.find((f) => f.id === 'M2') ? 'M2' : 'M1', to: '', axis: 'y', flip: false },
    origin: { x: { src: 'f:M1' }, y: { src: feats.find((f) => f.id === 'M2') ? 'f:M2' : 'bbox:mid' }, z: { src: 'bbox:min' } },
  };
  const r = C.solveAlignment(feats, spec, mesh);
  if (!r.ok) { console.log('  alignment:', r.message); continue; }
  console.log(`  aligned: Z from ${spec.primary.feature}, X from ${spec.secondary.feature} (${r.secondaryAngle.toFixed(3)}° from Z), origin ${r.originFrom.join(' / ')}`);
  const P2 = C.transformPositions(P, r.matrix);
  const ext = [0, 1, 2].map((k) => { let a = Infinity, b = -Infinity; for (let i = k; i < P2.length; i += 3) { a = Math.min(a, P2[i]); b = Math.max(b, P2[i]); } return [a, b]; });
  console.log('  aligned extents: ' + ext.map(([a, b], k) => `${'XYZ'[k]} ${a.toFixed(2)}..${b.toFixed(2)}`).join(', '));
  const tjson = JSON.stringify({ tool: 'Mesh Align', version: 1, source: `${name}.3mf`, units: 'mm', matrix_row_major: r.matrix,
    note: 'aligned = M · [x, y, z, 1], with source coordinates in millimeters', spec,
    features: feats.map((f) => ({ name: f.name, type: f.type, normal: f.fit.normal, point: f.fit.point, stats: f.stats })) });
  const parts = C.build3MF(P2, mesh.indices, { Title: `${name}-aligned`, Application: 'Mesh Align' }, tjson);
  const enc = new TextEncoder(), model = parts['3D/3dmodel.model'].map((c) => enc.encode(c));
  const all = new Uint8Array(model.reduce((a, p) => a + p.length, 0)); let off = 0; for (const p of model) { all.set(p, off); off += p.length; }
  const zip = zipSync({ '[Content_Types].xml': strToU8(parts['[Content_Types].xml']), '_rels/.rels': strToU8(parts['_rels/.rels']), '3D/3dmodel.model': [all, { level: 6 }] });
  writeFileSync(`${DIR}/${name}-aligned.3mf`, zip);
  console.log(`  wrote ${DIR}/${name}-aligned.3mf (${(zip.length / 1e6).toFixed(1)} MB), transform embedded: ${C.readEmbeddedTransform(unzipSync(zip)) === tjson}`);
}
