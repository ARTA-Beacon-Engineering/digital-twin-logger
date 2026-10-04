import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { CAGE, STATION, derive } from './config.js';
import { PARTS } from './parts.js';
import { concreteTex } from './textures.js';
import { LID_MAX, lidLimit } from './physics.js';
import { tagHooks } from './labels.js';
import { buildMonopole } from './model/monopole.js';
import { live } from './state.js';
import { createPipeline, LAYER } from './render.js';
import { SITES, buildWorld } from './world.js';
import { createMap } from './mapView.js';
import { ENV, stepEnv } from './env.js';
import { createRain } from './weather.js';
import { mountEnvPanel } from './envPanel.js';

// Satu scene untuk semua: dunia bersama (world.js) + model lengkap tiap stasiun di lokasinya (SITES).
// Mode peta (halaman awal) = kamera menjauh + penanda; mode logger = kamera mendekat ke stasiun + panel kontrol.
// Karena scene-nya sama, saat titik di peta diklik tampilannya menyambung (bukan peta terpisah).
// Koordinat scene = dunia; "lokal" = kerangka stasiun aktif (muka krangkeng +z) — pandangan & flyTo panel memakai lokal.
const EN = { encY: 1.5 };                                                         // tinggi pasang box (tengah box, m); dibatasi encRange
let product = null, entry = null, params = null, mode = 'loading';               // produk aktif, datanya, ukuran stasiunnya
const entries = {};                                                               // id → { prod, params, model }
let MAP_IDS = [], onOpenCb = () => {};

// ---------- Renderer & scene ----------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
Object.assign(labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
app.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.02, 3000);   // jauh: perbukitan & awan latar
camera.layers.enable(LAYER.NO_AO);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.zoomSpeed = 1.8;                                          // pinch-zoom layar sentuh
const LIMITS = {
  map: { minDistance: 4, maxDistance: 650, maxPolarAngle: Math.PI * 0.46, dampingFactor: 0.08, shadow: 140 },
  product: { minDistance: 0.3, maxDistance: 120, maxPolarAngle: Math.PI * 0.495, dampingFactor: 0.12, shadow: 60 },
};
const hemi = new THREE.HemisphereLight(0xffffff, 0x8a9a7a, 0.25);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff6e8, 2.6);    // posisi & kotak bayangan diatur pipeline (ikut fokus kamera)
sun.castShadow = true;
scene.add(sun, sun.target);
const pipeline = createPipeline({ renderer, scene, camera, controls, sun, hemi });

const invalidate = () => { pipeline.invalidateShadow(); };                        // posisi / bentuk benda berubah
const requestRender = () => {};
for (const ev of ['input', 'change', 'click', 'keydown']) addEventListener(ev, invalidate);
if (import.meta.env.DEV) window.__twin = { renderer, pipeline, camera, controls, env: ENV };   // hook debug (hanya npm run dev)

let world = null, map = null, envPanel = null;
const rain = createRain(scene);                                   // hujan tampak (env.js → ENV.rainVis)

// Tanah basah saat / sesudah hujan: medan (isGround) lebih gelap & lebih mengilap. Daftar bahan dikumpulkan ulang bila
// ada model baru (mis. medan EWS dibangun ulang).
let wetMats = null, wetLast = -1;
function applyWet(w) {
  if (!wetMats) {
    wetMats = new Set(); wetLast = -1;
    scene.traverse(o => { if (o.isMesh && o.userData.isGround) wetMats.add(o.material); });
    for (const m of wetMats) m.userData.dry ??= { r: m.roughness, c: m.color.clone() };
  }
  const k = Math.round(w * 40) / 40;
  if (k === wetLast) return;
  wetLast = k;
  for (const m of wetMats) { m.roughness = m.userData.dry.r - 0.3 * k; m.color.copy(m.userData.dry.c).multiplyScalar(1 - 0.24 * k); }
}

// ---------- State ----------
let model = null, selected = null, hovered = null, tagObjs = [], dimLabels = [];
let xray = document.getElementById('xray').checked, labelsOn = document.getElementById('labels').checked,
    dimsOn = document.getElementById('dims').checked, explodeT = +document.getElementById('explode').value;

function disposeModel(obj) {
  obj.traverse(o => {
    if (o.isMesh) { o.geometry.dispose(); const m = o.material; for (const k of ['bumpMap', 'alphaMap', 'map']) if (m[k] && m[k] !== concreteTex) m[k].dispose(); m.dispose(); }
    if (o.isLineSegments) o.geometry.dispose();
    if (o.isCSS2DObject) o.element.remove();
  });
}
// Label & garis dimensi model yang tidak aktif disembunyikan (yang aktif diatur tiap frame oleh updateLabels)
function hideLabelsOf(m) { m?.traverse(o => { if (o.isCSS2DObject || o.userData.isDim) o.visible = false; }); }

// Model lengkap satu stasiun di lokasinya (dibangun di titik asal lalu dipindah ke SITES)
function makeModel(E) {
  const m = buildMonopole(E.params, { pvBulge: E.prod.pvBulge?.(derive(E.params)) });
  E.prod.extend?.(m, { params: E.params, d: m.userData.d });                    // sensor / visual khusus seri
  const s = SITES[E.prod.id] ?? { x: 0, y: 0, z: 0, rot: 0 };
  m.position.set(s.x, s.y, s.z); m.rotation.y = s.rot; m.updateMatrixWorld(true);
  scene.add(m);
  wetMats = null;                                                                 // medan baru ikut basah / kering
  return m;
}
function newEntry(prod) { return { prod, params: { ...STATION, ...prod.station, encY: EN.encY }, model: null }; }

function encRange() {                                        // batas tinggi pasang box: di atas stiffener, krangkeng di bawah antipanjat
  const d0 = derive(params), yP1 = d0.yP1, ehm = CAGE.H / 1000;
  const eMin = Math.ceil((yP1 + d0.gh / 1000 + ehm / 2 + 0.2) * 20) / 20;
  let eMax = Math.floor((yP1 + params.height - 0.7 - 0.55 - d0.mpH / 2000) * 20) / 20;
  if (product?.encYMax) eMax = Math.min(eMax, Math.floor(product.encYMax(d0) * 20) / 20);   // batas tambahan per seri
  eMax = Math.max(eMin, eMax);
  const clamped = Math.min(eMax, Math.max(eMin, params.encY)), changed = clamped !== params.encY;
  params.encY = clamped;
  return changed;
}
function adoptModel() {                                      // model aktif: kumpulkan label & terapkan tampilan
  tagObjs = []; dimLabels = [];
  model.traverse(o => { if (o.userData.isTag) tagObjs.push(o); else if (o.userData.isDimLabel) dimLabels.push(o); });
  invalidate(); lidMaxFor = null;
  applyXray(); applyExplode(); applyDims(); refreshHighlight(); renderInfo();
}
function rebuild() {
  encRange();
  if (entry.model) { scene.remove(entry.model); disposeModel(entry.model); }
  model = entry.model = makeModel(entry);
  adoptModel();
}

function applyXray() {
  const set = o => {
    if (o.isMesh && (o.userData.part === 'foundation' || o.userData.part === 'grout' || o.userData.isGround)) {
      o.material.transparent = xray; o.material.opacity = xray ? (o.userData.isGround ? 0.2 : 0.18) : 1;
      o.material.depthWrite = !xray; o.castShadow = o.userData.isGround ? false : !xray; o.material.needsUpdate = true;
      o.layers.set(xray ? LAYER.NO_AO : 0);
    }
  };
  model?.traverse(set);
  world?.group.traverse(o => { if (o.userData.isGround) set(o); });              // medan dunia ikut transparan
  for (const E of Object.values(entries)) if (E.model && E.model !== model) E.model.traverse(o => { if (o.userData.isGround) set(o); });
  if (mode === 'product') controls.maxPolarAngle = xray ? Math.PI * 0.6 : LIMITS.product.maxPolarAngle;
}

// Explode berurutan, seperti membongkar di lapangan:
// 1) pintu krangkeng dibuka  2) konektor SP21 dilepas, kabel + conduit diturunkan & dijauhkan  3) enclosure dikeluarkan
// 4) mur, baut & strap klem krangkeng dilepas  5) krangkeng lepas dari tiang  6) mur U-bolt panel surya dilepas,
// U-bolt ditarik, panel + bracket dijauhkan  7) baut kerah antipanjat dilepas, kedua belahan dijauhkan  8) tiang & pondasi diurai
// w = bobot durasi. Seri bisa menyisipkan langkah sendiri (products.js → explode.steps, `before` = kunci langkah dasar).
const BASE_STEPS = [
  { key: 'door', w: 12, label: 'buka pintu krangkeng' },
  { key: 'cable', w: 9, label: 'lepas konektor SP21, kabel dilepas' },
  { key: 'enc', w: 11, label: 'lepas baut box, enclosure keluar' },
  { key: 'clamp', w: 13, label: 'lepas mur, baut & strap klem' },
  { key: 'cage', w: 10, label: 'krangkeng lepas dari tiang' },
  { key: 'pv', w: 15, label: 'lepas U-bolt, panel surya dijauhkan' },
  { key: 'ac', w: 10, label: 'lepas baut, antipanjat dibuka' },
  { key: 'base', w: 20, label: 'urai tiang & pondasi' },
];
let steps = [];
function buildSteps() {
  const s = [...BASE_STEPS];
  for (const st of product?.explode?.steps ?? []) s.splice(s.findIndex(b => b.key === st.before), 0, st);
  const W = s.reduce((a, b) => a + b.w, 0);
  let acc = 0;
  steps = s.map(st => { const a = acc / W; acc += st.w; return { ...st, a, b: acc / W }; });
}
let explodePh = { door: 0 };
function applyExplode() {
  if (!model) return;
  const t = explodeT, S = Object.fromEntries(steps.map(s => [s.key, s]));
  // seg(kunci, a, b): kemajuan 0..1 di bagian [a, b] dari langkah tersebut
  const seg = (key, a = 0, b = 1) => { const s = S[key]; return THREE.MathUtils.smoothstep(t, s.a + (s.b - s.a) * a, s.a + (s.b - s.a) * b); };
  const eDoor = seg('door'), eCabDn = seg('cable', 0, 0.44), eCabOut = seg('cable', 0.44, 1);
  const eMBolt = seg('enc', 0, 0.36), eEnc = seg('enc', 0.36, 1);
  const eNut = seg('clamp', 0, 0.38), eBolt = seg('clamp', 0.23, 0.69), eStrap = seg('clamp', 0.54, 1);
  const eCage = seg('cage');
  const ePvNut = seg('pv', 0, 0.33), ePvU = seg('pv', 0.2, 0.6), ePv = seg('pv', 0.47, 1);
  const eAcBolt = seg('ac', 0, 0.4), eAc = seg('ac', 0.3, 1), eBase = seg('base');
  explodePh = { door: eDoor };
  const G = model.userData.groups, C = model.userData.clamp, PV = model.userData.pv, AC = model.userData.antiClimb;
  for (const [k, y] of [['foundation', 0], ['conduit', 0], ['grout', 0.1], ['bolts', 0.8], ['levelNuts', 1.0],
                        ['weldment', 1.2], ['topNuts', 1.5]]) G[k].position.set(0, y * eBase, 0);
  // Kabel panel: plug diputar lepas lalu seluruh kabel + conduit diturunkan (keluar dari lubang mesh & junction box),
  // kemudian dijauhkan mendatar lewat celah jari antipanjat
  const [cdx, cdz] = model.userData.pvCableDir;
  G.pvCable.position.set(cdx * 0.45 * eCabOut, -0.18 * eCabDn, cdz * 0.45 * eCabOut);
  model.userData.encMount.bolts.position.set(0, 0, -0.12 * eMBolt);   // baut box ditarik ke belakang, lepas dari mur tanam
  G.enclosure.position.set(0, 0, 0.8 * eEnc);                    // keluar lewat muka depan krangkeng
  G.cage.position.set(0, 0, 0.35 * eCage);                       // badan + pintu krangkeng menjauh dari tiang
  C.front.position.set(0, 0, 0.35 * eCage);                      // setengah klem depan dilas ke krangkeng
  C.nutL.position.set(-0.12 * eNut, 0, 0.015 * eNut);
  C.nutR.position.set(0.12 * eNut, 0, 0.015 * eNut);
  C.bolts.position.set(0, 0, -0.18 * eBolt);                     // baut ditarik ke belakang
  C.strap.position.set(0, 0, -0.09 * eStrap);                    // strap belakang dilepas
  // Panel surya (koordinat lokal: panel ke arah −z). Mur ikut rakitan agar tidak tertembus plat belakang.
  PV.nuts.position.set(0, 0, -(0.1 * ePvNut + 0.6 * ePv));
  PV.ubolt.position.set(0, 0, 0.3 * ePvU);                       // U-bolt ditarik ke depan, lepas dari tiang
  PV.asm.position.set(0, 0, -0.6 * ePv);                         // bracket + panel dijauhkan mendatar
  // Antipanjat: baut ditarik ke depan & mur ke belakang, lalu belahan depan / belakang dijauhkan mendatar
  AC.bolts.position.set(0, 0, 0.12 * eAcBolt + 0.45 * eAc);
  AC.nuts.position.set(0, 0, -(0.1 * eAcBolt + 0.45 * eAc));
  AC.front.position.set(0, 0, 0.45 * eAc);
  AC.back.position.set(0, 0, -0.45 * eAc);
  product?.explode?.apply?.(model, seg, t);                     // bagian khusus seri
  const step = t <= 0 ? null : steps.find(s => t <= s.b) ?? steps.at(-1);
  document.getElementById('explodeOut').textContent = `${Math.round(t * 100)}%${step ? ' · ' + step.label : ''}`;
}

function applyDims() {
  model?.traverse(o => { if (o.userData.isDim) o.traverse(c => c.visible = dimsOn); });
}

function refreshHighlight() {
  if (!model) return;
  model.traverse(o => {
    if (!o.isMesh || !o.userData.part || !o.material.emissive) return;           // bahan tanpa emissive (mis. MeshBasic) dilewati
    const sel = o.userData.part === selected, hov = o.userData.part === hovered;
    o.material.emissive.setHex(sel ? 0x1d5fd6 : hov ? 0x1d5fd6 : 0x000000);
    o.material.emissiveIntensity = sel ? 0.55 : hov ? 0.28 : 0;
  });
  document.querySelectorAll('.tag').forEach(el => el.classList.toggle('active', el.dataset.part === selected));
  renderer.domElement.style.cursor = hovered ? 'pointer' : '';
}

function select(part) {
  selected = part === selected ? null : part;
  refreshHighlight(); renderInfo();
}

function renderInfo() {
  const box = document.getElementById('info');
  document.getElementById('hint').style.visibility = selected ? 'hidden' : '';
  if (!selected || !model) { box.hidden = true; return; }
  const P = product?.parts?.[selected] ?? PARTS[selected], d = model.userData.d;
  document.getElementById('infoKicker').textContent = P.group;
  document.getElementById('infoTitle').textContent = P.name;
  document.getElementById('infoSpecs').innerHTML = P.specs(d).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  box.hidden = false;
}

// Aksi label 3D
tagHooks.click = part => select(part);
tagHooks.enter = part => { hovered = part; refreshHighlight(); };
tagHooks.leave = () => { hovered = null; refreshHighlight(); };

// ---------- Interaksi 3D ----------
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
function pick(ev) {
  if (!model) return null;
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const shown = o => { for (let q = o; q; q = q.parent) if (!q.visible) return false; return true; };   // abaikan bagian tersembunyi
  const hits = raycaster.intersectObject(model, true).filter(h => h.object.isMesh && h.object.userData.part && shown(h.object) &&
    !(xray && (h.object.userData.part === 'foundation' || h.object.userData.part === 'grout')));
  return hits.length ? hits[0].object.userData.part : null;
}
let downAt = null;
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  if (mode === 'map') { const id = map?.pickAt(e); if (id) onOpenCb(id); return; }
  const part = pick(e);
  if (part) { select(part); return; }
  const other = mode === 'product' ? map?.pickAt(e) : null;                  // stasiun lain di dunia → pindah perangkat
  if (other && other !== product?.id) { onOpenCb(other); return; }
  if (selected) { selected = null; refreshHighlight(); renderInfo(); }
});
let hoverEv = null, lastMapHover = 0;                // raycast hover dikerjakan maksimal sekali per frame
renderer.domElement.addEventListener('pointermove', e => { if (!e.buttons) hoverEv = e; });

// ---------- Kamera ----------
let tween = null;
// Zoom roda mouse yang halus: tiap klik roda ± 28 % jarak (bertumpuk bila roda diputar cepat), kamera meluncur ke sana ± 0,15 s
// (interpolasi logaritmik → kecepatan terasa sama dekat maupun jauh) dan titik di bawah kursor tetap di tempat.
// Pinch-zoom layar sentuh tetap ditangani OrbitControls.
const zoom = { goal: null, anchor: new THREE.Vector3(), hasAnchor: false, last: 0 };
const zRay = new THREE.Raycaster(), zPlane = new THREE.Plane(), zNdc = new THREE.Vector2(), zDir = new THREE.Vector3(), zOff = new THREE.Vector3();
app.addEventListener('wheel', e => {                // fase capture di induk: mendahului zoom bawaan OrbitControls
  if (e.target !== renderer.domElement) return;
  e.preventDefault(); e.stopPropagation();
  if (tween) return;
  const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
  const d = zoom.goal ?? camera.position.distanceTo(controls.target);
  zoom.goal = THREE.MathUtils.clamp(d * Math.exp(THREE.MathUtils.clamp(dy, -300, 300) * 0.0025), controls.minDistance, controls.maxDistance);
  const r = renderer.domElement.getBoundingClientRect();
  zNdc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
  zRay.setFromCamera(zNdc, camera);
  zPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(zDir), controls.target);
  zoom.hasAnchor = !!zRay.ray.intersectPlane(zPlane, zoom.anchor);
}, { capture: true, passive: false });
renderer.domElement.addEventListener('pointerdown', () => { zoom.hasAnchor = false; });   // mulai putar/geser: zoom lanjut ke tengah
function stepZoom(now) {
  const dt = Math.min(0.05, (now - zoom.last) / 1000); zoom.last = now;
  if (zoom.goal === null) return false;
  zOff.subVectors(camera.position, controls.target);
  const d = zOff.length();
  let nd = Math.exp(THREE.MathUtils.lerp(Math.log(d), Math.log(zoom.goal), 1 - Math.exp(-dt * 20)));
  if (Math.abs(Math.log(nd / zoom.goal)) < 0.002) { nd = zoom.goal; zoom.goal = null; }
  const s = nd / d;
  if (zoom.hasAnchor) controls.target.sub(zoom.anchor).multiplyScalar(s).add(zoom.anchor);
  camera.position.copy(controls.target).addScaledVector(zOff, s);
  return true;
}

// Terbang ke pose dunia, lurus (pandangan panel Iso / Base / Box). done dipanggil saat tiba. Kamera selalu menatap titik pandang.
// Pandangan panel (Iso, Lihat sensor, …) menggantikan gerak yang sedang berjalan: penutup gerak lama (mis. batas orbit
// perangkat saat tiba dari peta) dijalankan dulu, agar kamera tidak tertahan batas orbit peta
function endTween() { const d = tween?.done; if (tween) tween.done = null; d?.(); }
function flyWorld(pos, target, dur = 900, done) {
  endTween(); zoom.goal = null;
  tween = { kind: 'line', p0: camera.position.clone(), t0: controls.target.clone(), p1: pos.clone(), t1: target.clone(), start: performance.now(), dur, done };
}
// Gerak otomatis peta ↔ perangkat: pan + zoom halus (van Wijk & Nuij, "Smooth and efficient zooming and panning" —
// sama dengan d3.interpolateZoom): titik pandang bergeser lurus & jarak kamera berubah sehingga laju di layar terasa rata;
// bila geseran jauh, kamera sedikit mundur di tengah lalu maju lagi. Tanpa mengorbit: arah pandang hanya berbelok pelan
// (slerp, awal & akhir lembut) bila arah tujuan berbeda. Waktu memakai easeInOutSine; durasi mengikuti panjang jalur.
const FOVH = 2 * Math.tan(THREE.MathUtils.degToRad(20));             // lebar pandang per meter jarak (FOV 40°)
function flyPanZoom(t1, dist1, dir1, done, dur) {
  zoom.goal = null;
  const t0 = controls.target.clone(), v0 = t0.clone().sub(camera.position), d0 = Math.max(0.05, v0.length()), dir0 = v0.normalize();
  const D1 = (dir1 ?? dir0).clone().normalize(), rho = 1.3, r2 = rho * rho, r4 = r2 * r2;
  const w0 = d0 * FOVH, w1 = dist1 * FOVH, U = t0.distanceTo(t1);
  let S, path;
  if (U < 1e-3) {
    const k = w1 < w0 ? -1 : 1; S = Math.abs(Math.log(w1 / w0)) / rho;
    path = x => [0, w0 * Math.exp(k * rho * x)];
  } else {
    const b0 = (w1 * w1 - w0 * w0 + r4 * U * U) / (2 * w0 * r2 * U), b1 = (w1 * w1 - w0 * w0 - r4 * U * U) / (2 * w1 * r2 * U);
    const q0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), q1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1), ch = Math.cosh(q0), sh = Math.sinh(q0);
    S = (q1 - q0) / rho;
    path = x => [(w0 / r2) * (ch * Math.tanh(rho * x + q0) - sh), w0 * ch / Math.cosh(rho * x + q0)];
  }
  // Belok arah dibobot jarak kamera: lebih banyak berbelok saat jauh (tampak halus di layar), sedikit saat dekat
  const turn = new THREE.Quaternion().setFromUnitVectors(dir0, D1), NL = 64, lut = [0];
  for (let i = 1, wp = path(0)[1]; i <= NL; i++) { const w = path(i / NL * S)[1]; lut.push(lut[i - 1] + (w + wp) / 2); wp = w; }
  for (let i = 0; i <= NL; i++) lut[i] /= lut[NL] || 1;
  tween = { kind: 'pz', t0, t1: t1.clone(), U, S, path, dir0, turn, lut, p1: t1.clone().addScaledVector(D1, -dist1), start: performance.now(),
            dur: dur ?? THREE.MathUtils.clamp(Math.max(S * 1000, THREE.MathUtils.radToDeg(dir0.angleTo(D1)) * 35), 2000, 3600), done };   // makin jauh / makin belok → makin lama
}
const panZoomTo = (P, done, dur) => { const v = P.t.clone().sub(P.p); flyPanZoom(P.t, v.length(), v, done, dur); };
const easeIO = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2), easeSine = k => -(Math.cos(Math.PI * k) - 1) / 2;
const _tv = new THREE.Vector3(), _dv = new THREE.Vector3(), _q = new THREE.Quaternion(), _q0 = new THREE.Quaternion();
function stepTween(now) {
  const T = tween, u = Math.min(1, (now - T.start) / T.dur);
  if (T.kind === 'pz') {
    const e = easeSine(u), [du, w] = T.path(e * T.S), k = T.U > 1e-3 ? du / T.U : 0;
    _tv.lerpVectors(T.t0, T.t1, k);
    const li = e * 64, i0 = Math.min(63, Math.floor(li)), kd = T.lut[i0] + (T.lut[i0 + 1] - T.lut[i0]) * (li - i0);   // belok arah
    _dv.copy(T.dir0).applyQuaternion(_q.slerpQuaternions(_q0, T.turn, kd));
    controls.target.copy(_tv); camera.position.copy(_tv).addScaledVector(_dv, -w / FOVH);
  } else {
    const k = easeIO(u);
    camera.position.lerpVectors(T.p0, T.p1, k); controls.target.lerpVectors(T.t0, T.t1, k);
  }
  if (u >= 1) { camera.position.copy(T.p1); controls.target.copy(T.t1); }
  camera.lookAt(controls.target);
  if (u >= 1) { tween = null; T.done?.(); }
}
// flyTo untuk panel & pandangan: koordinat lokal stasiun aktif
const toWorld = v => (model ? v.clone().applyMatrix4(model.matrixWorld) : v.clone());
function flyTo(pos, target, dur = 900) { flyWorld(toWorld(new THREE.Vector3(...pos)), toWorld(new THREE.Vector3(...target)), dur); }
function viewPose(name) {
  const H = params.height, k = Math.max(1, derive(params).fw / 800);
  const V = {
    iso:   [[H * 1.3, H * 0.85, H * 1.6], [0, H * 0.45, 0]],
    base:  [[0.95 * k, 0.72 * k, 1.2 * k], [0, 0.2, 0]],
    box:   [[-0.85, params.encY + 0.3, 1.75], [0.05, params.encY, 0.2]],
    solar: (() => {
      const yT = derive(params).yTop, th = THREE.MathUtils.degToRad(params.pvAz - 180);
      const fx = -Math.sin(th), fz = -Math.cos(th);
      return [[fx * 2.6 + fz * 0.9, yT + 1.3, fz * 2.6 - fx * 0.9], [0, yT - 0.4, 0]];
    })(),
    lock: (() => {                                            // kotak gembok di sisi kiri, garis bagi krangkeng
      const zc = params.od / 2000 + 0.005 + CAGE.split / 1000 - 0.04, xc = (CAGE.offsetX - CAGE.W / 2) / 1000 - 0.035;
      return [[xc - 0.5, params.encY + 0.15, zc + 0.3], [xc, params.encY, zc]];
    })(),
    inside: (() => {                                          // lihat isi box dari depan (pintu dibuka otomatis)
      const zc = params.od / 2000 + 0.005 + CAGE.tube / 1000 + 0.1;
      return [[-0.12, params.encY + 0.08, zc + 0.95], [0.02, params.encY, zc]];
    })(),
    front: [[0, H * 0.5, H * 1.9], [0, H * 0.5, 0]],
    top:   [[0.001, 1.9 * k, 0.001], [0, 0.2, 0]],
    ...product?.views,                                        // sudut pandang khusus seri
  }[name];
  return V;
}
function view(name, dur) { flyTo(...viewPose(name), dur); }
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.view === 'inside' && (DOORS.outer.target ?? DOORS.outer.angle) < 60) $('doorToggle').click();
  view(b.dataset.view);
}));
function setLimits(which) {
  const L = LIMITS[which];
  Object.assign(controls, { minDistance: L.minDistance, maxDistance: L.maxDistance, dampingFactor: L.dampingFactor });
  controls.maxPolarAngle = which === 'product' && xray ? Math.PI * 0.6 : L.maxPolarAngle;
  pipeline.setShadowMax(L.shadow);
}

// ---------- Kontrol UI ----------
const $ = id => document.getElementById(id);
$('xray').addEventListener('change', e => { xray = e.target.checked; applyXray(); });
$('labels').addEventListener('change', e => { labelsOn = e.target.checked; });
$('dims').addEventListener('change', e => { dimsOn = e.target.checked; applyDims(); });
$('explode').addEventListener('input', e => { explodeT = +e.target.value; applyExplode(); });

// Pintu krangkeng & pintu box (keduanya engsel kanan). Pintu box dibatasi tabrakan dengan sisi kanan
// dan pintu krangkeng (lidLimit); pintu krangkeng yang menutup akan mendorong pintu box.
let lidMax = 0, lidMaxFor = null;
let lockWanted = $('locked').checked;                // gembok terpasang → pintu krangkeng tertahan di 0°
function unlock() { lockWanted = false; $('locked').checked = false; }
const DOORS = {
  cage:  { slider: 'cageDoor', out: 'cageDoorOut', btn: 'cageToggle', open: 130, name: 'krangkeng', angle: +$('cageDoor').value, target: null },
  outer: { slider: 'door', out: 'doorOut', btn: 'doorToggle', open: LID_MAX, name: 'pintu box', angle: +$('door').value, target: null },
};
function setDoorUI() {
  for (const D of Object.values(DOORS)) {
    $(D.slider).value = Math.round(D.angle);
    $(D.out).textContent = D === DOORS.outer ? `${Math.round(D.angle)}° · maks ${Math.round(lidMax)}°`
      : `${Math.round(D.angle)}°${lockWanted && D.angle < 0.5 ? ' · terkunci' : ''}`;
    $(D.btn).textContent = `${(D.target ?? D.angle) > 1 ? 'Tutup' : 'Buka'} ${D.name}`;
  }
}
for (const [k, D] of Object.entries(DOORS)) {
  $(D.slider).addEventListener('input', e => {
    D.angle = +e.target.value; D.target = null;
    if (k === 'cage' && lockWanted) D.angle = 0;          // tertahan gembok
    setDoorUI();
  });
  $(D.btn).addEventListener('click', () => {
    const opening = (D.target ?? D.angle) <= 1;
    D.target = opening ? D.open : 0;
    if (opening) unlock();                                   // buka = lepas gembok dulu
    if (k === 'outer' && opening) DOORS.cage.target = Math.max(DOORS.cage.open, DOORS.cage.angle);
    if (k === 'cage' && !opening) DOORS.outer.target = 0;
    setDoorUI();
  });
}
$('locked').addEventListener('change', e => {
  lockWanted = e.target.checked;
  if (lockWanted && DOORS.cage.angle > 0.5) { DOORS.cage.target = 0; DOORS.outer.target = 0; }   // tutup dulu, lalu dikunci
  setDoorUI();
});
renderer.domElement.addEventListener('dblclick', e => {
  if (mode !== 'product') return;
  const part = pick(e);
  if (part === 'door') $('doorToggle').click();
  else if (['cageDoor', 'padlock', 'hasp', 'lockLid'].includes(part)) $('cageToggle').click();
});
setDoorUI();
$('infoClose').addEventListener('click', () => { selected = null; refreshHighlight(); renderInfo(); });

// Pintu model aktif mengikuti sudut pintu (dipanggil tiap frame & saat model ditinggalkan)
function applyDoors() {
  const U = model.userData, rad = THREE.MathUtils.degToRad;
  // Saat explode: pintu krangkeng dibuka dulu, pintu box ditutup agar enclosure bisa dikeluarkan
  const cageVis = Math.max(DOORS.cage.angle, 130 * explodePh.door), outerVis = DOORS.outer.angle * (1 - explodePh.door);
  live.cageVis = cageVis; live.outerVis = outerVis;
  U.doorPivot.rotation.y = rad(outerVis);
  U.cageDoorPivot.rotation.y = rad(cageVis);
  U.padlock.visible = lockWanted && cageVis < 0.5;             // gembok hanya terpasang saat pintu tertutup
  const lidOff = Math.min(1, cageVis / 12);                     // penutup atas terangkat lalu dilepas saat pintu dibuka
  U.lockLid.position.set(-0.05 * lidOff, 0.1 * lidOff, 0);
  U.lockLid.visible = lidOff < 1;
  const lever = -rad(Math.min(outerVis * 5, 60));               // tuas latch tidak menyentuh sisi kiri krangkeng
  for (const l of U.latchLevers) l.rotation.y = lever;
}

// Pusat pandang di tengah ruang kosong antara panel kiri (daftar stasiun di peta / panel perangkat) dan panel kanan
// (lingkungan + simulasi) yang sedang terbuka, agar model / peta tidak tertutup panel di layar lebar. Panel terlipat = tidak dihitung.
const openW = el => (el && el.getClientRects().length && !el.classList.contains('folded') ? el.offsetWidth + 16 : 0);   // tampil & tidak dilipat
function fitViewport() {
  camera.aspect = innerWidth / innerHeight;
  const left = Math.max(openW(document.getElementById('panel')), openW(document.querySelector('.ov-rail'))), right = openW(document.getElementById('envHud'));   // yang tersembunyi = 0
  if (innerWidth > 720) camera.setViewOffset(innerWidth, innerHeight, (right - left) / 2, 0, innerWidth, innerHeight);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  pipeline.setSize(innerWidth, innerHeight); labelRenderer.setSize(innerWidth, innerHeight);
}
// Panel perangkat (kiri) & daftar stasiun peta bisa dilipat ke judulnya saja → pandangan lebih luas (disimpan di browser)
for (const [btn, host, key] of [['panelFold', '#panel', 'panelFolded'], ['railFold', '.ov-rail', 'railFolded']]) {
  const b = $(btn), el = document.querySelector(host);
  const set = on => { el.classList.toggle('folded', on); b.setAttribute('aria-expanded', !on); try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* */ } fitViewport(); invalidate(); };
  let saved = null; try { saved = localStorage.getItem(key); } catch { /* */ }
  el.classList.toggle('folded', saved === '1'); b.setAttribute('aria-expanded', saved !== '1');
  b.addEventListener('click', e => { e.preventDefault(); set(!el.classList.contains('folded')); });
  el.querySelector('header, .ov-brand').addEventListener('click', e => { if (el.classList.contains('folded') && !e.target.closest('a, button')) set(false); });
}
pipeline.init();                                                  // kualitas optimal + pencahayaan sinematik referensi (tetap)
addEventListener('resize', () => { fitViewport(); invalidate(); });
fitViewport();

// ---------- Loop ----------
const tmp = new THREE.Vector3();
function updateLabels() {
  for (const o of tagObjs) {
    o.getWorldPosition(tmp);
    o.visible = mode === 'product' && labelsOn && (!o.userData.maxDist || camera.position.distanceTo(tmp) < o.userData.maxDist) && (!o.userData.xrayOnly || xray)
      && (!o.userData.when || o.userData.when());
  }
  for (const o of dimLabels) {
    o.getWorldPosition(tmp);
    o.visible = mode === 'product' && dimsOn && (!o.userData.maxDist || camera.position.distanceTo(tmp) < o.userData.maxDist);
  }
}
let lastT = null;
function frame(now) {
  if (!world) return;
  const dt = lastT === null ? 0 : THREE.MathUtils.clamp((now - lastT) / 1000, 0, 0.05); lastT = Math.max(lastT ?? now, now);
  if (tween) stepTween(now);
  stepZoom(now);
  let moving = false;
  if (mode === 'product' && model) {
    for (const D of Object.values(DOORS)) {
      if (D.target === null) continue;
      D.angle += (D.target - D.angle) * 0.12; moving = true;
      if (Math.abs(D.target - D.angle) < 0.3) { D.angle = D.target; D.target = null; }
    }
    const cageKey = Math.round(DOORS.cage.angle * 2) / 2;
    if (lidMaxFor !== cageKey || lidMaxFor === null) { lidMax = lidLimit(model.userData.collide, cageKey); lidMaxFor = cageKey; moving = true; }
    if (DOORS.outer.angle > lidMax) {                                // tertahan / terdorong
      DOORS.outer.angle = lidMax; moving = true;
      if (DOORS.outer.target !== null && DOORS.outer.target > lidMax && DOORS.cage.target === null) DOORS.outer.target = null;
    }
    if (moving) setDoorUI();
    applyDoors();
  }
  if (!tween) controls.update();
  const p = camera.position, yG = world.heightAt(p.x, p.z) + (mode === 'map' ? 1 : 0.4);   // kamera tidak masuk ke dalam tanah
  if (p.y < yG) p.y = yG;
  camera.near = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) * 0.005, 0.02, 2); camera.updateProjectionMatrix();
  // Lingkungan (env.js): jam hari → cahaya & langit; hujan → sungai, banjir, saluran sawah, V-Notch, tanah basah
  const env = stepEnv(dt);
  pipeline.setEnv(env.hour, env.cloud);
  world.setEnv(env, pipeline.state, dt);
  rain.update(dt, camera, controls.target, env.rainVis, pipeline.state.light);
  applyWet(env.wet);
  envPanel?.update();
  world.update(dt);                                               // arus sungai mengalir
  if (hoverEv) {
    const e = hoverEv; hoverEv = null;
    if (mode === 'product') {
      const part = pick(e); if (part !== hovered) { hovered = part; refreshHighlight(); }
      if (!part) { const o = map.pickAt(e); renderer.domElement.style.cursor = o && o !== product?.id ? 'pointer' : ''; }   // stasiun lain bisa diklik
    }
    else if (mode === 'map' && now - lastMapHover > 90) { lastMapHover = now; map.hover(map.pickAt(e)); }
  }
  // animasi simulasi seri (lampu, longsor, …) untuk semua stasiun di dunia; true = benda bergerak → bayangan ulang
  for (const E of Object.values(entries)) {
    if (!E.model) continue;
    const upd = E.prod.update?.(now, { camera, controls, env, sky: pipeline.state, model: E.model });
    if (upd === true || upd === 'shadow') moving = true;
    if (E.prod.mapStatus) map?.setStatus(E.prod.id, E.prod.mapStatus());      // warna titik stasiun di peta
  }
  if (moving) pipeline.invalidateShadow();
  updateLabels();
  pipeline.render();
  labelRenderer.render(scene, camera);
  map?.update(now, innerWidth, innerHeight);
}
renderer.setAnimationLoop(frame);
if (import.meta.env.DEV) Object.assign(window.__twin, { step: frame, dbg: () => ({ mode, tween: tween && { kind: tween.kind, done: !!tween.done }, min: controls.minDistance }) });   // langkah manual & status (hanya npm run dev)

// ---------- Mode (dipanggil dari app.js) ----------
// Tinggalkan stasiun aktif: explode & pintu dikembalikan, label disembunyikan; stasiun di luar peta dilepas dari dunia.
function leaveProduct() {
  if (!entry) return;
  explodeT = 0; $('explode').value = 0; applyExplode();
  for (const D of Object.values(DOORS)) { D.angle = 0; D.target = null; }
  explodePh = { door: 0 }; if (model) applyDoors(); setDoorUI();
  selected = hovered = null; refreshHighlight(); renderInfo();
  hideLabelsOf(model); tagObjs = []; dimLabels = [];
  if (!MAP_IDS.includes(entry.prod.id)) { scene.remove(entry.model); disposeModel(entry.model); delete entries[entry.prod.id]; wetMats = null; }
  entry = null; product = null; model = null;
}
// Peta selalu dibuka / dikembalikan ke pandangan default (Ikhtisar), termasuk saat keluar dari tampilan logger
export function showMap() {
  if (mode === 'map') return;
  if (mode === 'transit') {                                           // batal pindah perangkat: teruskan terbang ke Ikhtisar saja
    transitTo = null; if (tween) tween.done = null;
    mode = 'map'; document.body.classList.add('map-mode'); setLimits('map'); map.setShown(true); envPanel?.setDevice(null); fitViewport();
    return;
  }
  const fromProduct = mode === 'product';
  leaveProduct();
  mode = 'map'; document.body.classList.add('map-mode');
  setLimits('map'); map.setShown(true); envPanel?.setDevice(null); fitViewport();
  const P = map.viewPose('ikhtisar');
  if (fromProduct) panZoomTo(P); else { camera.position.copy(P.p); controls.target.copy(P.t); }
}
export function mapFlyTo(name) {                                   // tombol pandangan peta: pan + zoom (lihat flyPanZoom)
  panZoomTo(map.viewPose(name));
}
export function mapHover(id) { map?.hover(id); }
// Pindah perangkat saat sedang di tampilan logger: kembali dulu ke Ikhtisar, baru terbang masuk ke perangkat baru
// (mode 'transit' di antaranya: label & penanda peta disembunyikan; tujuan boleh diganti selama terbang)
let transitTo = null;
const STATION_VIEW = { 'ews-longsor': 'ews', 'awlr-sungai': 'awlr', vnotch: 'vnotch', 'ews-banjir': 'hulu', arr: 'arr' };   // pandangan tiba per stasiun (mapView)
function transitUI(prod) {
  envPanel?.setDevice(`${prod.code}${prod.variant ? ' ' + prod.variant : ''}`);
  $('prodCode').textContent = prod.code;
  $('prodName').textContent = [prod.name || 'Nama lengkap belum diisi', prod.variant].filter(Boolean).join(' · ');
  $('prodPanel').innerHTML = `<p class="note" style="margin:0">Kembali ke ikhtisar, lalu menuju ${prod.code}${prod.variant ? ' ' + prod.variant : ''}…</p>`;
}
export function showProduct(prod) {
  if (mode === 'product' && product?.id === prod.id) return;
  if (mode === 'transit') { transitTo = prod; transitUI(prod); return; }
  if (mode === 'product') {
    leaveProduct(); mode = 'transit'; transitTo = prod; transitUI(prod); setLimits('map');
    panZoomTo(map.viewPose('ikhtisar'), () => { const next = transitTo; transitTo = null; if (next) enterProduct(next); });
    return;
  }
  enterProduct(prod);
}
function enterProduct(prod) {
  leaveProduct();
  mode = 'product'; document.body.classList.remove('map-mode'); map.setShown(false);
  product = prod; entry = entries[prod.id] ??= newEntry(prod); params = entry.params;
  $('prodCode').textContent = prod.code;
  $('prodName').textContent = [prod.name || 'Nama lengkap belum diisi', prod.variant].filter(Boolean).join(' · ');
  envPanel?.setDevice(`${prod.code}${prod.variant ? ' ' + prod.variant : ''}`);             // simulasi perangkat di panel kanan
  const el = $('prodPanel');
  el.innerHTML = '';
  if (prod.panel) prod.panel(el, { params, rebuild, invalidate, flyTo });
  else el.innerHTML = `<p class="note" style="margin:0">${prod.info ?? `Sensor &amp; simulasi ${prod.code} belum dibuat. Saat ini tampil stasiun dasar.`}</p>`;
  buildSteps();
  if (!entry.model || encRange()) rebuild(); else { model = entry.model; adoptModel(); }
  fitViewport();
  // Dari peta ke stasiun: mendarat di pandangan stasiun pilihan user (tombol peta Tebing EWS / Sungai AWLR / Sawah V-Notch);
  // stasiun tanpa pandangan peta → titik pandang Iso dengan arah pandang sekarang
  const vName = STATION_VIEW[prod.id];
  if (vName) panZoomTo(map.viewPose(vName), () => setLimits('product'));
  else {
    const [pos, tgt] = viewPose('iso'), tW = toWorld(new THREE.Vector3(...tgt));
    flyPanZoom(tW, Math.max(toWorld(new THREE.Vector3(...pos)).distanceTo(tW) * 1.3, params.height * 2), null, () => setLimits('product'));
  }
  if (camera.position.distanceTo(controls.target) < 45) setLimits('product');
}
// Bangun dunia + model lengkap stasiun peta, lalu mulai di mode peta
export function init({ products, mapIds, onOpen, onHover }) {
  MAP_IDS = mapIds; onOpenCb = onOpen;
  world = buildWorld(); scene.add(world.group);
  const mapProds = products.filter(p => mapIds.includes(p.id));
  for (const p of mapProds) { const E = entries[p.id] = newEntry(p); E.model = makeModel(E); hideLabelsOf(E.model); }
  map = createMap({ scene, camera, renderer, labelHost: document.getElementById('ovLabels'), products: mapProds, onOpen, onHover });
  envPanel = mountEnvPanel(document.getElementById('envHud'), { onFold: () => { fitViewport(); invalidate(); } });
  fitViewport();
  mode = 'init'; showMap();
}
