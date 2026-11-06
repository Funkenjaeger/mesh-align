// Mesh Align core: mesh prep, feature fitting, 3-2-1 alignment and 3MF I/O.
// Pure JS: no DOM, no three.js, so the same file runs in the page and in node tests.
// All lengths are millimeters once a mesh is loaded.

export const UNIT_MM = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

// ---------------------------------------------------------------- vectors
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const vec = { dot, cross, sub, add, scl, len, unit };

function perpBasis(a) {
  const t = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(a, t));
  return [u, cross(a, u)];
}

// Make the largest component positive, so an axis has a stable sign.
function canonical(a) {
  let k = 0;
  if (Math.abs(a[1]) > Math.abs(a[k])) k = 1;
  if (Math.abs(a[2]) > Math.abs(a[k])) k = 2;
  return a[k] < 0 ? scl(a, -1) : a;
}

// ---------------------------------------------------------------- linear algebra
// Symmetric 3x3 eigen-decomposition by cyclic Jacobi. Values ascending.
export function eigSym3(m) {
  const a = [m[0].slice(), m[1].slice(), m[2].slice()];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    const diag = a[0][0] ** 2 + a[1][1] ** 2 + a[2][2] ** 2;
    if (off <= 1e-30 * diag || off === 0) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (a[p][q] === 0) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y; }
    }
  }
  const idx = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return { values: idx.map((i) => a[i][i]), vectors: idx.map((i) => [v[0][i], v[1][i], v[2][i]]) };
}

// Solve A x = b (A n x n, arrays of rows) by Gaussian elimination. null if singular.
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x.every(Number.isFinite) ? x : null;
}

// ---------------------------------------------------------------- mesh prep
// Merge coincident vertices of a triangle soup (STL, OBJ). tol in mm.
export function weldVertices(soup, tol = 1e-4) {
  const n = soup.length / 3;
  let cap = 1;
  while (cap < n * 2) cap <<= 1;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const qx = new Int32Array(n), qy = new Int32Array(n), qz = new Int32Array(n);
  const out = new Float32Array(soup.length);
  const map = new Uint32Array(n);
  const inv = 1 / tol;
  let u = 0;
  for (let i = 0; i < n; i++) {
    const x = soup[3 * i], y = soup[3 * i + 1], z = soup[3 * i + 2];
    const ix = Math.round(x * inv), iy = Math.round(y * inv), iz = Math.round(z * inv);
    let h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & mask;
    for (;;) {
      const e = table[h];
      if (e === -1) {
        table[h] = u; qx[u] = ix; qy[u] = iy; qz[u] = iz;
        out[3 * u] = x; out[3 * u + 1] = y; out[3 * u + 2] = z;
        map[i] = u++;
        break;
      }
      if (qx[e] === ix && qy[e] === iy && qz[e] === iz) { map[i] = e; break; }
      h = (h + 1) & mask;
    }
  }
  return { positions: out.slice(0, 3 * u), indices: dropDegenerate(map), map };
}

export function dropDegenerate(indices) {
  let k = 0;
  const out = new Uint32Array(indices.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    if (a === b || b === c || a === c) continue;
    out[k++] = a; out[k++] = b; out[k++] = c;
  }
  return out.slice(0, k);
}

// Normals (area weighted), vertex adjacency (CSR) and bounds.
export function prepareMesh(positions, indices) {
  const nV = positions.length / 3, nT = indices.length / 3;
  const P = positions;
  const normals = new Float32Array(nV * 3);
  const deg = new Uint32Array(nV + 1);
  for (let t = 0; t < nT; t++) {
    const a = indices[3 * t], b = indices[3 * t + 1], c = indices[3 * t + 2];
    const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
    const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const w of [a, b, c]) { normals[3 * w] += nx; normals[3 * w + 1] += ny; normals[3 * w + 2] += nz; }
    deg[a + 1] += 2; deg[b + 1] += 2; deg[c + 1] += 2;
  }
  for (let i = 0; i < nV; i++) {
    const x = normals[3 * i], y = normals[3 * i + 1], z = normals[3 * i + 2];
    const l = Math.hypot(x, y, z) || 1;
    normals[3 * i] = x / l; normals[3 * i + 1] = y / l; normals[3 * i + 2] = z / l;
  }
  const adjStart = deg;
  for (let i = 0; i < nV; i++) adjStart[i + 1] += adjStart[i];
  const fill = adjStart.slice(0, nV);
  const adj = new Uint32Array(adjStart[nV]);
  for (let t = 0; t < nT; t++) {
    const a = indices[3 * t], b = indices[3 * t + 1], c = indices[3 * t + 2];
    adj[fill[a]++] = b; adj[fill[a]++] = c;
    adj[fill[b]++] = a; adj[fill[b]++] = c;
    adj[fill[c]++] = a; adj[fill[c]++] = b;
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nV; i++) for (let k = 0; k < 3; k++) {
    const x = P[3 * i + k];
    if (x < min[k]) min[k] = x;
    if (x > max[k]) max[k] = x;
  }
  return { positions, indices, normals, nV, nT, adjStart, adj, bbox: { min, max },
    stamp: new Uint32Array(nV), gen: 0 };
}

// Connected flood fill from seeds over vertices that pass accept(v).
function flood(mesh, seeds, accept) {
  mesh.gen++;
  if (mesh.gen >= 0xfffffff0) { mesh.stamp.fill(0); mesh.gen = 1; }
  const g = mesh.gen, st = mesh.stamp, { adjStart, adj } = mesh;
  const out = [];
  for (const s of seeds) {
    if (st[s] === g) continue;
    st[s] = g;
    if (accept(s)) out.push(s);
  }
  for (let head = 0; head < out.length; head++) {
    const v = out[head];
    for (let k = adjStart[v], e = adjStart[v + 1]; k < e; k++) {
      const w = adj[k];
      if (st[w] === g) continue;
      st[w] = g;
      if (accept(w)) out.push(w);
    }
  }
  return out;
}

const pt = (P, v) => [P[3 * v], P[3 * v + 1], P[3 * v + 2]];

function subsample(idx, max) {
  if (idx.length <= max) return idx;
  const step = idx.length / max, out = new Array(max);
  for (let i = 0; i < max; i++) out[i] = idx[Math.floor(i * step)];
  return out;
}

function centroid(P, idx) {
  let x = 0, y = 0, z = 0;
  for (const v of idx) { x += P[3 * v]; y += P[3 * v + 1]; z += P[3 * v + 2]; }
  const n = idx.length || 1;
  return [x / n, y / n, z / n];
}

// ---------------------------------------------------------------- fits
function fitPlane(P, N, idx, perpTo) {
  const c = centroid(P, idx);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const v of idx) {
    const x = P[3 * v] - c[0], y = P[3 * v + 1] - c[1], z = P[3 * v + 2] - c[2];
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  const C3 = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]];
  let n;
  if (perpTo) {  // normal restricted to the plane perpendicular to perpTo: 2x2 problem in that plane
    const [b1, b2] = perpBasis(unit(perpTo));
    const q = (x, y) => dot(x, [dot(C3[0], y), dot(C3[1], y), dot(C3[2], y)]);
    const p11 = q(b1, b1), p12 = q(b1, b2), p22 = q(b2, b2);
    const th = 0.5 * Math.atan2(2 * p12, p11 - p22);
    const m1 = add(scl(b1, Math.cos(th)), scl(b2, Math.sin(th))), m2 = add(scl(b1, -Math.sin(th)), scl(b2, Math.cos(th)));
    n = q(m1, m1) < q(m2, m2) ? m1 : m2;
  } else n = eigSym3(C3).vectors[0];
  let s = 0;
  for (const v of idx) s += N[3 * v] * n[0] + N[3 * v + 1] * n[1] + N[3 * v + 2] * n[2];
  if (s < 0) n = scl(n, -1);
  return { type: 'plane', point: c, normal: unit(n) };
}

function cylResiduals(P, sub, a, c, R, out) {
  let ss = 0;
  for (let i = 0; i < sub.length; i++) {
    const v = sub[i];
    const dx = P[3 * v] - c[0], dy = P[3 * v + 1] - c[1], dz = P[3 * v + 2] - c[2];
    const t = dx * a[0] + dy * a[1] + dz * a[2];
    const px = dx - t * a[0], py = dy - t * a[1], pz = dz - t * a[2];
    const r = Math.sqrt(px * px + py * py + pz * pz) - R;
    out[i] = r; ss += r * r;
  }
  return ss;
}

// Levenberg-Marquardt on (axis tilt 2, axis offset 2, radius 1).
function refineCylinder(P, sub, a, c, R) {
  const m = sub.length, cen = centroid(P, sub);
  const r0 = new Float64Array(m), rt = new Float64Array(m);
  const J = [0, 1, 2, 3, 4].map(() => new Float64Array(m));
  let cost = cylResiduals(P, sub, a, c, R, r0), lambda = 1e-3;
  const make = (u, v, d) => [unit(add(a, add(scl(u, d[0]), scl(v, d[1])))),
    add(c, add(scl(u, d[2]), scl(v, d[3]))), R + d[4]];
  for (let it = 0; it < 50; it++) {
    const [u, v] = perpBasis(a);
    const sc = Math.max(R, 1);
    const h = [1e-6, 1e-6, 1e-6 * sc, 1e-6 * sc, 1e-6 * sc];
    for (let k = 0; k < 5; k++) {
      const d = [0, 0, 0, 0, 0]; d[k] = h[k];
      const [a2, c2, R2] = make(u, v, d);
      cylResiduals(P, sub, a2, c2, R2, rt);
      for (let i = 0; i < m; i++) J[k][i] = (rt[i] - r0[i]) / h[k];
    }
    const JTJ = [0, 1, 2, 3, 4].map(() => new Array(5).fill(0)), JTr = new Array(5).fill(0);
    for (let p = 0; p < 5; p++) {
      for (let q = p; q < 5; q++) { let s = 0; for (let i = 0; i < m; i++) s += J[p][i] * J[q][i]; JTJ[p][q] = JTJ[q][p] = s; }
      let s = 0; for (let i = 0; i < m; i++) s += J[p][i] * r0[i]; JTr[p] = s;
    }
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const A = JTJ.map((row, i) => row.map((x, j) => (i === j ? x * (1 + lambda) + 1e-12 : x)));
      const d = solveLinear(A, JTr.map((x) => -x));
      if (!d) { lambda *= 10; continue; }
      const [a2, c2, R2] = make(u, v, d);
      const cost2 = cylResiduals(P, sub, a2, c2, R2, rt);
      if (cost2 < cost) {
        const rel = (cost - cost2) / (cost || 1);
        a = a2; R = R2;
        c = add(c2, scl(a2, dot(sub_(cen, c2), a2)));  // keep c at the axis point nearest the centroid
        cost = cylResiduals(P, sub, a, c, R, r0);
        lambda = Math.max(lambda / 3, 1e-9);
        improved = rel > 1e-12;
        break;
      }
      lambda *= 4;
    }
    if (!improved) break;
  }
  return { a, c, R };
}
const sub_ = sub;

function fitCylinder(P, N, idx, prev) {
  const s = subsample(idx, 20000);
  let a;
  if (prev) a = prev.axis;
  else {
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (const v of s) {
      const x = N[3 * v], y = N[3 * v + 1], z = N[3 * v + 2];
      xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
    }
    const e = eigSym3([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]]);
    if (e.values[1] / e.values[2] < 0.003) return { error: 'flat' };
    a = e.vectors[0];
  }
  const cen = centroid(P, s);
  const [u, v] = perpBasis(a);
  // Kasa circle fit in the plane across the axis.
  let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, Sxz = 0, Syz = 0, Sz = 0;
  for (const w of s) {
    const d = sub(pt(P, w), cen);
    const x = dot(d, u), y = dot(d, v), z = x * x + y * y;
    Sxx += x * x; Sxy += x * y; Syy += y * y; Sx += x; Sy += y; Sxz += x * z; Syz += y * z; Sz += z;
  }
  const sol = solveLinear([[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, s.length]], [-Sxz, -Syz, -Sz]);
  if (!sol) return { error: 'flat' };
  const cx = -sol[0] / 2, cy = -sol[1] / 2, R0 = Math.sqrt(cx * cx + cy * cy - sol[2]);
  if (!Number.isFinite(R0)) return { error: 'flat' };
  const c0 = add(cen, add(scl(u, cx), scl(v, cy)));
  const r = refineCylinder(P, s, a, c0, R0);
  return { type: 'cylinder', axis: canonical(r.a), point: r.c, radius: Math.abs(r.R) };
}

function fitSphere(P, N, idx) {
  const s = subsample(idx, 20000);
  const cen = centroid(P, s);
  const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], b = [0, 0, 0, 0];
  for (const w of s) {
    const d = sub(pt(P, w), cen), row = [d[0], d[1], d[2], 1], z = -dot(d, d);
    for (let i = 0; i < 4; i++) { b[i] += row[i] * z; for (let j = 0; j < 4; j++) A[i][j] += row[i] * row[j]; }
  }
  const sol = solveLinear(A, b);
  if (!sol) return { error: 'flat' };
  let c = add(cen, [-sol[0] / 2, -sol[1] / 2, -sol[2] / 2]);
  let R = Math.sqrt(dot(sub(c, cen), sub(c, cen)) - sol[3]);
  if (!Number.isFinite(R)) return { error: 'flat' };
  for (let it = 0; it < 30; it++) {  // Gauss-Newton on geometric distance
    const JTJ = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], JTr = [0, 0, 0, 0];
    for (const w of s) {
      const d = sub(pt(P, w), c), l = len(d) || 1e-12, r = l - R;
      const j = [-d[0] / l, -d[1] / l, -d[2] / l, -1];
      for (let p = 0; p < 4; p++) { JTr[p] += j[p] * r; for (let q = 0; q < 4; q++) JTJ[p][q] += j[p] * j[q]; }
    }
    const d = solveLinear(JTJ, JTr.map((x) => -x));
    if (!d) break;
    c = add(c, [d[0], d[1], d[2]]); R += d[3];
    if (Math.hypot(...d) < 1e-9) break;
  }
  return { type: 'sphere', center: c, radius: Math.abs(R) };
}

function residualFn(fit) {
  if (fit.type === 'plane') {
    const [nx, ny, nz] = fit.normal, d = dot(fit.normal, fit.point);
    return (P, v) => nx * P[3 * v] + ny * P[3 * v + 1] + nz * P[3 * v + 2] - d;
  }
  if (fit.type === 'cylinder') {
    const [a0, a1, a2] = fit.axis, [c0, c1, c2] = fit.point, R = fit.radius;
    return (P, v) => {
      const dx = P[3 * v] - c0, dy = P[3 * v + 1] - c1, dz = P[3 * v + 2] - c2;
      const t = dx * a0 + dy * a1 + dz * a2;
      const px = dx - t * a0, py = dy - t * a1, pz = dz - t * a2;
      return Math.sqrt(px * px + py * py + pz * pz) - R;
    };
  }
  const [c0, c1, c2] = fit.center, R = fit.radius;
  return (P, v) => Math.hypot(P[3 * v] - c0, P[3 * v + 1] - c1, P[3 * v + 2] - c2) - R;
}

// Does the vertex normal agree with the surface normal the fit predicts?
function normalFn(fit, cosA) {
  if (fit.type === 'plane') {
    const [nx, ny, nz] = fit.normal;
    return (P, N, v) => N[3 * v] * nx + N[3 * v + 1] * ny + N[3 * v + 2] * nz >= cosA;
  }
  if (fit.type === 'cylinder') {
    const [a0, a1, a2] = fit.axis, [c0, c1, c2] = fit.point;
    return (P, N, v) => {
      const dx = P[3 * v] - c0, dy = P[3 * v + 1] - c1, dz = P[3 * v + 2] - c2;
      const t = dx * a0 + dy * a1 + dz * a2;
      const px = dx - t * a0, py = dy - t * a1, pz = dz - t * a2;
      const l = Math.sqrt(px * px + py * py + pz * pz) || 1e-12;
      return Math.abs(N[3 * v] * px + N[3 * v + 1] * py + N[3 * v + 2] * pz) / l >= cosA;
    };
  }
  const [c0, c1, c2] = fit.center;
  return (P, N, v) => {
    const dx = P[3 * v] - c0, dy = P[3 * v + 1] - c1, dz = P[3 * v + 2] - c2;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-12;
    return Math.abs(N[3 * v] * dx + N[3 * v + 1] * dy + N[3 * v + 2] * dz) / l >= cosA;
  };
}

function fitOf(type, P, N, idx, prev) {
  if (type === 'plane') return fitPlane(P, N, idx, prev?.perpTo);
  if (type === 'cylinder') return fitCylinder(P, N, idx, prev);
  return fitSphere(P, N, idx);
}

const FLAT_MSG = {
  cylinder: 'That patch is too flat to define a cylinder. Click on the curved surface, or raise the seed radius.',
  sphere: 'That patch is too flat to define a sphere. Click on the ball itself, or raise the seed radius.',
};

// Grow a feature region from a clicked vertex and fit it.
// opts: tol (mm, max distance from the fitted surface), maxAngle (deg, vertex normal vs surface),
// seedRadius (mm, size of the first patch).
export function growFeature(mesh, type, seed, opts = {}) {
  const tol = opts.tol ?? 0.2, cosA = Math.cos(((opts.maxAngle ?? 20) * Math.PI) / 180);
  const P = mesh.positions, N = mesh.normals, sp = pt(P, seed);
  const minPts = type === 'plane' ? 12 : 30;
  const d2 = (v) => (P[3 * v] - sp[0]) ** 2 + (P[3 * v + 1] - sp[1]) ** 2 + (P[3 * v + 2] - sp[2]) ** 2;

  // 1. First patch: everything connected to the seed within the seed radius.
  let r = Math.max(opts.seedRadius ?? 3, 1e-3), region = null, fit = null;
  for (let tries = 0; tries < 14; tries++) {
    const rr = r * r;
    region = flood(mesh, [seed], (v) => d2(v) <= rr);
    if (region.length >= minPts) {
      fit = fitOf(type, P, N, region, type === 'plane' ? { perpTo: opts.perpTo } : undefined);
      if (!fit.error) break;
      if (type === 'plane') break;
    }
    fit = null;
    r *= 1.5;
  }
  if (!fit) return { error: FLAT_MSG[type] || 'Not enough mesh around that point to fit a plane.' };
  if (fit.error) return { error: FLAT_MSG[type] };

  // 2. Grow: widen the radius, accept points near the current fit, refit. Loose tolerance first.
  let lastCount = 0, stable = 0;
  for (let it = 0; it < 24; it++) {
    const unlimited = it >= 8 || stable >= 2;
    const lim = unlimited ? Infinity : (r *= 2) ** 2;
    const t = tol * Math.max(1, 4 / 2 ** it);
    const res = residualFn(fit), nok = normalFn(fit, cosA);
    const accept = (v) => (lim === Infinity || d2(v) <= lim) && Math.abs(res(P, v)) <= t && nok(P, N, v);
    let seeds = region.filter(accept);
    if (!seeds.length) seeds = accept(seed) ? [seed] : [];
    if (!seeds.length) return { error: 'The fit drifted away from where you clicked. Try a larger tolerance or a different spot.' };
    const next = flood(mesh, seeds, accept);
    if (next.length < minPts) return { error: 'Too few points stay within tolerance. Raise the tolerance or click a cleaner area.' };
    const nf = fitOf(type, P, N, next, type === 'cylinder' ? fit : type === 'plane' ? { perpTo: opts.perpTo } : undefined);
    if (nf.error) return { error: FLAT_MSG[type] };
    const changed = Math.abs(next.length - lastCount) > Math.max(2, next.length * 5e-4);
    region = next; fit = nf;
    if (!changed) stable++; else stable = 0;
    lastCount = next.length;
    if (unlimited && !changed && t === tol) break;
  }

  // 3. Sanity: a curved fit far bigger than its own patch is really a flat patch.
  const ext = extentOf(P, region);
  if ((type === 'cylinder' || type === 'sphere') && fit.radius > 40 * ext) return { error: FLAT_MSG[type] };

  const res = residualFn(fit);
  let ss = 0, mx = 0, lo = Infinity, hi = -Infinity;
  for (const v of region) { const e = res(P, v); ss += e * e; mx = Math.max(mx, Math.abs(e)); lo = Math.min(lo, e); hi = Math.max(hi, e); }
  const stats = { n: region.length, rms: Math.sqrt(ss / region.length), maxAbs: mx, pv: hi - lo };
  if (type === 'plane') {
    // Curvature check: a flat face barely grows at double tolerance; a curved one keeps
    // taking surface and its error grows with it.
    const nok = normalFn(fit, cosA);
    const wide = flood(mesh, region, (v) => Math.abs(res(P, v)) <= 2 * tol && nok(P, N, v));
    let ss2 = 0;
    for (const v of wide) { const e = res(P, v); ss2 += e * e; }
    stats.wideGrow = wide.length / region.length - 1;
    stats.wideRms = Math.sqrt(ss2 / wide.length) / (stats.rms || 1e-12);
    stats.curved = stats.wideGrow > 0.08 && stats.wideRms > 1.35;
  }
  finishFit(fit, P, region);
  return { fit, vertices: Uint32Array.from(region), stats };
}

function extentOf(P, idx) {
  const c = centroid(P, idx);
  let m = 0;
  for (const v of subsample(idx, 5000)) m = Math.max(m, len(sub(pt(P, v), c)));
  return m;
}

// Add display geometry: plane rectangle, cylinder span along its axis.
function finishFit(fit, P, idx) {
  const s = subsample(idx, 50000);
  if (fit.type === 'plane') {
    const [u, v] = perpBasis(fit.normal);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const w of s) {
      const d = sub(pt(P, w), fit.point), x = dot(d, u), y = dot(d, v);
      u0 = Math.min(u0, x); u1 = Math.max(u1, x); v0 = Math.min(v0, y); v1 = Math.max(v1, y);
    }
    fit.extent = { center: add(fit.point, add(scl(u, (u0 + u1) / 2), scl(v, (v0 + v1) / 2))), u, v, w: u1 - u0, h: v1 - v0 };
  } else if (fit.type === 'cylinder') {
    let t0 = Infinity, t1 = -Infinity;
    for (const w of s) { const t = dot(sub(pt(P, w), fit.point), fit.axis); t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
    fit.center = add(fit.point, scl(fit.axis, (t0 + t1) / 2));
    fit.length = t1 - t0;
  }
}

// ---------------------------------------------------------------- symmetry plane
// Uniform grid over a vertex subset for nearest-vertex queries.
function buildGrid(P, ids, h) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const v of ids) for (let k = 0; k < 3; k++) { const x = P[3 * v + k]; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; }
  const vol = (max[0] - min[0] + h) * (max[1] - min[1] + h) * (max[2] - min[2] + h);
  h = Math.max(h, Math.cbrt(vol / 8e6));
  const dims = [0, 1, 2].map((k) => Math.floor((max[k] - min[k]) / h) + 1);
  const ncell = dims[0] * dims[1] * dims[2];
  const cellOf = (v) => {
    const ix = Math.min(dims[0] - 1, Math.floor((P[3 * v] - min[0]) / h));
    const iy = Math.min(dims[1] - 1, Math.floor((P[3 * v + 1] - min[1]) / h));
    const iz = Math.min(dims[2] - 1, Math.floor((P[3 * v + 2] - min[2]) / h));
    return ix + dims[0] * (iy + dims[1] * iz);
  };
  const start = new Uint32Array(ncell + 1);
  for (const v of ids) start[cellOf(v) + 1]++;
  for (let c = 0; c < ncell; c++) start[c + 1] += start[c];
  const fill = start.slice(0, ncell), items = new Uint32Array(ids.length);
  for (const v of ids) items[fill[cellOf(v)]++] = v;
  return { P, h, min, dims, start, items };
}

function nearestInGrid(g, x, y, z, maxDist) {
  const { P, h, min, dims, start, items } = g;
  const c = [Math.floor((x - min[0]) / h), Math.floor((y - min[1]) / h), Math.floor((z - min[2]) / h)];
  const maxR = Math.ceil(maxDist / h) + 1;
  let best = -1, bd = maxDist * maxDist;
  for (let r = 0; r <= maxR; r++) {
    for (let dz = -r; dz <= r; dz++) {
      const iz = c[2] + dz; if (iz < 0 || iz >= dims[2]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const iy = c[1] + dy; if (iy < 0 || iy >= dims[1]) continue;
        const shell = Math.abs(dz) === r || Math.abs(dy) === r;
        for (let dx = -r; dx <= r; dx++) {
          if (!shell && Math.abs(dx) !== r) continue;
          const ix = c[0] + dx; if (ix < 0 || ix >= dims[0]) continue;
          const cell = ix + dims[0] * (iy + dims[1] * iz);
          for (let k = start[cell], e = start[cell + 1]; k < e; k++) {
            const v = items[k];
            const d = (P[3 * v] - x) ** 2 + (P[3 * v + 1] - y) ** 2 + (P[3 * v + 2] - z) ** 2;
            if (d < bd) { bd = d; best = v; }
          }
        }
      }
    }
    if (best >= 0 && bd <= (r * h) ** 2) break;
  }
  return best;
}

function symmetryContext(mesh) {
  if (mesh._sym) return mesh._sym;
  const P = mesh.positions, { min, max } = mesh.bbox;
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const stride = Math.max(1, Math.floor(mesh.nV / 250000));
  const targets = [];
  for (let v = 0; v < mesh.nV; v += stride) targets.push(v);
  const grids = [300, 100, 35].map((k) => buildGrid(P, targets, diag / k));
  const sStride = Math.max(1, Math.floor(mesh.nV / 20000));
  const sources = [];
  for (let v = Math.floor(sStride / 2); v < mesh.nV; v += sStride) sources.push(v);
  mesh._sym = { diag, targets, grids, sources };
  return mesh._sym;
}

const reflectP = (q, n, d) => { const s = 2 * (dot(n, q) - d); return [q[0] - s * n[0], q[1] - s * n[1], q[2] - s * n[2]]; };

// Mirror the sampled surface across the plane, pair each mirrored point with the nearest
// real vertex, and keep the pairs whose surfaces face the same way.
function symPairs(mesh, ctx, n, d, maxDist, sources = ctx.sources) {
  const P = mesh.positions, N = mesh.normals, out = [];
  const g = ctx.grids.find((x) => maxDist <= 6 * x.h) || ctx.grids[ctx.grids.length - 1];
  for (const s of sources) {
    const q = pt(P, s), qr = reflectP(q, n, d);
    const m = nearestInGrid(g, qr[0], qr[1], qr[2], maxDist);
    if (m < 0) continue;
    const nq = [N[3 * s], N[3 * s + 1], N[3 * s + 2]], nr = reflectP(nq, n, 0);
    const nm = [N[3 * m], N[3 * m + 1], N[3 * m + 2]];
    if (dot(nr, nm) < 0.5) continue;
    out.push({ q, m: pt(P, m), nm, r: dot(nm, sub(qr, pt(P, m))) });
  }
  return out;
}

const median = (a) => { if (!a.length) return Infinity; const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };

// Refine a mirror plane (n·x = d) by iterated point-to-plane matching against its own reflection.
export function refineSymmetry(mesh, init, opts = {}) {
  const ctx = symmetryContext(mesh);
  const tol = opts.tol ?? 0.2, a = opts.perpTo ? unit(opts.perpTo) : null;
  let n = unit(init.normal), d = init.d;
  if (a) {  // keep the mirror plane perpendicular to plane a: its normal stays in a's plane
    const np = sub(n, scl(a, dot(n, a)));
    if (len(np) < 0.05) return { error: 'Those points line up along the reference plane\'s normal, so they cannot define a plane perpendicular to it.' };
    const p0 = init.point || scl(n, d);  // keep the plane through the same spot
    n = unit(np); d = dot(n, p0);
  }
  let reach = Math.max(ctx.diag * 0.08, 2), thr = reach;
  const pool = opts.sourceFilter ? ctx.sources.filter(opts.sourceFilter) : ctx.sources;
  const k = Math.max(1, Math.floor(pool.length / (opts.quick ? 1500 : 5000)));
  const iterSources = pool.filter((_, i) => i % k === 0);
  for (let it = 0, cap = opts.quick ? 24 : 80; it < cap; it++) {
    const pairs = symPairs(mesh, ctx, n, d, reach, iterSources);
    if (pairs.length < (opts.quick ? 60 : 200)) return { error: 'Too little of the surface mirrors onto itself near that plane. Try clicking two points that match more closely.' };
    const sigma = 1.4826 * median(pairs.map((p) => Math.abs(p.r)));
    // Anneal: early on every pair inside the search radius counts; the cut tightens with it.
    thr = Math.max(3 * sigma, tol * 0.5, reach / 3);
    const inl = pairs.filter((p) => Math.abs(p.r) <= thr);
    // Gauss-Newton on (tilts, offset) with the pairs held fixed. Constrained: one tilt, about a.
    const [u, v] = a ? [unit(cross(a, n)), [0, 0, 0]] : perpBasis(n);
    const res = (dp) => {
      const n2 = unit(add(n, add(scl(u, dp[0]), scl(v, dp[1])))), d2 = d + dp[2];
      return inl.map((p) => dot(p.nm, sub(reflectP(p.q, n2, d2), p.m)));
    };
    const ks = a ? [0, 2] : [0, 1, 2];
    const r0 = res([0, 0, 0]), hs = [1e-6, 1e-6, 1e-6 * Math.max(1, ctx.diag / 100)];
    const J = ks.map((k) => { const dp = [0, 0, 0]; dp[k] = hs[k]; return res(dp).map((x, i) => (x - r0[i]) / hs[k]); });
    const A = J.map((Ja, ia) => J.map((Jb, ib) => Ja.reduce((s, x, i) => s + x * Jb[i], 0) + (ia === ib ? 1e-9 : 0)));
    const g = J.map((Ja) => -Ja.reduce((s, x, i) => s + x * r0[i], 0));
    const sol = solveLinear(A, g);
    if (!sol) break;
    const dp = [0, 0, 0];
    ks.forEach((k, i) => { dp[k] = sol[i]; });
    let n2 = unit(add(n, add(scl(u, dp[0]), scl(v, dp[1]))));
    if (a) n2 = unit(sub(n2, scl(a, dot(n2, a))));
    const turn = Math.acos(Math.min(1, Math.abs(dot(n, n2))));
    n = n2; d = d + dp[2];
    const newReach = Math.max(reach * 0.8, 6 * Math.max(3 * sigma, tol * 0.5), ctx.diag / 300);
    const settled = newReach >= reach * 0.999;
    reach = newReach;
    if (settled && turn < (opts.quick ? 1e-4 : 2e-6) && Math.abs(dp[2]) < (opts.quick ? 1e-2 : 1e-5)) break;
  }
  // Final score at the user's tolerance.
  const pairs = symPairs(mesh, ctx, n, d, Math.max(reach, tol * 4));
  const within = pairs.filter((p) => Math.abs(p.r) <= tol);
  let ss = 0;
  for (const p of within) ss += p.r * p.r;
  const frac = within.length / ctx.sources.length;
  const nc = canonical(n);
  if (nc !== n) d = -d;
  n = nc;
  const fit = { type: 'plane', normal: n, point: null, symmetric: true };
  const P = mesh.positions, c = centroid(P, ctx.targets);
  fit.point = sub(c, scl(n, dot(n, c) - d));
  const [eu, ev] = perpBasis(n);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const w of ctx.targets) {
    const q = sub(pt(P, w), fit.point), x = dot(q, eu), y = dot(q, ev);
    u0 = Math.min(u0, x); u1 = Math.max(u1, x); v0 = Math.min(v0, y); v1 = Math.max(v1, y);
  }
  fit.extent = { center: add(fit.point, add(scl(eu, (u0 + u1) / 2), scl(ev, (v0 + v1) / 2))), u: eu, v: ev, w: u1 - u0, h: v1 - v0 };
  return { fit, vertices: null, stats: { n: within.length, rms: Math.sqrt(ss / Math.max(1, within.length)), mirrored: frac, tol, curved: false } };
}

export function symmetryFromPoints(mesh, p1, p2, opts) {
  const n = unit(sub(p2, p1));
  if (len(sub(p2, p1)) < 1e-6) return { error: 'The two points are the same. Click a point on each side of the part.' };
  const mid = scl(add(p1, p2), 0.5);
  return refineSymmetry(mesh, { normal: n, d: dot(n, mid), point: mid }, opts);
}

// Try the three principal directions through the centroid; keep the plane that mirrors best.
export function findSymmetry(mesh, opts) {
  const ctx = symmetryContext(mesh), P = mesh.positions, c = centroid(P, ctx.targets);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const v of ctx.targets) {
    const x = P[3 * v] - c[0], y = P[3 * v + 1] - c[1], z = P[3 * v + 2] - c[2];
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  const axes = eigSym3([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]]).vectors;
  const tried = axes.map((a) => refineSymmetry(mesh, { normal: a, d: dot(a, c) }, { ...opts, quick: true })).filter((r) => !r.error);
  if (!tried.length) return { error: 'No mirror plane found: the part does not look symmetric.' };
  tried.sort((a, b) => b.stats.mirrored - a.stats.mirrored || a.stats.rms - b.stats.rms);
  const best = tried[0].fit;
  const r = refineSymmetry(mesh, { normal: best.normal, d: dot(best.normal, best.point) }, opts);
  if (r.error) return r;
  return { ...r, candidates: tried.map((x) => ({ normal: x.fit.normal, mirrored: x.stats.mirrored, rms: x.stats.rms })) };
}

// Search for a mirror plane perpendicular to plane a: sweep its direction around a, score each
// cheaply through the centroid, then refine the best few under the constraint.
export function findSymmetryPerp(mesh, a, opts = {}) {
  const ctx = symmetryContext(mesh), P = mesh.positions, c = centroid(P, ctx.targets);
  a = unit(a);
  const [e1, e2] = perpBasis(a);
  const few = ctx.sources.filter((_, i) => i % Math.max(1, Math.floor(ctx.sources.length / 1500)) === 0);
  const reach = ctx.diag * 0.03, band = Math.max((opts.tol ?? 0.2) * 3, ctx.diag * 0.004);
  const scores = [];
  for (let deg = 0; deg < 180; deg += 3) {
    const t = (deg * Math.PI) / 180, n = add(scl(e1, Math.cos(t)), scl(e2, Math.sin(t)));
    const pairs = symPairs(mesh, ctx, n, dot(n, c), reach, few);
    scores.push({ deg, n, s: pairs.filter((p) => Math.abs(p.r) <= band).length });
  }
  // local maxima on the circular sweep, best first
  const L = scores.length;
  const peaks = scores.filter((x, i) => x.s >= scores[(i + L - 1) % L].s && x.s >= scores[(i + 1) % L].s).sort((x, y) => y.s - x.s).slice(0, 3);
  const tried = peaks.map((pk) => refineSymmetry(mesh, { normal: pk.n, d: dot(pk.n, c), point: c }, { ...opts, perpTo: a, quick: true })).filter((r) => !r.error);
  if (!tried.length) return { error: 'No mirror plane perpendicular to that plane was found.' };
  tried.sort((x, y) => y.stats.mirrored - x.stats.mirrored);
  const b = tried[0].fit;
  const r = refineSymmetry(mesh, { normal: b.normal, d: dot(b.normal, b.point), point: b.point }, { ...opts, perpTo: a });
  if (r.error) return r;
  return { ...r, candidates: tried.map((x) => ({ normal: x.fit.normal, mirrored: x.stats.mirrored, rms: x.stats.rms })) };
}

// ---------------------------------------------------------------- alignment
export const AXES = { x: 0, y: 1, z: 2 };
const AXIS_NAME = ['X', 'Y', 'Z'];

export function featureDirection(f) {
  if (!f || !f.fit) return null;
  if (f.fit.type === 'plane') return f.fit.normal;
  if (f.fit.type === 'cylinder') return f.fit.axis;
  return null;
}

export function featurePoint(f) {
  const t = f.fit.type;
  if (t === 'plane') return f.fit.point;
  if (t === 'cylinder') return f.fit.center || f.fit.point;
  if (t === 'sphere') return f.fit.center;
  return f.fit.position;
}

// spec = { primary:{feature,axis,flip}, secondary:{feature,to,axis,flip},
//          origin:{x:{src},y:{src},z:{src}} }, src: 'f:<id>' | 'bbox:min|mid|max'
export function solveAlignment(features, spec, mesh) {
  const byId = new Map(features.map((f) => [f.id, f]));
  const need = (stage, message) => ({ ok: false, need: true, stage, message });
  const fail = (stage, message) => ({ ok: false, stage, message });
  const P1 = byId.get(spec.primary.feature);
  if (!P1) return need('primary', 'Choose a plane or cylinder for the primary axis.');
  let d1 = featureDirection(P1);
  if (!d1) return fail('primary', `${P1.name} is a ${P1.fit.type} and has no direction. Use a plane or cylinder.`);
  d1 = unit(spec.primary.flip ? scl(d1, -1) : d1);

  const S1 = byId.get(spec.secondary.feature);
  if (!S1) return need('secondary', 'Choose a feature for the secondary axis.');
  const T1 = spec.secondary.to ? byId.get(spec.secondary.to) : null;
  let d2, how;
  if (T1) {
    if (T1 === S1) return fail('secondary', 'The secondary line needs two different features.');
    d2 = sub(featurePoint(T1), featurePoint(S1));
    how = `line ${S1.name} → ${T1.name}`;
  } else {
    d2 = featureDirection(S1);
    if (!d2) return fail('secondary', `${S1.name} has no direction on its own. Pick a second feature to make a line from ${S1.name}.`);
    how = S1.name;
  }
  if (len(d2) < 1e-9) return fail('secondary', 'The two secondary features are at the same place.');
  if (spec.secondary.flip) d2 = scl(d2, -1);
  const c12 = Math.abs(dot(unit(d2), d1));
  const angle = (Math.acos(Math.min(1, c12)) * 180) / Math.PI;
  const d2p = sub(d2, scl(d1, dot(d2, d1)));
  if (len(d2p) < Math.sin((5 * Math.PI) / 180) * len(d2))
    return fail('secondary', `The secondary (${how}) is within 5° of parallel to the primary, so it cannot set the rotation.`);
  const i = AXES[spec.primary.axis], j = AXES[spec.secondary.axis];
  if (i === j) return fail('secondary', 'Primary and secondary must set different axes.');
  const k = 3 - i - j;
  const E = [];
  E[i] = d1; E[j] = unit(d2p);
  E[k] = j === (i + 1) % 3 ? cross(E[i], E[j]) : cross(E[j], E[i]);

  const rows = [], rhs = [], from = [];
  let extents = null;
  for (let a = 0; a < 3; a++) {
    const name = ['x', 'y', 'z'][a], src = spec.origin[name]?.src || 'bbox:min';
    if (src.startsWith('bbox:')) {
      if (!extents) extents = projectedExtents(mesh, E);
      const [lo, hi] = extents[a];
      rows.push(E[a]); rhs.push(src === 'bbox:min' ? lo : src === 'bbox:max' ? hi : (lo + hi) / 2);
      from.push(`box ${src.slice(5)}`);
      continue;
    }
    const f = byId.get(src.slice(2));
    if (!f) return need('origin', `Choose what sets the ${AXIS_NAME[a]} origin.`);
    const t = f.fit.type;
    if (t === 'plane') {
      if (Math.abs(dot(f.fit.normal, E[a])) < Math.cos((45 * Math.PI) / 180))
        return fail('origin', `${f.name} does not face along ${AXIS_NAME[a]}, so it cannot set the ${AXIS_NAME[a]} origin.`);
      rows.push(f.fit.normal); rhs.push(dot(f.fit.normal, f.fit.point));
    } else {
      if (t === 'cylinder' && Math.abs(dot(f.fit.axis, E[a])) > 0.5)
        return fail('origin', `${f.name} runs along ${AXIS_NAME[a]}, so it cannot set the ${AXIS_NAME[a]} origin.`);
      rows.push(E[a]); rhs.push(dot(E[a], featurePoint(f)));
    }
    from.push(f.name);
  }
  const det = dot(rows[0], cross(rows[1], rows[2]));
  if (Math.abs(det) < 0.2) return fail('origin', 'The origin features do not pin down a single point: two of them are parallel.');
  const o = solveLinear(rows, rhs);
  if (!o) return fail('origin', 'The origin features do not pin down a single point.');
  const t = E.map((e) => -dot(e, o));
  const matrix = [[...E[0], t[0]], [...E[1], t[1]], [...E[2], t[2]], [0, 0, 0, 1]];
  return { ok: true, matrix, origin: o, axes: E, secondaryAngle: angle, secondaryFrom: how, originFrom: from };
}

export function projectedExtents(mesh, E) {
  const P = mesh.positions, out = [[Infinity, -Infinity], [Infinity, -Infinity], [Infinity, -Infinity]];
  for (let v = 0; v < mesh.nV; v++) {
    const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
    for (let a = 0; a < 3; a++) {
      const d = E[a][0] * x + E[a][1] * y + E[a][2] * z;
      if (d < out[a][0]) out[a][0] = d;
      if (d > out[a][1]) out[a][1] = d;
    }
  }
  return out;
}

export function transformPositions(P, M) {
  const out = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    out[i] = M[0][0] * x + M[0][1] * y + M[0][2] * z + M[0][3];
    out[i + 1] = M[1][0] * x + M[1][1] * y + M[1][2] * z + M[1][3];
    out[i + 2] = M[2][0] * x + M[2][1] * y + M[2][2] * z + M[2][3];
  }
  return out;
}

// A saved transform must be a rigid motion: orthonormal rotation, det +1.
export function checkRigid(M) {
  if (!Array.isArray(M) || M.length !== 4 || !M.every((r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)))
    return 'The file has no 4×4 matrix_row_major.';
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
    const d = M[a][0] * M[b][0] + M[a][1] * M[b][1] + M[a][2] * M[b][2];
    if (Math.abs(d - (a === b ? 1 : 0)) > 1e-4) return 'The matrix is not a pure rotation and translation.';
  }
  const det = dot(M[0].slice(0, 3), cross(M[1].slice(0, 3), M[2].slice(0, 3)));
  if (det < 0) return 'The matrix mirrors the part.';
  return null;
}

// ---------------------------------------------------------------- trimming
// Coordinate of every vertex along axis k of frame M (row k of a row-major 4x4).
export function frameCoord(P, M, k) {
  const out = new Float32Array(P.length / 3), r = M[k];
  for (let v = 0, i = 0; i < P.length; v++, i += 3) out[v] = r[0] * P[i] + r[1] * P[i + 1] + r[2] * P[i + 2] + r[3];
  return out;
}

// Which vertices a cut removes: coord below (or above) the cut position.
export function cutMask(coord, at, removeAbove) {
  const m = new Uint8Array(coord.length);
  for (let v = 0; v < coord.length; v++) m[v] = removeAbove ? (coord[v] > at ? 1 : 0) : (coord[v] < at ? 1 : 0);
  return m;
}

// Drop every triangle touching a removed vertex, then drop vertices no triangle uses.
// Returns the compacted mesh and map[old] = new index, or -1 if the vertex is gone.
export function trimMesh(positions, indices, removed) {
  const nV = positions.length / 3, used = new Uint8Array(nV);
  let nt = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    if (removed[a] || removed[b] || removed[c]) continue;
    used[a] = used[b] = used[c] = 1; nt++;
  }
  const map = new Int32Array(nV).fill(-1);
  let k = 0;
  for (let v = 0; v < nV; v++) if (used[v]) map[v] = k++;
  const P = new Float32Array(3 * k), T = new Uint32Array(3 * nt);
  for (let v = 0; v < nV; v++) if (map[v] >= 0) P.set(positions.subarray(3 * v, 3 * v + 3), 3 * map[v]);
  let j = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    if (removed[a] || removed[b] || removed[c]) continue;
    T[j++] = map[a]; T[j++] = map[b]; T[j++] = map[c];
  }
  return { positions: P, indices: T, map, removedTris: indices.length / 3 - nt };
}

export function countCutTris(indices, removed) {
  let n = 0;
  for (let t = 0; t < indices.length; t += 3) if (removed[indices[t]] || removed[indices[t + 1]] || removed[indices[t + 2]]) n++;
  return n;
}

// ---------------------------------------------------------------- 3MF
const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
const RELS = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';

const fmt = (x) => { const r = Math.round(x * 1e5) / 1e5; return r === 0 ? '0' : String(r); };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Returns the package parts; the model is an array of string chunks (it can be large).
export const MESHALIGN_NS = 'urn:x-mesh-align:transform:1';
// meta: standard 3MF names (Title, Application, ...); transform: JSON text stored as meshalign:transform.
export function build3MF(positions, indices, meta = {}, transform = null) {
  const chunks = [];
  let buf = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"${transform ? ` xmlns:meshalign="${MESHALIGN_NS}"` : ''}>\n`;
  for (const [k, v] of Object.entries(meta)) buf += ` <metadata name="${esc(k)}">${esc(v)}</metadata>\n`;
  if (transform) buf += ` <metadata name="meshalign:transform" preserve="1">${esc(transform)}</metadata>\n`;
  buf += ' <resources>\n  <object id="1" type="model">\n   <mesh>\n    <vertices>\n';
  const flush = () => { chunks.push(buf); buf = ''; };
  for (let i = 0; i < positions.length; i += 3) {
    buf += `     <vertex x="${fmt(positions[i])}" y="${fmt(positions[i + 1])}" z="${fmt(positions[i + 2])}"/>\n`;
    if (buf.length > 1 << 20) flush();
  }
  buf += '    </vertices>\n    <triangles>\n';
  for (let i = 0; i < indices.length; i += 3) {
    buf += `     <triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}"/>\n`;
    if (buf.length > 1 << 20) flush();
  }
  buf += '    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build>\n  <item objectid="1"/>\n </build>\n</model>\n';
  flush();
  return { '[Content_Types].xml': CONTENT_TYPES, '_rels/.rels': RELS, '3D/3dmodel.model': chunks };
}

function readAttrs(s, i, end) {
  const out = {};
  while (i < end) {
    let c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 47) { i++; continue; }
    const eq = s.indexOf('=', i);
    if (eq < 0 || eq >= end) break;
    let name = s.slice(i, eq).trim();
    const colon = name.indexOf(':');
    if (colon >= 0 && name.slice(0, colon) !== 'xmlns') name = name.slice(colon + 1);
    let q = eq + 1;
    while (q < end && (s[q] === ' ' || s[q] === '\n' || s[q] === '\t' || s[q] === '\r')) q++;
    const quote = s[q];
    if (quote !== '"' && quote !== "'") break;
    const close = s.indexOf(quote, q + 1);
    if (close < 0) break;
    out[name] = s.slice(q + 1, close);
    i = close + 1;
  }
  return out;
}

// 3MF transform "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" (row vectors) -> {A rows, t}.
function parseTransform(str) {
  if (!str) return null;
  const m = str.trim().split(/\s+/).map(Number);
  if (m.length !== 12 || !m.every(Number.isFinite)) throw new Error(`Bad 3MF transform "${str}"`);
  return { A: [[m[0], m[3], m[6]], [m[1], m[4], m[7]], [m[2], m[5], m[8]]], t: [m[9], m[10], m[11]] };
}
const IDENT = { A: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] };
function compose(p, c) {  // p(c(x))
  if (!c) return p;
  const A = p.A.map((row) => [0, 1, 2].map((j) => row[0] * c.A[0][j] + row[1] * c.A[1][j] + row[2] * c.A[2][j]));
  const t = p.A.map((row, i) => dot(row, c.t) + p.t[i]);
  return { A, t };
}


const unescapeXml = (t) => t.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (m, e, d, h) =>
  d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e.toLowerCase()]);

// Read the embedded Mesh Align transform without parsing the whole mesh: it sits near the top.
export function readEmbeddedTransform(files) {
  const dec = new TextDecoder();
  for (const [k, bytes] of Object.entries(files)) {
    if (!/\.model$/i.test(k)) continue;
    const head = dec.decode(bytes.subarray(0, 4 << 20));
    const m = head.match(/<metadata\b[^>]*name\s*=\s*["']meshalign:transform["'][^>]*>([\s\S]*?)<\/metadata>/);
    if (m) return unescapeXml(m[1]);
  }
  return null;
}

export function parseModelXML(s) {
  const model = { unit: 'millimeter', objects: new Map(), build: [], metadata: {} };
  let obj = null, section = '';
  let pos = 0;
  const L = s.length;
  while (pos < L) {
    const lt = s.indexOf('<', pos);
    if (lt < 0) break;
    const c1 = s.charCodeAt(lt + 1);
    if (c1 === 33) {  // <!-- or <!DOCTYPE / CDATA
      if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); pos = e < 0 ? L : e + 3; continue; }
      if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt); pos = e < 0 ? L : e + 3; continue; }
    }
    const gt = s.indexOf('>', lt);
    if (gt < 0) break;
    pos = gt + 1;
    if (c1 === 63 || c1 === 33) continue;
    const closing = c1 === 47;
    let ns = lt + (closing ? 2 : 1), ne = ns;
    while (ne < gt) { const ch = s.charCodeAt(ne); if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 47) break; ne++; }
    let name = s.slice(ns, ne);
    const colon = name.indexOf(':');
    if (colon >= 0) name = name.slice(colon + 1);
    if (closing) {
      if (name === 'object') obj = null;
      if (name === 'vertices' || name === 'triangles' || name === 'build' || name === 'components') section = '';
      continue;
    }
    if (name === 'vertex' && obj && section === 'vertices') {
      const a = readAttrs(s, ne, gt);
      obj.verts.push(+a.x, +a.y, +a.z);
    } else if (name === 'triangle' && obj && section === 'triangles') {
      const a = readAttrs(s, ne, gt);
      obj.tris.push(+a.v1, +a.v2, +a.v3);
    } else if (name === 'vertices' || name === 'triangles' || name === 'build' || name === 'components') {
      section = name;
    } else if (name === 'object') {
      const a = readAttrs(s, ne, gt);
      obj = { id: a.id, verts: [], tris: [], components: [] };
      model.objects.set(a.id, obj);
    } else if (name === 'component' && obj) {
      const a = readAttrs(s, ne, gt);
      obj.components.push({ objectid: a.objectid, path: a.path, transform: parseTransform(a.transform) });
    } else if (name === 'item' && section === 'build') {
      const a = readAttrs(s, ne, gt);
      model.build.push({ objectid: a.objectid, path: a.path, transform: parseTransform(a.transform) });
    } else if (name === 'metadata') {
      const a = readAttrs(s, ne, gt);
      if (a.name && s.charCodeAt(gt - 1) !== 47) {
        const end = s.indexOf('</', gt);
        model.metadata[a.name] = unescapeXml(s.slice(gt + 1, end < 0 ? gt + 1 : end));
        if (end >= 0) pos = end;
      }
    } else if (name === 'model') {
      const a = readAttrs(s, ne, gt);
      if (a.unit) model.unit = a.unit;
    }
  }
  return model;
}

// files: { 'path/in/zip': Uint8Array }. Returns one merged mesh in millimeters.
export function parse3MF(files) {
  const dec = new TextDecoder();
  const norm = (p) => (p || '').replace(/^\/+/, '');
  let root = null;
  if (files['_rels/.rels']) {
    const rels = dec.decode(files['_rels/.rels']);
    const m = rels.match(/<Relationship\b[^>]*Type="[^"]*\/3dmodel"[^>]*>/);
    if (m) { const t = m[0].match(/Target="([^"]+)"/); if (t) root = norm(t[1]); }
  }
  if (!root || !files[root]) root = Object.keys(files).find((k) => k.toLowerCase().endsWith('.model'));
  if (!root) throw new Error('No 3D model found inside this 3MF.');
  const cache = new Map();
  const getModel = (p) => {
    if (!cache.has(p)) {
      if (!files[p]) throw new Error(`The 3MF refers to ${p}, which is missing.`);
      cache.set(p, parseModelXML(dec.decode(files[p])));
    }
    return cache.get(p);
  };
  const rootModel = getModel(root);
  const scale = UNIT_MM[rootModel.unit];
  if (!scale) throw new Error(`Unknown 3MF unit "${rootModel.unit}".`);
  const V = [], T = [];
  const emit = (path, id, X, depth) => {
    if (depth > 16) throw new Error('3MF components nest too deeply.');
    const o = getModel(path).objects.get(id);
    if (!o) throw new Error(`3MF object ${id} is missing.`);
    if (o.verts.length) {
      const base = V.length / 3, nv = o.verts.length / 3;
      for (let i = 0; i < o.verts.length; i += 3) {
        const x = o.verts[i], y = o.verts[i + 1], z = o.verts[i + 2];
        for (let r = 0; r < 3; r++) V.push((X.A[r][0] * x + X.A[r][1] * y + X.A[r][2] * z + X.t[r]) * scale);
      }
      for (const t of o.tris) {
        if (!(t >= 0 && t < nv)) throw new Error(`3MF object ${id} has a triangle pointing at a missing vertex.`);
        T.push(base + t);
      }
    }
    for (const c of o.components) emit(norm(c.path) || path, c.objectid, compose(X, c.transform), depth + 1);
  };
  const items = rootModel.build.length ? rootModel.build : [...rootModel.objects.keys()].map((id) => ({ objectid: id }));
  for (const it of items) emit(norm(it.path) || root, it.objectid, compose(IDENT, it.transform), 0);
  if (!T.length) throw new Error('The 3MF holds no triangles.');
  return { positions: Float32Array.from(V), indices: dropDegenerate(Uint32Array.from(T)), unit: rootModel.unit, metadata: rootModel.metadata };
}

// ---------------------------------------------------------------- example part
function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, gauss: () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next()) };
}

function eulerMatrix(rx, ry, rz) {
  const [a, b, c] = [rx, ry, rz].map((d) => (d * Math.PI) / 180);
  const X = [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const Y = [[Math.cos(b), 0, Math.sin(b)], [0, 1, 0], [-Math.sin(b), 0, Math.cos(b)]];
  const Z = [[Math.cos(c), -Math.sin(c), 0], [Math.sin(c), Math.cos(c), 0], [0, 0, 1]];
  const mul = (P, Q) => P.map((row) => [0, 1, 2].map((j) => row[0] * Q[0][j] + row[1] * Q[1][j] + row[2] * Q[2][j]));
  return mul(Z, mul(Y, X));
}

// A machined block, 120 x 80 x 25 mm, with two bosses and a tooling ball, posed the way a
// scanner leaves it (tilted, offset) and with scan-like noise. Returns probes (posed) to click.
export function makeSamplePart({ noise = 0.025, seed = 7, density = 1 } = {}) {
  const dn = Math.max(1, Math.round(density));
  const V = [], T = [];
  const vert = (p) => { V.push(p[0], p[1], p[2]); return V.length / 3 - 1; };
  const grid = (o, U, nu, W, nw) => {
    const id = [];
    for (let i = 0; i <= nu; i++) {
      id.push([]);
      for (let j = 0; j <= nw; j++)
        id[i].push(vert([0, 1, 2].map((k) => o[k] + (U[k] * i) / nu + (W[k] * j) / nw)));
    }
    for (let i = 0; i < nu; i++) for (let j = 0; j < nw; j++)
      T.push(id[i][j], id[i + 1][j], id[i + 1][j + 1], id[i][j], id[i + 1][j + 1], id[i][j + 1]);
  };
  const [L, W, H] = [120, 80, 25], [nx, ny, nz] = [60 * dn, 40 * dn, 13 * dn];
  const X = [L, 0, 0], Y = [0, W, 0], Z = [0, 0, H];
  grid([0, 0, 0], Y, ny, X, nx);   // bottom, -Z
  grid([0, 0, H], X, nx, Y, ny);   // top, +Z
  grid([0, 0, 0], X, nx, Z, nz);   // front, -Y
  grid([0, W, 0], Z, nz, X, nx);   // back, +Y
  grid([0, 0, 0], Z, nz, Y, ny);   // left, -X
  grid([L, 0, 0], Y, ny, Z, nz);   // right, +X
  const boss = (cx, cy, r, z0, z1) => {
    const K = 96 * dn, rings = 5 * dn, M = 6 * dn;
    const ring = (z, rad) => Array.from({ length: K }, (_, k) => vert([cx + rad * Math.cos((2 * Math.PI * k) / K), cy + rad * Math.sin((2 * Math.PI * k) / K), z]));
    const side = Array.from({ length: rings + 1 }, (_, l) => ring(z0 + ((z1 - z0) * l) / rings, r));
    for (let l = 0; l < rings; l++) for (let k = 0; k < K; k++) {
      const k2 = (k + 1) % K;
      T.push(side[l][k], side[l][k2], side[l + 1][k2], side[l][k], side[l + 1][k2], side[l + 1][k]);
    }
    const caps = [vert([cx, cy, z1])];
    const rr = [null];
    for (let m = 1; m <= M; m++) rr.push(m === M ? side[rings] : ring(z1, (r * m) / M));
    for (let k = 0; k < K; k++) T.push(caps[0], rr[1][k], rr[1][(k + 1) % K]);
    for (let m = 1; m < M; m++) for (let k = 0; k < K; k++) {
      const k2 = (k + 1) % K;
      T.push(rr[m][k], rr[m + 1][k], rr[m + 1][k2], rr[m][k], rr[m + 1][k2], rr[m][k2]);
    }
  };
  boss(30, 40, 10, H, H + 10);
  boss(90, 40, 6, H, H + 10);
  const ball = (c, R) => {
    const NL = 24 * dn, NK = 48 * dn, id = [];
    for (let i = 0; i <= NL; i++) {
      const phi = -Math.PI / 2 + (Math.PI * i) / NL;
      id.push(Array.from({ length: NK }, (_, k) => {
        const th = (2 * Math.PI * k) / NK;
        return vert([c[0] + R * Math.cos(phi) * Math.cos(th), c[1] + R * Math.cos(phi) * Math.sin(th), c[2] + R * Math.sin(phi)]);
      }));
    }
    for (let i = 0; i < NL; i++) for (let k = 0; k < NK; k++) {
      const k2 = (k + 1) % NK;
      T.push(id[i][k], id[i][k2], id[i + 1][k2], id[i][k], id[i + 1][k2], id[i + 1][k]);
    }
  };
  ball([60, 18, H + 6.35], 6.35);

  const w0 = weldVertices(Float32Array.from(V), 1e-4);
  const welded = { positions: w0.positions, indices: dropDegenerate(Uint32Array.from(T, (t) => w0.map[t])) };
  const clean = Float64Array.from(welded.positions);
  const m0 = prepareMesh(welded.positions, welded.indices);
  const g = rng(seed);
  const Rm = eulerMatrix(23, -37, 58), tr = [61.3, -42.7, 187.9];
  const pose = (p) => add([dot(Rm[0], p), dot(Rm[1], p), dot(Rm[2], p)], tr);
  const out = new Float32Array(clean.length);
  for (let v = 0; v < m0.nV; v++) {
    const e = noise * g.gauss();
    const p = [clean[3 * v] + m0.normals[3 * v] * e, clean[3 * v + 1] + m0.normals[3 * v + 1] * e, clean[3 * v + 2] + m0.normals[3 * v + 2] * e];
    out.set(pose(p), 3 * v);
  }
  const probes = Object.fromEntries(Object.entries({
    bottom: [60, 40, 0], top: [100, 70, H], front: [60, 0, 12], back: [60, W, 12], left: [0, 40, 12], right: [L, 40, 12],
    bossA: [40, 40, H + 5], bossB: [96, 40, H + 5], ball: [60, 18, H + 12.7],
  }).map(([k, p]) => [k, pose(p)]));
  const Rinv = [[Rm[0][0], Rm[1][0], Rm[2][0]], [Rm[0][1], Rm[1][1], Rm[2][1]], [Rm[0][2], Rm[1][2], Rm[2][2]]];
  const tinv = Rinv.map((r) => -dot(r, tr));
  return { positions: out, indices: welded.indices, clean, probes,
    truth: [[...Rinv[0], tinv[0]], [...Rinv[1], tinv[1]], [...Rinv[2], tinv[2]], [0, 0, 0, 1]] };
}

export function nearestVertex(mesh, p) {
  const P = mesh.positions;
  let best = -1, bd = Infinity;
  for (let v = 0; v < mesh.nV; v++) {
    const d = (P[3 * v] - p[0]) ** 2 + (P[3 * v + 1] - p[1]) ** 2 + (P[3 * v + 2] - p[2]) ** 2;
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

// Internals exposed for diagnostics scripts.
export const __test = {
  symGrid: (mesh) => symmetryContext(mesh).grids[0],
  nearest: (g, p, maxDist) => nearestInGrid(g, p[0], p[1], p[2], maxDist),
};
