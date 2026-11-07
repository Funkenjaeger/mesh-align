import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { zipSync, unzipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { prepareMesh, weldVertices, growFeature, growPlaneFaces, solveAlignment, featureDirection, transformPositions,
  build3MF, parse3MF, checkRigid, projectedExtents, makeSamplePart, nearestVertex, UNIT_MM,
  frameCoord, cutMask, trimMesh, countCutTris,
  refineSymmetry, symmetryFromPoints, findSymmetry, findSymmetryPerp, readEmbeddedTransform } from './core.js';

const $ = (id) => document.getElementById(id);
const PALETTE = ['#e8a33d', '#2fb5a3', '#d9578a', '#7b8cff', '#93c13b', '#c27cf0', '#f0794a', '#3fb8e6'];
const TYPE_LABEL = { plane: 'Plane', cylinder: 'Cylinder', sphere: 'Sphere', point: 'Point', symmetry: 'Symmetry plane' };
const PREFIX = { plane: 'P', cylinder: 'C', sphere: 'S', point: 'Pt', symmetry: 'M' };
const SYM_FIRST = 'Mirror: click a point on one side of the part, then the matching point on the other side. Or use "Find automatically".';
const TOOL_HINT = {
  symmetry: SYM_FIRST,
  plane: 'Plane: click a flat face. The fit grows across the whole face. Shift-click a separate face in the same plane to add it to the last plane.',
  cylinder: 'Cylinder: click a bore or boss wall.',
  sphere: 'Sphere: click a tooling ball or other spherical surface.',
  point: 'Point: click a spot on the surface. Raw points are less accurate than fitted features.',
};
const AXIS_COL = ['#e5484d', '#30a46c', '#3e63dd'];

const S = {
  mesh: null, name: '', source: null, features: [], seq: 0, count: {},
  tool: null, addTo: null, lastPlane: null, view: 'aligned', result: null, override: null, example: false,
  spec: blankSpec(),
};
// Cutting plane state: position `at` along `axis` of the displayed frame; `removed` marks vertices to cut.
const T = { on: false, axis: 'z', above: false, at: 0, fresh: true, key: '', coord: null, lo: 0, hi: 0, ext: null,
  removed: null, nCut: 0, undo: [] };
const IDENT4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
function blankSpec() {
  return {
    primary: { feature: '', axis: 'z', flip: false },
    secondary: { feature: '', to: '', axis: 'x', flip: false },
    origin: { x: { src: 'bbox:min' }, y: { src: 'bbox:min' }, z: { src: 'bbox:min' } },
  };
}
const downloadsP = window.claude?.use ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
const inViewer = !!window.claude?.use;

// ---------------------------------------------------------------- three.js scene
const canvas = $('gl'), view = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
const persp = new THREE.PerspectiveCamera(35, 1, 0.1, 100000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);
for (const c of [persp, ortho]) { c.up.set(0, 0, 1); scene.add(c); }
let camera = persp, aspect = 1;
const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
keyLight.position.set(0.6, 1.2, 1.5);
camera.add(keyLight);
scene.add(new THREE.HemisphereLight(0xffffff, 0x404858, 1.1));
const controls = new OrbitControls(camera, canvas);
let orthoHalf = 50;  // half-height of the orthographic view, in mm, at zoom 1
function setOrthoFrustum() {
  ortho.left = -orthoHalf * aspect; ortho.right = orthoHalf * aspect; ortho.top = orthoHalf; ortho.bottom = -orthoHalf;
  ortho.updateProjectionMatrix();
}
// Switch projection, keeping the same viewpoint and apparent size.
function setProjection(kind) {
  const next = kind === 'ortho' ? ortho : persp;
  if (next === camera) return;
  const dist = camera.position.distanceTo(controls.target);
  if (next === ortho) {
    orthoHalf = dist * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2)) / persp.zoom;
    ortho.zoom = 1;
  } else {
    // keep the apparent size: move the perspective camera to the distance that shows the same height
    const half = orthoHalf / ortho.zoom, want = half / Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
    const dir = camera.position.clone().sub(controls.target).normalize();
    next.position.copy(controls.target).addScaledVector(dir, want);
  }
  if (next === ortho) next.position.copy(camera.position);
  next.quaternion.copy(camera.quaternion);
  next.near = camera.near; next.far = camera.far;
  next.add(keyLight);
  camera = next;
  setOrthoFrustum(); persp.updateProjectionMatrix();
  controls.object = camera;
  controls.update();
  for (const b of document.querySelectorAll('[data-proj]')) b.setAttribute('aria-pressed', String(b.dataset.proj === kind));
  try { localStorage.setItem('meshAlignProj', kind); } catch { /* per-viewer convenience only */ }
}
controls.enableDamping = true;
controls.dampingFactor = 0.14;
const world = new THREE.Group();
world.matrixAutoUpdate = false;
scene.add(world);
const featGroup = new THREE.Group();
world.add(featGroup);
const helpers = new THREE.Group();
scene.add(helpers);
let meshObj = null, colors = null, meshColor = new THREE.Color('#9aa3ad'), cutColor = new THREE.Color('#e5484d'), diag = 100;

function resize() {
  const r = view.getBoundingClientRect();
  renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
  aspect = Math.max(1, r.width) / Math.max(1, r.height);
  persp.aspect = aspect;
  persp.updateProjectionMatrix();
  setOrthoFrustum();
}
new ResizeObserver(resize).observe(view);
resize();
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function applyTheme() {
  renderer.setClearColor(new THREE.Color(cssVar('--view') || '#dfe4ea'));
  meshColor = new THREE.Color(cssVar('--mesh') || '#9aa3ad');
  cutColor = new THREE.Color(cssVar('--cut') || '#e5484d');
  buildHelpers();
  paintColors();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

function niceStep(x) { const p = 10 ** Math.floor(Math.log10(x)); return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= x); }
function buildHelpers() {
  helpers.clear();
  const L = diag * 0.3;
  AXIS_COL.forEach((c, a) => {
    const dir = new THREE.Vector3(...[0, 1, 2].map((k) => (k === a ? 1 : 0)));
    const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(), L, new THREE.Color(c), L * 0.12, L * 0.06);
    arrow.line.material.depthTest = false; arrow.cone.material.depthTest = false;
    arrow.renderOrder = 5;
    helpers.add(arrow);
  });
  const step = niceStep(diag / 12), size = Math.ceil((diag * 1.6) / step) * step;
  const grid = new THREE.GridHelper(size, Math.round(size / step), new THREE.Color(cssVar('--grid-major') || '#8894a0'), new THREE.Color(cssVar('--grid') || '#c4ccd4'));
  grid.rotation.x = Math.PI / 2;
  grid.material.transparent = true; grid.material.opacity = 0.55; grid.material.depthWrite = false;
  helpers.add(grid);
  $('grid-step').textContent = `grid ${step} mm`;
}

// ---------------------------------------------------------------- busy, toast
async function busy(text, fn) {
  $('busy-text').textContent = text;
  $('busy').hidden = false;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try { return await fn(); } finally { $('busy').hidden = true; }
}
let toastTimer = 0;
function toast(msg, kind = 'info') {
  const t = $('toast');
  t.textContent = msg; t.dataset.kind = kind; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'bad' ? 9000 : 4500);
}

// ---------------------------------------------------------------- loading
let meshGen = 0;
function buildMeshObject(positions, indices) {
  if (meshObj) { world.remove(meshObj); meshObj.geometry.dispose(); meshObj.material.dispose(); }
  S.mesh = prepareMesh(positions, indices);
  meshGen++;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(S.mesh.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(S.mesh.normals, 3));
  colors = new Float32Array(S.mesh.nV * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(new THREE.BufferAttribute(S.mesh.indices, 1));
  g.computeBoundingBox(); g.computeBoundingSphere();
  meshObj = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0, side: THREE.DoubleSide }));
  world.add(meshObj);
  T.key = '';
}

function setMesh(positions, indices, info) {
  for (const f of S.features) disposeVisual(f);
  S.features = []; S.seq = 0; S.count = {}; S.spec = blankSpec(); S.override = null;
  Object.assign(T, { on: false, fresh: true, undo: [], removed: null, nCut: 0 });
  Object.assign(S, info);
  buildMeshObject(positions, indices);
  const { min, max } = S.mesh.bbox;
  diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 100;
  buildHelpers();
  paintColors();
  $('out-name').value = `${S.name.replace(/\.[^.]+$/, '')}-aligned`;
  solve();
  renderAll();
  fitView('iso');
}

async function openFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['3mf', 'stl', 'obj', 'ply'].includes(ext)) { toast(`${file.name} is not a 3MF, STL, OBJ or PLY file.`, 'bad'); return; }
  try {
    const buf = await busy(`Reading ${file.name}…`, () => file.arrayBuffer());
    S.source = { buf, name: file.name, ext };
    await loadSource();
  } catch (e) { console.error(e); toast(`Could not open ${file.name}: ${e.message}`, 'bad'); }
}

async function loadSource() {
  const { buf, name, ext } = S.source;
  const unitSel = $('unit-sel').value;
  await busy(`Building mesh from ${name}…`, () => {
    let positions, indices, unitLabel, prior = null;
    if (ext === '3mf') {
      const files = unzipSync(new Uint8Array(buf), { filter: (f) => /\.model$|\.rels$/i.test(f.name) });
      const r = parse3MF(files);
      positions = r.positions; indices = r.indices; unitLabel = `${r.unit} (from file)`;
      const t = r.metadata?.['meshalign:transform'];
      if (t) { try { prior = JSON.parse(t); unitLabel += ` · aligned by Mesh Align from ${prior.source || 'a scan'}`; } catch { prior = null; } }
    } else {
      const s = UNIT_MM[unitSel];
      unitLabel = `${unitSel} (assumed)`;
      let soup = null, geo = null;
      if (ext === 'stl') geo = new STLLoader().parse(buf);
      else if (ext === 'ply') geo = new PLYLoader().parse(buf);
      else {
        const group = new OBJLoader().parse(new TextDecoder().decode(buf));
        const parts = [];
        group.traverse((o) => { if (o.isMesh) { const gg = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry; parts.push(gg.attributes.position.array); } });
        const n = parts.reduce((a, p) => a + p.length, 0);
        soup = new Float32Array(n); let off = 0;
        for (const p of parts) { soup.set(p, off); off += p.length; }
      }
      if (geo && geo.index) {
        positions = Float32Array.from(geo.attributes.position.array, (x) => x * s);
        indices = Uint32Array.from(geo.index.array);
      } else {
        soup = soup || geo.attributes.position.array;
        const scaled = Float32Array.from(soup, (x) => x * s);
        const w = weldVertices(scaled, 1e-4);
        positions = w.positions; indices = w.indices;
      }
    }
    if (!indices.length) throw new Error('no triangles found');
    setMesh(positions, indices, { name, unitLabel, example: false, prior });
  });
  toast(`Opened ${name}: ${S.mesh.nT.toLocaleString()} triangles.`);
}

function loadExample() {
  const part = makeSamplePart();
  setMesh(part.positions, part.indices, { name: 'example-block.3mf', unitLabel: 'millimeter (generated)', example: true, prior: null });
  S.source = null;
  const add = (type, probe) => addFeatureAt(type, nearestVertex(S.mesh, part.probes[probe]), part.probes[probe], true);
  add('plane', 'bottom'); add('plane', 'left'); add('plane', 'front'); add('cylinder', 'bossA');
  Object.assign(S.spec.primary, { feature: 'f1', flip: true });
  Object.assign(S.spec.secondary, { feature: 'f2', flip: true });
  S.spec.origin = { x: { src: 'f:f2' }, y: { src: 'f:f3' }, z: { src: 'f:f1' } };
  solve(); renderAll(); fitView('iso');
}

// ---------------------------------------------------------------- features
const perpRefFeature = () => S.features.find((x) => x.id === $('perp-ref').value) || null;
const settings = () => {
  const ref = perpRefFeature();
  return {
    tol: Math.max(0.005, +$('set-tol').value || 0.2),
    maxAngle: Math.min(80, Math.max(2, +$('set-angle').value || 20)),
    seedRadius: Math.max(0.2, +$('set-seed').value || 3),
    ...(ref ? { perpRef: ref.id, perpTo: featureDirection(ref) } : {}),
  };
};

function fitFeature(f) {
  if (f.type === 'point') { f.fit = { type: 'point', position: f.seedPoint }; f.stats = null; f.vertices = null; return true; }
  if (f.settings.perpRef) {  // refits follow the reference's current direction
    const ref = S.features.find((x) => x.id === f.settings.perpRef);
    if (ref && ref !== f) f.settings.perpTo = featureDirection(ref);
    else { delete f.settings.perpRef; delete f.settings.perpTo; }
  }
  if (f.type !== 'symmetry' && f.seedVertex == null && f.seedPoint) f.seedVertex = nearestVertex(S.mesh, f.seedPoint);
  for (const m of f.more || []) if (m.vertex == null) m.vertex = nearestVertex(S.mesh, m.point);
  const r = f.type === 'symmetry' ? (f.preset || refineSymmetry(S.mesh, f.init, f.settings))
    : f.more?.length ? growPlaneFaces(S.mesh, [f.seedVertex, ...f.more.map((m) => m.vertex)], f.settings)
    : growFeature(S.mesh, f.type, f.seedVertex, f.settings);
  delete f.preset;
  if (r.error) { toast(r.error, 'bad'); return false; }
  f.fit = r.fit; f.vertices = r.vertices; f.stats = r.stats;
  return true;
}

function addFeatureAt(type, seedVertex, seedPoint, quiet = false, extra = {}) {
  S.count[type] = (S.count[type] || 0) + 1;
  const n = ++S.seq;
  const f = { id: `f${n}`, type, name: `${PREFIX[type]}${S.count[type]}`, color: PALETTE[(n - 1) % PALETTE.length],
    seedVertex, seedPoint, hidden: false, settings: settings(), ...extra };
  if (!fitFeature(f)) { S.count[type]--; S.seq--; return null; }
  S.features.push(f);
  if (type === 'plane') S.lastPlane = f.id;
  if (!quiet) autoAssign(f);
  buildVisual(f); paintColors();
  if (!quiet) { solve(); renderAll(); }
  return f;
}

// Add a separate face in the same plane to plane f, or drop the face the click landed on.
function toggleFace(f, vertex, point) {
  const faces = [{ vertex: f.seedVertex, point: f.seedPoint }, ...(f.more || [])];
  const sizes = f.stats.faces ? f.stats.faces.map((x) => x.n) : [f.stats.n];
  let at = -1;
  for (let i = 0, off = 0; i < sizes.length; off += sizes[i++]) if (f.vertices.subarray(off, off + sizes[i]).includes(vertex)) at = i;
  if (at >= 0 && faces.length === 1) { toast(`That face is ${f.name}'s only face. Click a separate face in the same plane to add it.`); return; }
  const old = { seedVertex: f.seedVertex, seedPoint: f.seedPoint, more: f.more, fit: f.fit, vertices: f.vertices, stats: f.stats };
  const next = at >= 0 ? faces.filter((_, i) => i !== at) : [...faces, { vertex, point }];
  f.seedVertex = next[0].vertex; f.seedPoint = next[0].point; f.more = next.slice(1);
  if (!fitFeature(f)) { Object.assign(f, old); return; }
  S.lastPlane = f.id;
  buildVisual(f); paintColors(); solve(); renderAll();
  toast(at >= 0 ? `Face ${at + 1} dropped from ${f.name}: ${statLine(f)}` : `${f.name} now spans ${next.length} faces. ${faceLine(f)}`, 'info');
}
function faceLine(f) {
  const fs = f.stats.faces;
  if (!fs) return statLine(f);
  const off = Math.max(...fs.map((x) => Math.abs(x.offset))), tilt = Math.max(...fs.map((x) => x.tilt));
  return `They span ${f.stats.span.toFixed(0)} mm and each sits within ${f3(off)} mm of the shared plane. Fitted alone, a face would tilt up to ${tilt.toFixed(3)}° from it.`;
}
const planeTarget = (shift) => {
  const id = S.addTo || (shift ? S.lastPlane : null);
  return S.features.find((x) => x.id === id && x.type === 'plane') || null;
};

function autoAssign(f) {
  const d = featureDirection(f);
  if (!d) return;
  const sp = S.spec;
  if (!sp.primary.feature) { sp.primary.feature = f.id; return; }
  const p = S.features.find((x) => x.id === sp.primary.feature);
  const pd = p && featureDirection(p);
  if (!sp.secondary.feature && pd && Math.abs(d[0] * pd[0] + d[1] * pd[1] + d[2] * pd[2]) < Math.cos(Math.PI / 12)) sp.secondary.feature = f.id;
}

function removeFeature(id) {
  const f = S.features.find((x) => x.id === id);
  if (!f) return;
  if (S.addTo === id) setTool(null);
  disposeVisual(f);
  S.features = S.features.filter((x) => x !== f);
  const sp = S.spec;
  if (sp.primary.feature === id) sp.primary.feature = '';
  if (sp.secondary.feature === id) sp.secondary.feature = '';
  if (sp.secondary.to === id) sp.secondary.to = '';
  for (const k of ['x', 'y', 'z']) if (sp.origin[k].src === `f:${id}`) sp.origin[k].src = 'bbox:min';
  paintColors(); solve(); renderAll();
}

function disposeVisual(f) {
  if (!f.obj) return;
  featGroup.remove(f.obj);
  f.obj.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  f.obj = null;
}

function buildVisual(f) {
  disposeVisual(f);
  const col = new THREE.Color(f.color), fit = f.fit, grp = new THREE.Group();
  const skin = () => new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false });
  const line = (a, b) => new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: col }));
  if (fit.type === 'plane') {
    const e = fit.extent, w = Math.max(e.w, diag * 0.02) * 1.04, h = Math.max(e.h, diag * 0.02) * 1.04;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(w, h), skin());
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(quad.geometry), new THREE.LineBasicMaterial({ color: col }));
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...e.u), new THREE.Vector3(...e.v), new THREE.Vector3(...fit.normal));
    m.setPosition(...e.center);
    for (const o of [quad, edges]) { o.matrixAutoUpdate = false; o.matrix.copy(m); grp.add(o); }
    const nrm = new THREE.ArrowHelper(new THREE.Vector3(...fit.normal), new THREE.Vector3(...e.center), diag * 0.08, col, diag * 0.02, diag * 0.012);
    grp.add(nrm);
  } else if (fit.type === 'cylinder') {
    const L = Math.max(fit.length, diag * 0.01);
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(fit.radius, fit.radius, L, 72, 1, true), skin());
    cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...fit.axis));
    cyl.position.set(...fit.center);
    grp.add(cyl);
    const a = new THREE.Vector3(...fit.axis), c = new THREE.Vector3(...fit.center), ext = L / 2 + diag * 0.06;
    grp.add(line(c.clone().addScaledVector(a, -ext), c.clone().addScaledVector(a, ext)));
  } else if (fit.type === 'sphere') {
    grp.add(new THREE.Mesh(new THREE.SphereGeometry(fit.radius * 1.002, 40, 20), skin()));
    grp.children[0].position.set(...fit.center);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(diag * 0.004, 12, 8), new THREE.MeshBasicMaterial({ color: col, depthTest: false }));
    dot.position.set(...fit.center); dot.renderOrder = 4;
    grp.add(dot);
  } else {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(diag * 0.006, 16, 10), new THREE.MeshBasicMaterial({ color: col }));
    dot.position.set(...fit.position);
    grp.add(dot);
  }
  grp.renderOrder = 2;
  grp.visible = !f.hidden;
  featGroup.add(grp);
  f.obj = grp;
}

function paintColors() {
  if (!S.mesh || !colors) return;
  const { r, g, b } = meshColor;
  for (let i = 0; i < colors.length; i += 3) { colors[i] = r; colors[i + 1] = g; colors[i + 2] = b; }
  for (const f of S.features) {
    if (f.hidden || !f.vertices) continue;
    const c = new THREE.Color(f.color);
    for (const v of f.vertices) { colors[3 * v] = c.r; colors[3 * v + 1] = c.g; colors[3 * v + 2] = c.b; }
  }
  if (T.on && T.removed) {
    const { r: cr, g: cg, b: cb } = cutColor, R = T.removed;
    for (let v = 0; v < R.length; v++) if (R[v]) { colors[3 * v] = cr; colors[3 * v + 1] = cg; colors[3 * v + 2] = cb; }
  }
  meshObj.geometry.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------- picking
const raycaster = new THREE.Raycaster();
let down = null;
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, b: e.button }; });
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), b = down.b;
  down = null;
  if (S.suppressClick) { S.suppressClick = false; return; }
  if (moved > 5 || b !== 0 || !S.tool || !meshObj) return;
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(meshObj, false)[0];
  if (!hit) { toast('That click missed the mesh.'); return; }
  const local = meshObj.worldToLocal(hit.point.clone());
  const P = S.mesh.positions;
  let best = hit.face.a, bd = Infinity;
  for (const v of [hit.face.a, hit.face.b, hit.face.c]) {
    const d = (P[3 * v] - local.x) ** 2 + (P[3 * v + 1] - local.y) ** 2 + (P[3 * v + 2] - local.z) ** 2;
    if (d < bd) { bd = d; best = v; }
  }
  const tool = S.tool, here = [local.x, local.y, local.z];
  if (tool === 'symmetry') {
    if (!S.pendingPick) {
      S.pendingPick = here;
      showPendingMarker(here);
      $('tool-hint').textContent = 'Mirror: now click the matching point on the other side of the part.';
      return;
    }
    const p1 = S.pendingPick;
    clearPending();
    $('tool-hint').textContent = SYM_FIRST;
    busy('Finding the mirror plane…', () => {
      const r = symmetryFromPoints(S.mesh, p1, here, settings());
      if (r.error) { toast(r.error, 'bad'); return; }
      addSymmetry(r, { normal: r.fit.normal, d: r.fit.normal[0] * r.fit.point[0] + r.fit.normal[1] * r.fit.point[1] + r.fit.normal[2] * r.fit.point[2] });
    });
    return;
  }
  const target = tool === 'plane' && planeTarget(e.shiftKey);
  if (target) { busy(`Refitting ${target.name} across its faces…`, () => toggleFace(target, best, here)); return; }
  busy(`Fitting ${TYPE_LABEL[tool].toLowerCase()}…`, () => {
    const f = addFeatureAt(tool, best, here);
    if (f && f.stats?.curved) toast(`${f.name} is not flat: at double tolerance it takes ${Math.round(f.stats.wideGrow * 100)}% more surface. The plane covers a ${f.fit.extent.w.toFixed(0)} × ${f.fit.extent.h.toFixed(0)} mm strip, and its direction depends on where you click.`, 'warn');
    else if (f) toast(`${f.name} added: ${statLine(f)}`);
  });
});

let pendingObj = null;
function showPendingMarker(p) {
  clearPending(true);
  pendingObj = new THREE.Mesh(new THREE.SphereGeometry(diag * 0.007, 16, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(cssVar('--accent') || '#2a55c9'), depthTest: false }));
  pendingObj.position.set(...p); pendingObj.renderOrder = 6;
  featGroup.add(pendingObj);
}
function clearPending(keepState = false) {
  if (pendingObj) { featGroup.remove(pendingObj); pendingObj.geometry.dispose(); pendingObj.material.dispose(); pendingObj = null; }
  if (!keepState) S.pendingPick = null;
}

function addSymmetry(r, init) {
  const f = addFeatureAt('symmetry', null, null, false, { init, preset: r });
  if (!f) return;
  const pct = Math.round(f.stats.mirrored * 100);
  if (f.stats.mirrored < 0.5) toast(`${f.name}: only ${pct}% of the surface mirrors within ${f.stats.tol} mm. The part may not be symmetric about this plane.`, 'warn');
  else toast(`${f.name}: ${pct}% of the surface mirrors within ${f.stats.tol} mm (RMS ${f3(f.stats.rms)} mm).`);
}

function autoSymmetry() {
  if (!S.mesh) return;
  const st = settings(), ref = perpRefFeature();
  busy(ref ? `Searching for a mirror plane perpendicular to ${ref.name}…` : 'Searching for a mirror plane…', () => {
    const r = st.perpTo ? findSymmetryPerp(S.mesh, st.perpTo, st) : findSymmetry(S.mesh, st);
    if (r.error) { toast(r.error, 'bad'); return; }
    const n = r.fit.normal, p = r.fit.point;
    addSymmetry(r, { normal: n, d: n[0] * p[0] + n[1] * p[1] + n[2] * p[2] });
  });
}

// setTool(t) toggles tool t; setTool('plane', id) arms the plane tool to add faces to plane id.
function setTool(t, addTo = null) {
  clearPending();
  S.tool = addTo ? 'plane' : S.tool === t ? null : t;
  S.addTo = addTo;
  for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === S.tool));
  const into = addTo && S.features.find((x) => x.id === addTo);
  $('tool-hint').textContent = into ? `Adding faces to ${into.name}: click each separate face that lies in the same plane. Click one of its faces again to drop it. Esc when done.`
    : S.tool ? TOOL_HINT[S.tool] : 'Pick a tool, then click the mesh. Drag to orbit, right-drag to pan, scroll to zoom.';
  renderFeatures();
  $('tool-hint').dataset.active = S.tool ? 'yes' : 'no';
  canvas.style.cursor = S.tool ? 'crosshair' : 'grab';
}

// ---------------------------------------------------------------- trim (cutting plane)
const AXI = { x: 0, y: 1, z: 2 };
let cutObj = null, trimRaf = 0;
const displayM = () => (S.result?.ok && S.view === 'aligned' ? S.result.matrix : IDENT4);

function trimCoords() {
  const M = displayM(), k = AXI[T.axis];
  const key = `${T.axis}|${M.flat().join(',')}|${meshGen}`;
  if (key === T.key) return;
  T.coord = frameCoord(S.mesh.positions, M, k);
  let lo = Infinity, hi = -Infinity;
  for (const x of T.coord) { if (x < lo) lo = x; if (x > hi) hi = x; }
  T.lo = lo; T.hi = hi; T.key = key;
  T.ext = projectedExtents(S.mesh, M.slice(0, 3).map((r) => r.slice(0, 3))).map(([a, b], i) => [a + M[i][3], b + M[i][3]]);
  const span = hi - lo || 1;
  if (T.fresh) { T.at = T.above ? hi - 0.03 * span : lo + 0.03 * span; T.fresh = false; }
  T.at = Math.min(hi + 0.05 * span, Math.max(lo - 0.05 * span, T.at));
}

function removeCutObj() {
  if (!cutObj) return;
  scene.remove(cutObj);
  cutObj.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  cutObj = null;
}

function buildCutObj() {
  const k = AXI[T.axis], a = (k + 1) % 3, b = (k + 2) % 3;
  const size = (i) => Math.max((T.ext[i][1] - T.ext[i][0]) * 1.3, diag * 0.1);
  const mid = (i) => (T.ext[i][0] + T.ext[i][1]) / 2;
  const e = (i, s) => new THREE.Vector3(...[0, 1, 2].map((j) => (j === i ? s : 0)));
  const c = [0, 0, 0]; c[a] = mid(a); c[b] = mid(b); c[k] = T.at;
  const m = new THREE.Matrix4().makeBasis(e(a, size(a)), e(b, size(b)), e(k, 1)).setPosition(...c);
  if (!cutObj) {
    cutObj = new THREE.Group();
    const col = cutColor.clone();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(quad.geometry), new THREE.LineBasicMaterial({ color: col }));
    for (const o of [quad, edge]) { o.matrixAutoUpdate = false; cutObj.add(o); }
    cutObj.userData.quad = quad;
    cutObj.renderOrder = 3;
    scene.add(cutObj);
  }
  for (const o of cutObj.children) { o.matrix.copy(m); o.matrixWorldNeedsUpdate = true; }
}

function updateTrim() {
  trimRaf = 0;
  if (!T.on || !S.mesh) { removeCutObj(); T.removed = null; paintColors(); renderTrim(); return; }
  trimCoords();
  T.removed = cutMask(T.coord, T.at, T.above);
  T.nCut = countCutTris(S.mesh.indices, T.removed);
  buildCutObj(); paintColors(); renderTrim();
}
function scheduleTrim() { if (!trimRaf) trimRaf = requestAnimationFrame(updateTrim); }

function renderTrim() {
  $('trim-toggle').setAttribute('aria-pressed', String(T.on));
  $('trim-toggle').textContent = T.on ? 'Hide cutting plane' : 'Show cutting plane';
  $('trim-frame').textContent = S.result?.ok && S.view === 'aligned' ? 'aligned frame' : 'as scanned';
  $('trim-axis').value = T.axis; $('trim-side').value = T.above ? 'above' : 'below';
  for (const id of ['trim-axis', 'trim-side', 'trim-range', 'trim-at']) $(id).disabled = !T.on;
  if (T.on && T.coord) {
    const r = $('trim-range');
    r.min = String(T.lo - 0.05 * (T.hi - T.lo)); r.max = String(T.hi + 0.05 * (T.hi - T.lo));
    r.step = String((T.hi - T.lo) / 4000 || 0.01); r.value = String(T.at);
    if (document.activeElement !== $('trim-at')) $('trim-at').value = T.at.toFixed(2);
    const pct = S.mesh ? (100 * T.nCut) / S.mesh.nT : 0;
    $('trim-count').textContent = T.nCut ? `The red part, ${T.nCut.toLocaleString()} triangles (${pct < 0.1 ? pct.toFixed(2) : pct.toFixed(1)}%), will be removed.` : `Nothing is ${T.above ? 'above' : 'below'} the plane yet.`;
  } else $('trim-count').textContent = '';
  $('trim-apply').disabled = !(T.on && T.nCut);
  $('trim-undo').hidden = !T.undo.length;
}

function setTrimOn(on) { T.on = on; if (on && !T.key) T.fresh = true; updateTrim(); }

function applyTrim() {
  if (!T.on || !T.nCut) return;
  busy('Removing the red part…', () => {
    const r = trimMesh(S.mesh.positions, S.mesh.indices, T.removed);
    if (!r.indices.length) { toast('That cut would remove the whole mesh.', 'bad'); return; }
    T.undo.push({ positions: S.mesh.positions, indices: S.mesh.indices,
      feats: S.features.map((f) => ({ f, vertices: f.vertices, seedVertex: f.seedVertex })) });
    for (const f of S.features) {
      if (f.vertices) { const out = []; for (const v of f.vertices) if (r.map[v] >= 0) out.push(r.map[v]); f.vertices = Uint32Array.from(out); }
      if (f.seedVertex != null) f.seedVertex = r.map[f.seedVertex] >= 0 ? r.map[f.seedVertex] : null;
    }
    buildMeshObject(r.positions, r.indices);
    T.on = false; T.removed = null;
    paintColors(); solve(); renderAll(); updateTrim();
    toast(`Removed ${r.removedTris.toLocaleString()} triangles. Fits are unchanged; refit a feature if the cut touched it.`);
  });
}

function undoTrim() {
  const u = T.undo.pop();
  if (!u) return;
  busy('Restoring…', () => {
    for (const { f, vertices, seedVertex } of u.feats) { f.vertices = vertices; f.seedVertex = seedVertex; }
    buildMeshObject(u.positions, u.indices);
    paintColors(); solve(); renderAll(); updateTrim();
    toast('Trim undone.');
  });
}

// Drag the plane along its axis. Capture phase on the view, so orbiting never starts.
let cutDrag = null;
function rayFrom(e) {
  const r = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  return raycaster.ray;
}
view.addEventListener('pointerdown', (e) => {
  if (!T.on || !cutObj || e.button !== 0 || e.target !== canvas) return;
  rayFrom(e);
  if (!raycaster.intersectObject(cutObj.userData.quad, false).length) return;
  cutDrag = { id: e.pointerId };
  controls.enabled = false; S.suppressClick = true;
  canvas.setPointerCapture?.(e.pointerId);
  canvas.style.cursor = 'ns-resize';
}, true);
view.addEventListener('pointermove', (e) => {
  if (!cutDrag) return;
  const ray = rayFrom(e), k = AXI[T.axis];
  const ax = new THREE.Vector3(...[0, 1, 2].map((j) => (j === k ? 1 : 0)));
  const lp = new THREE.Vector3(...[0, 1, 2].map((j) => (j === k ? T.at : (T.ext[j][0] + T.ext[j][1]) / 2)));
  const w0 = lp.clone().sub(ray.origin), b = ax.dot(ray.direction), d = ax.dot(w0), e2 = ray.direction.dot(w0);
  const den = 1 - b * b;
  if (den < 1e-4) return;  // looking straight along the axis: no drag direction on screen
  const span = T.hi - T.lo;
  T.at = Math.min(T.hi + 0.05 * span, Math.max(T.lo - 0.05 * span, T.at + (b * e2 - d) / den));
  scheduleTrim();
}, true);
window.addEventListener('pointerup', () => {
  if (!cutDrag) return;
  cutDrag = null; controls.enabled = true;
  canvas.style.cursor = S.tool ? 'crosshair' : 'grab';
}, true);

// ---------------------------------------------------------------- solve + camera
function solve() {
  if (!S.mesh) { S.result = null; return; }
  const was = S.result?.ok;
  if (S.override) S.result = { ok: true, matrix: S.override.matrix, override: true };
  else S.result = solveAlignment(S.features, S.spec, S.mesh);
  const M = S.result.ok && S.view === 'aligned' ? S.result.matrix : [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  world.matrix.set(...M.flat());
  world.matrixWorldNeedsUpdate = true;
  if (T.on) scheduleTrim();
  if (S.view === 'aligned' && S.result.ok && !was) requestAnimationFrame(() => fitView('iso'));
}

function fitView(which) {
  if (!meshObj) return;
  world.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(meshObj);
  const c = box.getCenter(new THREE.Vector3()), rad = box.getSize(new THREE.Vector3()).length() / 2 || 50;
  const dirs = { top: [0, -0.0001, 1], front: [0, -1, 0.0001], right: [1, 0, 0.0001], iso: [1, -1.1, 0.8] };
  const d = new THREE.Vector3(...dirs[which]).normalize();
  const dist = (rad / Math.sin(THREE.MathUtils.degToRad(persp.fov / 2))) * 1.05;
  camera.position.copy(c).addScaledVector(d, dist);
  camera.near = dist / 200; camera.far = dist * 50;
  if (camera === ortho) { orthoHalf = rad * 1.05 / Math.min(1, aspect); ortho.zoom = 1; setOrthoFrustum(); }
  camera.updateProjectionMatrix();
  controls.target.copy(c);
  controls.update();
}

// ---------------------------------------------------------------- panels
const f3 = (x) => (Math.abs(x) < 5e-4 ? 0 : x).toFixed(3);
const escH = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function statLine(f) {
  const s = f.stats;
  if (f.type === 'point') return `at ${f.fit.position.map(f3).join(', ')} (scan coordinates)`;
  if (f.type === 'symmetry') return `${Math.round(s.mirrored * 100)}% mirrors within ${s.tol} mm · RMS ${f3(s.rms)} mm`;
  const pts = `${s.n.toLocaleString()} pts`;
  if (f.type === 'plane') return `${s.faces ? `${s.faces.length} faces · ` : ''}${pts} · RMS ${f3(s.rms)} · flatness ${f3(s.pv)} mm${s.curved ? ' · not flat' : ''}`;
  return `Ø ${f3(2 * f.fit.radius)} mm · ${pts} · RMS ${f3(s.rms)} mm`;
}

function renderAll() { renderFile(); renderFeatures(); renderSelects(); renderStatus(); renderTrim(); }

function renderFile() {
  const m = S.mesh;
  $('file-info').hidden = !m;
  if (!m) return;
  const { min, max } = m.bbox;
  $('fi-name').textContent = S.name;
  $('fi-tris').textContent = m.nT.toLocaleString();
  const r = S.result;
  const ext = r && r.ok ? projectedExtents(m, r.matrix.slice(0, 3).map((row) => row.slice(0, 3))) : [0, 1, 2].map((k) => [min[k], max[k]]);
  $('fi-size-l').textContent = r && r.ok ? 'Size, aligned' : 'Size, as scanned';
  $('fi-size').textContent = ext.map(([lo, hi]) => (hi - lo).toFixed(1)).join(' × ') + ' mm';
  $('fi-unit').textContent = S.unitLabel;
  $('example-note').hidden = !S.example;
  $('unit-row').hidden = !S.source || S.source.ext === '3mf';
}

const ICONS = {
  eye: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M1.5 10S5 4 10 4s8.5 6 8.5 6S15 16 10 16 1.5 10 1.5 10Z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="10" r="2.6" fill="currentColor"/></svg>',
  eyeOff: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M1.5 10S5 4 10 4s8.5 6 8.5 6S15 16 10 16 1.5 10 1.5 10Z" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".45"/><path d="M3 17 17 3" stroke="currentColor" stroke-width="1.6"/></svg>',
  faces: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="9" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M14.5 5v8M10.5 9h8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  refit: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 10a6 6 0 1 1-2-4.5M16 3v4h-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  del: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
};

function renderFeatures() {
  const ul = $('feat-list');
  $('feat-empty').hidden = S.features.length > 0;
  ul.innerHTML = S.features.map((f) => `
    <li class="feat${f.hidden ? ' is-hidden' : ''}${f.stats?.curved ? ' is-curved' : ''}" style="--fc:${f.color}">
      <span class="sw" aria-hidden="true"></span>
      <div class="fmain"><div class="fname"><b>${f.name}</b> ${TYPE_LABEL[f.type]}${roleOf(f)}${f.settings?.perpRef ? ` <span class="perp" title="Kept perpendicular to ${escH(nameOf(f.settings.perpRef))}">⊥ ${escH(nameOf(f.settings.perpRef))}</span>` : ''}</div>
        <div class="fstat">${escH(statLine(f))}</div></div>
      <div class="fact">
        <button class="ib" data-act="hide" data-id="${f.id}" title="${f.hidden ? 'Show' : 'Hide'} ${f.name}" aria-label="${f.hidden ? 'Show' : 'Hide'} ${f.name}">${f.hidden ? ICONS.eyeOff : ICONS.eye}</button>
        ${f.type === 'plane' ? `<button class="ib" data-act="faces" data-id="${f.id}" aria-pressed="${S.addTo === f.id}" title="Add separate faces in the same plane to ${f.name}" aria-label="Add faces to ${f.name}">${ICONS.faces}</button>` : ''}
        ${f.type === 'point' ? '' : `<button class="ib" data-act="refit" data-id="${f.id}" title="Refit ${f.name} with the current fit settings" aria-label="Refit ${f.name}">${ICONS.refit}</button>`}
        <button class="ib" data-act="del" data-id="${f.id}" title="Delete ${f.name}" aria-label="Delete ${f.name}">${ICONS.del}</button>
      </div>
    </li>`).join('');
}

const nameOf = (id) => S.features.find((x) => x.id === id)?.name || '?';
function roleOf(f) {
  const sp = S.spec, r = [];
  if (sp.primary.feature === f.id) r.push(sp.primary.axis.toUpperCase());
  if (sp.secondary.feature === f.id || sp.secondary.to === f.id) r.push(sp.secondary.axis.toUpperCase());
  for (const k of ['x', 'y', 'z']) if (sp.origin[k].src === `f:${f.id}`) r.push(`${k.toUpperCase()}₀`);
  return r.length ? ` <span class="role">${r.join(' ')}</span>` : '';
}

function fillSelect(sel, opts, value) {
  sel.innerHTML = opts.map(([v, t]) => `<option value="${escH(v)}">${escH(t)}</option>`).join('');
  sel.value = opts.some(([v]) => v === value) ? value : opts[0][0];
}

function renderSelects() {
  const sp = S.spec, fs = S.features;
  const dirF = fs.filter((f) => featureDirection(f));
  const label = (f) => `${f.name} ${TYPE_LABEL[f.type].toLowerCase()}`;
  fillSelect($('p-feat'), [['', dirF.length ? 'Choose…' : 'Add a plane or cylinder'], ...dirF.map((f) => [f.id, label(f)])], sp.primary.feature);
  fillSelect($('s-feat'), [['', fs.length ? 'Choose…' : 'Add a feature'], ...fs.map((f) => [f.id, label(f)])], sp.secondary.feature);
  const sf = fs.find((f) => f.id === sp.secondary.feature);
  const ptF = fs.filter((f) => f.fit.type !== 'plane' && f.id !== sp.secondary.feature);
  const sNeedsTo = sf && !featureDirection(sf);
  fillSelect($('s-to'), [['', sNeedsTo ? 'Choose a second feature…' : 'its own direction'], ...ptF.map((f) => [f.id, `line to ${f.name}`])], sp.secondary.to);
  $('s-to').disabled = !sf || sf.fit.type === 'plane';
  const oOpts = [['bbox:min', 'Box min'], ['bbox:mid', 'Box center'], ['bbox:max', 'Box max'], ...fs.map((f) => [`f:${f.id}`, f.name])];
  for (const k of ['x', 'y', 'z']) fillSelect($(`o-${k}`), oOpts, sp.origin[k].src);
  $('p-axis').value = sp.primary.axis; $('s-axis').value = sp.secondary.axis;
  $('p-flip').setAttribute('aria-pressed', String(sp.primary.flip));
  $('s-flip').setAttribute('aria-pressed', String(sp.secondary.flip));
  const dis = !!S.override;
  for (const id of ['p-axis', 'p-feat', 'p-flip', 's-axis', 's-feat', 's-flip', 'o-x', 'o-y', 'o-z']) $(id).disabled = dis;
  if (dis) $('s-to').disabled = true;
  fillSelect($('perp-ref'), [['', 'nothing (free)'], ...dirF.map((f) => [f.id, label(f)])], $('perp-ref').value);
  const ref = perpRefFeature();
  $('auto-sym').textContent = ref ? `Find symmetry plane perpendicular to ${ref.name}` : 'Find symmetry plane automatically';
}

function renderStatus() {
  const el = $('align-status'), r = S.result;
  const chip = (kind, text) => `<span class="chip" data-kind="${kind}">${text}</span>`;
  $('export-btn').disabled = !S.mesh;
  $('export-btn').textContent = r && r.ok ? 'Save aligned 3MF' : 'Save 3MF as is';
  if (!S.mesh) { el.innerHTML = chip('need', 'No mesh'); $('matrix').textContent = ''; return; }
  if (!r.ok) {
    el.innerHTML = `${chip(r.need ? 'need' : 'bad', r.need ? 'Needs input' : 'Problem')}<p>${escH(r.message)}</p>`;
    $('matrix').textContent = '';
    return;
  }
  const M = r.matrix;
  $('matrix').textContent = M.slice(0, 3).map((row) => row.slice(0, 3).map((x) => x.toFixed(6).padStart(10)).join(' ') + '  │ ' + row[3].toFixed(4).padStart(10)).join('\n');
  if (r.override) {
    el.innerHTML = `${chip('ok', 'Saved transform')}<p>Using the transform from <b>${escH(S.override.name)}</b>. The feature settings above are ignored.</p><button class="btn small" id="clear-override">Stop using it</button>`;
    $('clear-override').onclick = () => { S.override = null; solve(); renderAll(); };
    return;
  }
  const sq = Math.abs(90 - r.secondaryAngle);
  const used = new Set([S.spec.primary.feature, S.spec.secondary.feature, S.spec.secondary.to,
    ...['x', 'y', 'z'].map((k) => S.spec.origin[k].src.slice(2))].filter(Boolean));
  const curvedUsed = S.features.filter((f) => used.has(f.id) && f.stats?.curved).map((f) => f.name);
  const q = S.features.filter((f) => used.has(f.id) && f.stats).map((f) => `${f.name} ${f3(f.stats.rms)}`).join(' · ');
  el.innerHTML = `${chip('ok', 'Aligned')}
    <dl class="kv">
      <dt>Secondary</dt><dd>${escH(r.secondaryFrom)} sits ${r.secondaryAngle.toFixed(3)}° from the primary${sq > 0.0005 ? `; squared up by ${sq.toFixed(3)}°` : ''}.</dd>
      <dt>Origin</dt><dd>X ${escH(r.originFrom[0])} · Y ${escH(r.originFrom[1])} · Z ${escH(r.originFrom[2])}</dd>
      ${q ? `<dt>Fit RMS</dt><dd>${escH(q)} mm</dd>` : ''}
      ${curvedUsed.length ? `<dt class="warn">Check</dt><dd class="warn">${escH(curvedUsed.join(', '))} ${curvedUsed.length > 1 ? 'are' : 'is'} not flat, so ${curvedUsed.length > 1 ? 'their directions depend' : 'its direction depends'} on where you clicked.</dd>` : ''}
    </dl>`;
}

// ---------------------------------------------------------------- export
function concatChunks(chunks) {
  const enc = new TextEncoder(), parts = chunks.map((c) => enc.encode(c));
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const mul4 = (A, B) => A.map((row) => [0, 1, 2, 3].map((j) => row.reduce((s, x, k) => s + x * B[k][j], 0)));
function exportMatrix() { return S.result?.ok ? S.result.matrix : IDENT4; }
function transformJSON() {
  const r = S.result, ok = !!r?.ok, sp = S.spec, byId = new Map(S.features.map((f) => [f.id, f]));
  const prior = S.prior && checkRigid(S.prior.matrix_row_major) === null ? S.prior : null;
  const M = prior ? mul4(exportMatrix(), prior.matrix_row_major) : exportMatrix();
  const nm = (id) => byId.get(id)?.name || null;
  const round = (x) => Math.round(x * 1e9) / 1e9;
  const fit = (f) => JSON.parse(JSON.stringify(f.fit, (k, v) => (typeof v === 'number' ? round(v) : k === 'extent' ? undefined : v)));
  return JSON.stringify({
    tool: 'Mesh Align', version: 1, source: prior?.source || S.name, created: new Date().toISOString(), units: 'mm',
    matrix_row_major: M.map((row) => row.map(round)),
    note: prior ? `aligned = M · [x, y, z, 1], with ${prior.source || 'source'} coordinates in millimeters (includes the alignment saved in ${S.name})`
      : 'aligned = M · [x, y, z, 1], with source coordinates in millimeters',
    previous: prior ? { file: S.name, matrix_row_major: prior.matrix_row_major, alignment: prior.alignment } : undefined,
    trims: T.undo.length || undefined,
    alignment: !ok ? { saved_as_is: true } : r.override ? { from_saved_transform: S.override.name } : {
      primary: { axis: sp.primary.axis, feature: nm(sp.primary.feature), flip: sp.primary.flip },
      secondary: { axis: sp.secondary.axis, feature: nm(sp.secondary.feature), line_to: nm(sp.secondary.to), flip: sp.secondary.flip,
        angle_to_primary_deg: round(r.secondaryAngle) },
      origin: Object.fromEntries(['x', 'y', 'z'].map((k, i) => [k, r.originFrom[i]])),
    },
    features: S.features.map((f) => ({ name: f.name, type: f.type, fit: fit(f), stats: f.stats, settings: f.settings })),
  }, null, 2);
}

async function exportAligned() {
  if (!S.mesh) return;
  const base = ($('out-name').value.trim() || 'aligned').replace(/[\\/:*?"<>|]+/g, '-');
  try {
    const threemf = await busy('Writing the aligned 3MF…', () => {
      const P2 = transformPositions(S.mesh.positions, exportMatrix());
      const parts = build3MF(P2, S.mesh.indices, { Title: base, Application: 'Mesh Align', Description: `Aligned from ${S.name}` }, transformJSON());
      return zipSync({
        '[Content_Types].xml': strToU8(parts['[Content_Types].xml']),
        '_rels/.rels': strToU8(parts['_rels/.rels']),
        '3D/3dmodel.model': [concatChunks(parts['3D/3dmodel.model']), { level: 6 }],
      });
    });
    const dl = await downloadsP;
    if (dl) {
      // The claude.ai viewer cannot save a .3mf directly, only inside a .zip.
      const zip = await busy('Packing the download…', () => zipSync({ [`${base}.3mf`]: [threemf, { level: 0 }] }));
      await dl.save({ filename: `${base}.zip`, data: new Blob([zip]) });
      toast(`Saved ${base}.zip.`);
    } else if (inViewer) {
      toast('Saving files is not available in this view. Open the page in claude.ai in a browser.', 'bad');
    } else {
      save(`${base}.3mf`, new Blob([threemf], { type: 'model/3mf' }));
      toast(`Saved ${base}.3mf.`);
    }
  } catch (e) {
    if (e?.code === 'declined') toast('Save canceled.');
    else { console.error(e); toast(`Could not save: ${e.message || e.code}`, 'bad'); }
  }
}
function save(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

async function applySavedTransform(file) {
  try {
    let text;
    if (/\.3mf$/i.test(file.name)) {
      const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => /\.model$/i.test(f.name) });
      text = readEmbeddedTransform(files);
      if (!text) { toast(`${file.name} holds no Mesh Align transform. Only 3MF files saved by Mesh Align carry one.`, 'bad'); return; }
    } else text = await file.text();
    const j = JSON.parse(text);
    const err = checkRigid(j.matrix_row_major);
    if (err) { toast(`${file.name}: ${err}`, 'bad'); return; }
    S.override = { matrix: j.matrix_row_major, name: file.name };
    solve(); renderAll(); fitView('iso');
    toast(`Applied the transform from ${file.name}.`);
  } catch (e) { toast(`${file.name} has no readable Mesh Align transform.`, 'bad'); }
}

// ---------------------------------------------------------------- wiring
$('file-in').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openFile(f); });
$('tf-in').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f && S.mesh) applySavedTransform(f); });
$('unit-sel').addEventListener('change', () => { if (S.source && S.source.ext !== '3mf') loadSource(); });
$('example-btn').addEventListener('click', () => busy('Generating the example block…', loadExample));
for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => fitView(b.dataset.view));
for (const b of document.querySelectorAll('[data-frame]')) b.addEventListener('click', () => {
  S.view = b.dataset.frame;
  for (const x of document.querySelectorAll('[data-frame]')) x.setAttribute('aria-pressed', String(x === b));
  solve(); fitView('iso');
});
$('feat-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const f = S.features.find((x) => x.id === b.dataset.id);
  if (!f) return;
  if (b.dataset.act === 'del') removeFeature(f.id);
  else if (b.dataset.act === 'faces') setTool('plane', S.addTo === f.id ? null : f.id);
  else if (b.dataset.act === 'hide') { f.hidden = !f.hidden; f.obj && (f.obj.visible = !f.hidden); paintColors(); renderFeatures(); }
  else if (b.dataset.act === 'refit') busy(`Refitting ${f.name}…`, () => {
    const old = { fit: f.fit, vertices: f.vertices, stats: f.stats, settings: f.settings };
    f.settings = settings();
    if (!fitFeature(f)) Object.assign(f, old);
    else toast(`${f.name} refit: ${statLine(f)}`);
    buildVisual(f); paintColors(); solve(); renderAll();
  });
});
const onSpec = () => {
  const sp = S.spec;
  sp.primary.feature = $('p-feat').value;
  sp.secondary.feature = $('s-feat').value;
  sp.secondary.to = $('s-to').disabled ? '' : $('s-to').value;
  for (const k of ['x', 'y', 'z']) sp.origin[k].src = $(`o-${k}`).value;
  solve(); renderAll();
};
for (const id of ['p-feat', 's-feat', 's-to', 'o-x', 'o-y', 'o-z']) $(id).addEventListener('change', onSpec);
const AX = ['x', 'y', 'z'];
$('p-axis').addEventListener('change', () => {
  const sp = S.spec; sp.primary.axis = $('p-axis').value;
  if (sp.secondary.axis === sp.primary.axis) sp.secondary.axis = AX.find((a) => a !== sp.primary.axis);
  solve(); renderAll();
});
$('s-axis').addEventListener('change', () => {
  const sp = S.spec; sp.secondary.axis = $('s-axis').value;
  if (sp.secondary.axis === sp.primary.axis) sp.primary.axis = AX.find((a) => a !== sp.secondary.axis);
  solve(); renderAll();
});
$('p-flip').addEventListener('click', () => { S.spec.primary.flip = !S.spec.primary.flip; solve(); renderAll(); });
$('s-flip').addEventListener('click', () => { S.spec.secondary.flip = !S.spec.secondary.flip; solve(); renderAll(); });
$('export-btn').addEventListener('click', exportAligned);
$('trim-toggle').addEventListener('click', () => setTrimOn(!T.on));
$('trim-axis').addEventListener('change', () => { T.axis = $('trim-axis').value; T.fresh = true; T.key = ''; updateTrim(); });
$('trim-side').addEventListener('change', () => { T.above = $('trim-side').value === 'above'; updateTrim(); });
$('trim-range').addEventListener('input', () => { T.at = +$('trim-range').value; scheduleTrim(); });
$('trim-at').addEventListener('change', () => { const v = +$('trim-at').value; if (Number.isFinite(v)) { T.at = v; updateTrim(); } });
$('trim-apply').addEventListener('click', applyTrim);
$('trim-undo').addEventListener('click', undoTrim);
$('auto-sym').addEventListener('click', autoSymmetry);
$('perp-ref').addEventListener('change', () => renderSelects());
for (const b of document.querySelectorAll('[data-proj]')) b.addEventListener('click', () => setProjection(b.dataset.proj));
$('export-hint').textContent = inViewer
  ? 'claude.ai can only save it inside a .zip; the offline copy of this page saves the .3mf directly. The transform travels inside the 3MF, so "Apply a saved transform" can read it back.'
  : 'Saves one .3mf in millimeters. The transform travels inside it, so "Apply a saved transform" can read it back from that file.';

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'escape' && S.tool) setTool(S.tool);
  const map = { p: 'plane', c: 'cylinder', s: 'sphere', t: 'point', m: 'symmetry' };
  if (map[k] && !e.ctrlKey && !e.metaKey && !e.altKey) setTool(map[k]);
  if (k === 'f' && !e.ctrlKey && !e.metaKey) fitView('iso');
});

let dragDepth = 0;
view.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').hidden = false; });
view.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
view.addEventListener('dragover', (e) => e.preventDefault());
view.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('drop').hidden = true;
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});

setTool(null);
applyTheme();
loadExample();
try { if (localStorage.getItem('meshAlignProj') === 'ortho') setProjection('ortho'); } catch { /* ignore */ }
window.__meshAlign = { S, T, controls, solve, fitView, setTool, setProjection, get camera() { return camera; }, THREE };
