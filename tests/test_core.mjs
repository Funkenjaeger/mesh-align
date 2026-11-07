// node tests/test_core.mjs : fitting accuracy, alignment recovery, 3MF round trip.
import * as C from '../src/core.js';

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// eig
{
  const e = C.eigSym3([[4, 1, 0.5], [1, 3, 0.2], [0.5, 0.2, 1]]);
  const A = [[4, 1, 0.5], [1, 3, 0.2], [0.5, 0.2, 1]];
  let worst = 0;
  e.vectors.forEach((v, i) => { const Av = A.map((r) => C.vec.dot(r, v)); worst = Math.max(worst, C.vec.len(C.vec.sub(Av, C.vec.scl(v, e.values[i])))); });
  check(worst < 1e-10, `eigSym3 residual ${worst.toExponential(2)}`);
}

const t0 = Date.now();
const part = C.makeSamplePart();
const mesh = C.prepareMesh(part.positions, part.indices);
console.log(`sample: ${mesh.nV} verts, ${mesh.nT} tris, ${Date.now() - t0} ms`);
const opts = { tol: 0.12, maxAngle: 20, seedRadius: 3 };
const feats = [];
const grow = (name, type, probe, expect) => {
  const t = Date.now();
  const r = C.growFeature(mesh, type, C.nearestVertex(mesh, part.probes[probe]), opts);
  if (r.error) { check(false, `${name}: ${r.error}`); return null; }
  const f = { id: name, name, type, ...r };
  feats.push(f);
  console.log(`  ${name} ${type}: n=${r.stats.n} rms=${r.stats.rms.toFixed(4)} max=${r.stats.maxAbs.toFixed(3)}${r.fit.radius ? ' R=' + r.fit.radius.toFixed(4) : ''} (${Date.now() - t} ms)`);
  if (expect) expect(f);
  return f;
};
// Region sizes: bottom face has (61*41) verts; grown region should be nearly all of it.
grow('P1', 'plane', 'bottom', (f) => check(f.stats.n > 2300 && f.stats.n <= 61 * 41, `bottom plane takes the face (${f.stats.n} of ${61 * 41})`));
grow('P2', 'plane', 'left', (f) => check(f.stats.n > 450 && f.stats.n <= 41 * 14, `left plane takes the face (${f.stats.n} of ${41 * 14})`));
grow('P3', 'plane', 'front', (f) => check(!f.stats.curved, `flat face is not flagged curved (grow ${(f.stats.wideGrow * 100).toFixed(1)}%, rms x${f.stats.wideRms.toFixed(2)})`));
grow('C1', 'cylinder', 'bossA', (f) => check(near(f.fit.radius, 10, 0.02), `boss A radius ${f.fit.radius.toFixed(4)} ≈ 10`));
grow('C2', 'cylinder', 'bossB', (f) => check(near(f.fit.radius, 6, 0.02), `boss B radius ${f.fit.radius.toFixed(4)} ≈ 6`));
grow('S1', 'sphere', 'ball', (f) => check(near(f.fit.radius, 6.35, 0.02), `ball radius ${f.fit.radius.toFixed(4)} ≈ 6.35`));
const flatCyl = C.growFeature(mesh, 'cylinder', C.nearestVertex(mesh, part.probes.top), opts);
check(!!flatCyl.error, `cylinder on a flat face is refused: ${flatCyl.error || 'NOT refused'}`);

// Multi-face plane: the two boss tops are separate faces in the plane z = 35.
{
  const T = part.truth;
  const tiltZ = (n) => Math.acos(Math.min(1, Math.abs(T[2][0] * n[0] + T[2][1] * n[1] + T[2][2] * n[2]))) * 180 / Math.PI;
  const zOf = (p) => T[2][0] * p[0] + T[2][1] * p[1] + T[2][2] * p[2] + T[2][3];
  const sv = (k) => C.nearestVertex(mesh, part.probes[k]);
  const a = C.growFeature(mesh, 'plane', sv('bossATop'), opts), b = C.growFeature(mesh, 'plane', sv('bossBTop'), opts);
  const j = C.growPlaneFaces(mesh, [sv('bossATop'), sv('bossBTop')], opts);
  if (a.error || b.error || j.error) check(false, `boss-top planes: ${a.error || b.error || j.error}`);
  else {
    const single = Math.min(tiltZ(a.fit.normal), tiltZ(b.fit.normal)), both = tiltZ(j.fit.normal);
    check(j.stats.faces.length === 2 && j.stats.n === a.stats.n + b.stats.n && j.vertices.length === j.stats.n,
      `two boss tops make one plane of ${j.stats.n} pts (${a.stats.n} + ${b.stats.n})`);
    check(both < 0.01 && both < single / 4 && near(zOf(j.fit.point), 35, 0.005),
      `two faces tilt ${both.toFixed(4)}° vs ${single.toFixed(4)}° for the better face alone; plane at z=${zOf(j.fit.point).toFixed(4)}`);
    check(j.stats.faces.every((f) => Math.abs(f.offset) < 0.005) && !j.stats.curved && j.stats.span > 70,
      `faces sit on the shared plane (offsets ${j.stats.faces.map((f) => f.offset.toFixed(4))} mm), span ${j.stats.span.toFixed(1)} mm`);
    const one = C.growPlaneFaces(mesh, [sv('bossATop')], opts);
    check(one.stats.n === a.stats.n && !one.stats.faces, 'one seed is an ordinary plane');
  }
  const off = C.growPlaneFaces(mesh, [sv('bossATop'), sv('top'), sv('bossBTop')], opts);
  check(off.face === 1 && /sits 10\.0\d\d mm off/.test(off.error || ''), `a face 10 mm below is refused and named: ${off.error}`);
  const same = C.growPlaneFaces(mesh, [sv('bossATop'), C.nearestVertex(mesh, C.vec.add(part.probes.bossATop, [0.5, 0, 0]))], opts);
  check(same.face === 1 && /same face/.test(same.error || ''), `a second click on the same face is refused: ${same.error}`);
  const opp = C.growPlaneFaces(mesh, [sv('top'), sv('bottom')], opts);
  check(opp.face === 1 && /opposite/.test(opp.error || ''), `an opposite-facing face is refused: ${opp.error}`);
  const perp = C.growPlaneFaces(mesh, [sv('bossATop'), sv('bossBTop')], { ...opts, perpTo: feats[1].fit.normal });
  check(!perp.error && Math.abs(C.vec.dot(perp.fit.normal, feats[1].fit.normal)) < 1e-9, 'multi-face plane honors the perpendicular constraint');
}

// Alignment: Z from bottom (flip: outward normal is -Z), X from left (flip), origin from 3 planes.
const errVs = (M, label) => {
  const A = C.transformPositions(mesh.positions, M);
  // Compare against the noise-free original coordinates; noise is along normals, so allow ~5 sigma.
  let worst = 0, ss = 0;
  for (let i = 0; i < A.length; i += 3) {
    // the clean coords are pre-noise; noise displaces up to ~0.1 mm
    const d = Math.hypot(A[i] - part.clean[i], A[i + 1] - part.clean[i + 1], A[i + 2] - part.clean[i + 2]);
    worst = Math.max(worst, d); ss += d * d;
  }
  const rms = Math.sqrt(ss / (A.length / 3));
  check(rms < 0.04 && worst < 0.16, `${label}: rms ${rms.toFixed(4)} mm, worst ${worst.toFixed(3)} mm vs true coordinates`);
};
const spec = {
  primary: { feature: 'P1', axis: 'z', flip: true },
  secondary: { feature: 'P2', to: '', axis: 'x', flip: true },
  origin: { x: { src: 'f:P2' }, y: { src: 'f:P3' }, z: { src: 'f:P1' } },
};
let r = C.solveAlignment(feats, spec, mesh);
check(r.ok, `3 planes solve ${r.ok ? '' : r.message}`);
if (r.ok) {
  errVs(r.matrix, '3-plane alignment');
  check(near(r.secondaryAngle, 90, 0.05), `secondary angle ${r.secondaryAngle.toFixed(3)}°`);
  // Compare matrix to truth
  let dm = 0; for (let a = 0; a < 3; a++) for (let b = 0; b < 4; b++) dm = Math.max(dm, Math.abs(r.matrix[a][b] - part.truth[a][b]) * (b === 3 ? 1 : 100));
  check(dm < 0.05, `matrix matches the true inverse pose (score ${dm.toFixed(4)})`);
}
// X along the line from boss A to boss B; origin X,Y from boss A axis, Z from bottom.
r = C.solveAlignment(feats, {
  primary: { feature: 'P1', axis: 'z', flip: true },
  secondary: { feature: 'C1', to: 'C2', axis: 'x', flip: false },
  origin: { x: { src: 'f:C1' }, y: { src: 'f:C1' }, z: { src: 'f:P1' } },
}, mesh);
check(r.ok, `boss line solve ${r.ok ? '' : r.message}`);
if (r.ok) {
  const shift = [[1, 0, 0, 30], [0, 1, 0, 40], [0, 0, 1, 0], [0, 0, 0, 1]];
  const M = shift.map((row) => [0, 1, 2, 3].map((j) => row.reduce((s, x, k) => s + x * r.matrix[k][j], 0)));
  errVs(M, 'boss-line alignment (+30,+40 shift)');
}
// Primary from a cylinder axis (boss A), secondary from the left plane.
r = C.solveAlignment(feats, {
  primary: { feature: 'C1', axis: 'z', flip: false },
  secondary: { feature: 'P2', to: '', axis: 'x', flip: true },
  origin: { x: { src: 'f:P2' }, y: { src: 'f:P3' }, z: { src: 'f:P1' } },
}, mesh);
check(r.ok && near(r.axes[2][0] * part.truth[2][0] + r.axes[2][1] * part.truth[2][1] + r.axes[2][2] * part.truth[2][2], 1, 1e-4), 'cylinder axis as primary gives +Z');
// Errors
r = C.solveAlignment(feats, { primary: { feature: 'P1', axis: 'z' }, secondary: { feature: 'P1', axis: 'x' }, origin: {} }, mesh);
check(!r.ok && /parallel/.test(r.message), `parallel secondary refused: ${r.message}`);
r = C.solveAlignment(feats, { primary: { feature: 'S1', axis: 'z' }, secondary: { feature: 'P2', axis: 'x' }, origin: {} }, mesh);
check(!r.ok && /no direction/.test(r.message), `sphere primary refused: ${r.message}`);
r = C.solveAlignment(feats, { primary: { feature: 'P1', axis: 'z', flip: true }, secondary: { feature: 'P2', axis: 'x', flip: true }, origin: { x: { src: 'f:P1' } } }, mesh);
check(!r.ok && /does not face/.test(r.message), `wrong-facing origin plane refused: ${r.message}`);
r = C.solveAlignment(feats, { primary: { feature: 'P1', axis: 'z', flip: true }, secondary: { feature: 'P2', axis: 'x', flip: true }, origin: {} }, mesh);
if (r.ok) {
  const A = C.transformPositions(mesh.positions, r.matrix);
  let mn = [Infinity, Infinity, Infinity];
  for (let i = 0; i < A.length; i += 3) for (let k = 0; k < 3; k++) mn[k] = Math.min(mn[k], A[i + k]);
  check(mn.every((x) => Math.abs(x) < 1e-3), `bbox-min origin puts min at 0 (${mn.map((x) => x.toFixed(4))})`);
}
// Symmetry: the block mirrors about y = 40 (bosses on the center line; only the ball breaks it).
{
  const T = part.truth;
  const toOrig = (n, p) => {
    const no = [0, 1, 2].map((r) => T[r][0] * n[0] + T[r][1] * n[1] + T[r][2] * n[2]);
    const po = [0, 1, 2].map((r) => T[r][0] * p[0] + T[r][1] * p[1] + T[r][2] * p[2] + T[r][3]);
    return { no, po };
  };
  const judge = (label, r) => {
    if (r.error) { check(false, `${label}: ${r.error}`); return; }
    const { no, po } = toOrig(r.fit.normal, r.fit.point);
    const tilt = Math.acos(Math.min(1, Math.abs(no[1]))) * 180 / Math.PI;
    check(tilt < 0.02 && Math.abs(po[1] - 40) < 0.02, `${label}: tilt ${tilt.toFixed(4)}°, plane at y=${po[1].toFixed(4)}, mirrored ${(r.stats.mirrored * 100).toFixed(1)}%, rms ${r.stats.rms.toFixed(4)}`);
  };
  let t = Date.now();
  judge('symmetry from two clicks', C.symmetryFromPoints(mesh, part.probes.front, part.probes.back, { tol: 0.15 }));
  // Deliberately poor start: 6° off and 4 mm shifted.
  const n0 = C.vec.unit(C.vec.add(C.vec.sub(part.probes.back, part.probes.front), C.vec.scl(C.vec.sub(part.probes.right, part.probes.left), 0.105 * 80 / 120)));
  const mid = C.vec.scl(C.vec.add(part.probes.front, part.probes.back), 0.5);
  judge('symmetry from a 6° / 4 mm-off start', C.refineSymmetry(mesh, { normal: n0, d: C.vec.dot(n0, mid) + 4 }, { tol: 0.15 }));
  const auto = C.findSymmetry(mesh, { tol: 0.15 });
  judge('automatic symmetry', auto);
  console.log(`  symmetry runs took ${Date.now() - t} ms; candidates ${auto.candidates?.map((c) => (c.mirrored * 100).toFixed(0) + '%').join(' ')}`);
  // Perpendicular to a reference: the block's other mirror (x = 60) is broken by the unequal bosses,
  // so search perpendicular to the bottom face, then constrain a two-click pick perpendicular to M (y=40).
  const nB = feats[0].fit.normal;
  const perp = C.findSymmetryPerp(mesh, nB, { tol: 0.15 });
  if (perp.error) check(false, `perpendicular search: ${perp.error}`);
  else {
    const d0 = Math.abs(C.vec.dot(perp.fit.normal, nB));
    check(d0 < 1e-9, `perpendicular search result is exactly perpendicular (|n·nB| = ${d0.toExponential(1)}), mirrors ${(perp.stats.mirrored * 100).toFixed(1)}%`);
  }
  const yPlane = auto.fit.normal;
  const xm = C.symmetryFromPoints(mesh, part.probes.left, part.probes.right, { tol: 0.15, perpTo: yPlane });
  if (xm.error) check(false, `constrained two-click: ${xm.error}`);
  else {
    const { no, po } = toOrig(xm.fit.normal, xm.fit.point);
    check(Math.abs(C.vec.dot(xm.fit.normal, yPlane)) < 1e-9 && Math.abs(no[1]) < 1e-4, `constrained two-click is perpendicular to M (x-plane at x=${po[0].toFixed(3)}, mirrors ${(xm.stats.mirrored * 100).toFixed(1)}%)`);
  }
  // Constrained plane fit: the left face, forced perpendicular to the bottom face.
  const lp = C.growFeature(mesh, 'plane', C.nearestVertex(mesh, part.probes.left), { tol: 0.12, perpTo: nB });
  check(!lp.error && Math.abs(C.vec.dot(lp.fit.normal, nB)) < 1e-9, `plane fit constrained perpendicular to the bottom (|n·nB| = ${lp.error ? lp.error : Math.abs(C.vec.dot(lp.fit.normal, nB)).toExponential(1)})`);
  // as an alignment plane
  const sf = { id: 'M1', name: 'M1', type: 'symmetry', ...auto };
  const r = C.solveAlignment([...feats, sf], { primary: { feature: 'P1', axis: 'z', flip: true }, secondary: { feature: 'M1', axis: 'y' }, origin: { x: { src: 'f:P2' }, y: { src: 'f:M1' }, z: { src: 'f:P1' } } }, mesh);
  check(r.ok, `symmetry plane works as secondary and Y origin ${r.ok ? '' : r.message}`);
}
// Trim: in the aligned frame cut everything below z = 25 (the block body), keep bosses and ball.
{
  const r = C.solveAlignment(feats, spec, mesh);
  const z = C.frameCoord(mesh.positions, r.matrix, 2);
  const rem = C.cutMask(z, 25.2, false);
  const nCut = C.countCutTris(mesh.indices, rem);
  const tr = C.trimMesh(mesh.positions, mesh.indices, rem);
  const z2 = C.frameCoord(tr.positions, r.matrix, 2);
  let lo = Infinity; for (const x of z2) lo = Math.min(lo, x);
  check(tr.removedTris === nCut && tr.indices.length / 3 === mesh.nT - nCut && lo >= 25.2,
    `trim below z=25.2 removes ${nCut} of ${mesh.nT} triangles; lowest kept vertex z=${lo.toFixed(3)}`);
  let okMap = true;
  for (let v = 0; v < mesh.nV; v += 97) if (tr.map[v] >= 0) for (let k = 0; k < 3; k++) if (tr.positions[3 * tr.map[v] + k] !== mesh.positions[3 * v + k]) okMap = false;
  check(okMap, 'trim vertex map points at the same coordinates');
}
check(C.checkRigid(part.truth) === null, 'checkRigid accepts a rigid matrix');
check(C.checkRigid([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, -1, 0], [0, 0, 0, 1]]) !== null, 'checkRigid refuses a mirror');

// 3MF round trip with inch units, a component transform and a build transform.
{
  const enc = new TextEncoder();
  const tjson = JSON.stringify({ matrix_row_major: part.truth, note: 'a < b & "c"' });
  const parts = C.build3MF(mesh.positions, mesh.indices, { Title: 'test & <check>' }, tjson);
  const xml = parts['3D/3dmodel.model'].join('');
  const back = C.parse3MF({ '_rels/.rels': enc.encode(parts['_rels/.rels']), '3D/3dmodel.model': enc.encode(xml) });
  let worst = 0; for (let i = 0; i < back.positions.length; i++) worst = Math.max(worst, Math.abs(back.positions[i] - mesh.positions[i]));
  check(back.metadata['meshalign:transform'] === tjson && back.metadata.Title === 'test & <check>', '3MF metadata round trip (transform JSON and title)');
  check(C.readEmbeddedTransform({ '3D/3dmodel.model': enc.encode(xml) }) === tjson, 'embedded transform read without parsing the mesh');
  check(back.positions.length === mesh.positions.length && back.indices.length === mesh.indices.length && worst < 2e-5, `3MF mm round trip (worst ${worst.toExponential(2)})`);

  const inch = `<?xml version="1.0"?><model unit="inch" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><!-- a > comment -->
<resources><object id="2" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x='1' y="0" z="0" /><vertex x="0" y="1" z="0"/></vertices>
<triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>
<object id="3" type="model"><components><component objectid="2" transform="1 0 0 0 1 0 0 0 1 2 0 0"/></components></object></resources>
<build><item objectid="3" transform="0 1 0 -1 0 0 0 0 1 0 0 1"/></build></model>`;
  const m = C.parse3MF({ '3D/x.model': enc.encode(inch) });
  // vertex (1,0,0) -> component +2 x -> (3,0,0) -> build: rotate 90° about Z (x'=-y, y'=x), +1 z -> (0,3,1) inch
  const p = [...m.positions.slice(3, 6)].map((x) => x / 25.4);
  check(m.unit === 'inch' && near(p[0], 0, 1e-6) && near(p[1], 3, 1e-6) && near(p[2], 1, 1e-6), `3MF inch + transforms -> ${p.map((x) => x.toFixed(4))}`);
}
// weld
{
  const soup = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const w = C.weldVertices(soup);
  check(w.positions.length === 12 && w.indices.length === 6, `weld merges shared corners (${w.positions.length / 3} verts)`);
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
