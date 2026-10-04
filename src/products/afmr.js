import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { MAT } from '../materials.js';
import { mesh, rodBetween } from '../geometry.js';
import { dimension, tag } from '../labels.js';
import { sp21Cable, POLE_GAP } from '../model/sp21.js';
import { ENV, STATUS, levelStatus } from '../env.js';
import { AFMR, AWLR_POS, MDPL0, RIVER, SITES, dhAt, worldHeight } from '../world.js';
import { ARM, SLEEVE, awlrRiver, armLevels } from './awlrRiver.js';
import { buildMonopole } from '../model/monopole.js';
import { derive } from '../config.js';
import stlUrl from '../model/hrf600s.stl?url';

// AFMR Sungai (satuan m). Permintaan user: stasiun pengukur ARUS (bukan hanya tinggi muka air) di hulu (titik pilihan user)
// = monopole + lengan AWLR Sungai (tiang 3" × 4 m, sling, sleeve — awlrRiver.js) dengan lengan diperpanjang 2 m agar sensor
// lebih ke tengah alur, ujung pipa ditutup, plat dudukan lama ditiadakan + radar flow meter Holykell HRF600S (plastic joint).
// Bentuk sensor = STL dari user (hrf600s.py, manual HRF600S V25 sec. 3.1.1): 160 × 100 × 89,9 mm, muka atas dengan 4 lubang
// M5 85 × 85 + waterpass, antena kecepatan 24 GHz di muka miring, lensa level 80 GHz di bawah, plastic joint di ujung belakang.
// Bracket sesuai foto user (Clamp – Crossbar – Support – Host): 3 klem cincin mengikat sadel ke pipa bawah lengan dekat ujung,
// support 2 engsel (baut atas sejajar pipa, baut pivot bawah tegak lurus pipa) turun ke plat dasar yang dibaut 4-M5 ke muka
// atas sensor. Sensor diputar 90° terhadap foto (permintaan user): sumbu panjang searah arus, muka miring (antena kecepatan)
// menghadap ke hulu (asumsi), plastic joint ke hilir — pola baut 85 × 85 persegi, jadi plat dasar tetap seperti foto.
// Debit dihitung seperti flow meter radar: Q = luas penampang basah (dari penampang sungai di bawah sensor) × kecepatan rata-rata
// (= k × kecepatan permukaan yang dibaca antena 24 GHz). Kabel lewat conduit seperti AWLR Sungai → SP21 kedua di box.
// CCTV (permintaan user): kamera bullet (foto Hikvision) di tiang di bawah panel surya, menghadap lengan & sensor. Punggung tiang
// mendapat stasiun kedua untuk CCTV — enclosure + krangkeng + panel surya sendiri (sama dengan stasiun dasar, diputar 180°):
// kedua krangkeng saling membelakangi & setengah klem masing-masing dibaut jadi satu, kedua bracket panel surya dijepit
// baut tembus (butterfly). Kabel CCTV dalam conduit turun di sisi belakang-kiri tiang → SP21 enclosure CCTV.
// Ukuran bracket (diskalakan dari foto), dudukan & ukuran CCTV, jalur kabel & parameter hidrolis = perkiraan.
export const HRF = {
  L: 0.16, W: 0.1, H: 0.0899,                          // badan + lensa (total 89,9)
  hole: 0.085, holeOff: 0.03,                          // pola 4-M5 85 × 85, pusatnya 30 mm dari tengah badan ke arah joint
  joint: [0.093, 0.022, -0.034],                       // ujung plastic joint dari tengah muka atas (panjang, lebar, tinggi)
};
// Lengan AWLR + 2 m (permintaan user): pipa atas 5000, bawah 5100, pipa tegak tetap berjarak 1000
const ARM_AF = { top: ARM.top + 2, bottom: ARM.bottom + 2, posts: [0.02, 1.0, 2.0, 3.0, 4.0, 4.98] };
// Bracket (perkiraan dari foto, skala lewat tinggi badan sensor 83,2 mm): pusat 50 mm dari ujung pipa bawah, sadel 97 mm,
// klem lebar 12 mm jarak 30 mm, bawah sadel → muka atas sensor 95 mm
const BR = { fromEnd: 0.05, sadL: 0.097, sadT: 0.004, band: 0.012, bandT: 0.0008, bands: [-0.03, 0, 0.03], drop: 0.095 };
const M5 = { af: 0.008, head: 0.0035, washR: 0.005, washT: 0.001 };
// Hidrolis (perkiraan): Manning n saluran alam, kemiringan muka air S, k = kecepatan rata-rata / kecepatan permukaan
const HYD = { n: 0.035, S: 0.001, k: 0.85 };
const SEC = { x0: -1.5, x1: 15, dx: 0.1 };              // penampang sepanjang garis lengan (x lokal dari tiang)

// Posisi bracket & sensor dari tinggi pasang box (lokal stasiun)
const xBracket = () => SLEEVE.R - 0.003 + ARM_AF.bottom - BR.fromEnd;
const sensorTop = encY => armLevels(encY).yb - ARM.pipeR - BR.sadT - BR.drop;

// STL (mm, asal = tengah muka atas, +X ke joint, +Z ke atas) → m; lokal stasiun: +X STL → +z (hilir), +Y → +x, +Z → +y
let hrfGeo = null;
const loadSensor = () => fetch(stlUrl).then(r => r.arrayBuffer()).then(buf => {
  const g = new STLLoader().parse(buf);
  g.scale(0.001, 0.001, 0.001); g.rotateX(-Math.PI / 2); g.rotateY(-Math.PI / 2);
  hrfGeo = toCreasedNormals(g, THREE.MathUtils.degToRad(30));          // fillet halus, tepi tetap tegas
});

// ---------- Penampang sungai di bawah sensor: profil medan dunia sepanjang garis lengan (z lokal 0), y dari tanah stasiun ----------
let secPts = null;
function section() {
  if (secPts) return secPts;
  const s = SITES.afmr, c = Math.cos(s.rot), sn = Math.sin(s.rot);
  secPts = [];
  for (let x = SEC.x0; x <= SEC.x1 + 1e-9; x += SEC.dx) secPts.push([x, worldHeight(s.x + x * c, s.z - x * sn) - s.y]);
  return secPts;
}
// Luas basah A, keliling basah, lebar muka air B, kedalaman maks → Manning: v = R^(2/3) S^(1/2) / n; Q = v · A
export function flow(dh) {
  const P = section(), wl = RIVER.water + dh;
  let A = 0, Pw = 0, B = 0, dMax = 0;
  for (let i = 1; i < P.length; i++) {
    const [xa, ya] = P[i - 1], [xb, yb] = P[i], da = wl - ya, db = wl - yb;
    if (da <= 0 && db <= 0) continue;
    const f = da < 0 || db < 0 ? Math.max(da, db) / Math.abs(da - db) : 1, w = (xb - xa) * f, h0 = Math.max(da, 0), h1 = Math.max(db, 0);
    A += w * (h0 + h1) / 2; B += w; Pw += Math.hypot(w, h0 - h1); dMax = Math.max(dMax, h0, h1);
  }
  const R = Pw ? A / Pw : 0, v = R ** (2 / 3) * Math.sqrt(HYD.S) / HYD.n;
  return { wl, A, B, dMax, v, vs: v / HYD.k, Q: v * A };
}

let ui = null, yBotNow = 0, secOn = true, cctvOn = false;   // cctvOn: sisi CCTV (box, krangkeng, panel, kamera) — bawaan tersembunyi
function extend(model, ctx = {}) {
  const d = model.userData.d, S = model.userData.station;
  awlrRiver.extend(model, { sensor: false, plate: false, caps: true, arm: ARM_AF, backstay: { x: -3.2 }, level, river: { xc: AFMR.dP, width: 2 * AFMR.hw, part: 'riverAfmr', label: 'Sungai' } });
  const U = model.userData.awlr, { xb1, yb, yA0, zc } = U.mount, R = ARM.pipeR;
  const at = (m, x, y, z) => { m.position.set(x, y, z); return m; };
  const root = model.getObjectByName('awlr'), newG = () => { const g = new THREE.Group(); root.add(g); return g; };
  const alu = new THREE.MeshStandardMaterial({ color: 0x9ea3a7, metalness: 0.6, roughness: 0.4 }), steel = MAT.galv();
  const hexGeo = (af, h) => new THREE.CylinderGeometry(af / 2 / Math.cos(Math.PI / 6), af / 2 / Math.cos(Math.PI / 6), h, 6);
  const xS = xb1 - BR.fromEnd, ySad = yb - R - BR.sadT, yT = ySad - BR.drop;   // pusat bracket, bawah sadel, muka atas sensor
  const brk = U.hrf = newG();                                                 // sadel + support + plat dasar + sensor (turun bersama)

  // ---------- Clamp: 3 klem cincin stainless melingkari pipa bawah + sadel, rumah sekrup di bawah sadel ----------
  const bands = U.hrfBands = newG();
  const bandSh = new THREE.Shape(), Ro = R + BR.bandT, vb = -(R + BR.sadT);
  bandSh.absarc(0, 0, Ro, 0, Math.PI, false); bandSh.lineTo(-Ro, vb - BR.bandT); bandSh.lineTo(Ro, vb - BR.bandT); bandSh.closePath();
  const hole = new THREE.Path(); hole.absarc(0, 0, R, 0, Math.PI, false); hole.lineTo(-R, vb); hole.lineTo(R, vb); hole.closePath(); bandSh.holes.push(hole);
  const bandGeo = new THREE.ExtrudeGeometry(bandSh, { depth: BR.band, bevelEnabled: false, curveSegments: 24 }).translate(0, 0, -BR.band / 2).rotateY(Math.PI / 2);
  for (const off of BR.bands) {
    const x = xS + off, yH = ySad - BR.bandT - 0.004;
    bands.add(
      at(mesh(bandGeo, steel, 'hrfClamp'), x, yb, 0),
      at(mesh(new THREE.BoxGeometry(0.014, 0.008, 0.016), steel, 'hrfClamp'), x, yH, 0.009),                  // rumah sekrup cacing
      at(mesh(hexGeo(0.007, 0.004).rotateX(Math.PI / 2), MAT.bolt(), 'hrfClamp'), x, yH, 0.019),             // kepala sekrup
    );
  }
  const clTag = tag('Clamp', 'hrfClamp'); clTag.position.set(xS, yb + R + 0.01, 0); bands.add(clTag);

  // ---------- Sadel (crossbar seat) di bawah pipa ----------
  brk.add(at(mesh(new THREE.BoxGeometry(BR.sadL, BR.sadT, 2 * R), alu, 'hrfSupport'), xS, ySad + BR.sadT / 2, 0));
  for (const sx of [-1, 1]) brk.add(at(mesh(new THREE.BoxGeometry(0.003, 0.008, 2 * R), alu, 'hrfSupport'), xS + sx * (BR.sadL / 2 - 0.0015), ySad - 0.004, 0));   // bibir ujung

  // ---------- Support: yoke atas (baut sejajar pipa) → badan → yoke bawah (baut pivot tegak lurus pipa) → rel ----------
  const yBoltU = ySad - 0.026, yPiv = yT + 0.036;
  for (const sx of [-1, 1]) brk.add(at(mesh(new THREE.BoxGeometry(0.004, 0.038, 0.03), alu, 'hrfSupport'), xS + sx * 0.018, ySad - 0.019, 0));
  brk.add(rodBetween([xS - 0.024, yBoltU, 0], [xS + 0.024, yBoltU, 0], 0.004, MAT.thread(0.05), 'hrfSupport', 12),
    at(mesh(hexGeo(0.013, 0.0055).rotateZ(Math.PI / 2), MAT.bolt(), 'hrfSupport'), xS - 0.0228, yBoltU, 0),
    at(mesh(hexGeo(0.013, 0.0065).rotateZ(Math.PI / 2), MAT.nut(), 'hrfSupport'), xS + 0.0233, yBoltU, 0));
  const yBody0 = yT + 0.022, yBody1 = ySad - 0.012;
  brk.add(at(mesh(new RoundedBoxGeometry(0.03, yBody1 - yBody0, 0.03, 3, 0.004), alu, 'hrfSupport'), xS, (yBody0 + yBody1) / 2, 0));
  for (const sz of [-1, 1]) brk.add(at(mesh(new THREE.BoxGeometry(0.034, 0.033, 0.004), alu, 'hrfSupport'), xS, yT + 0.0335, sz * 0.019));
  brk.add(rodBetween([xS, yPiv, -0.025], [xS, yPiv, 0.025], 0.004, MAT.thread(0.05), 'hrfSupport', 12),
    at(mesh(hexGeo(0.013, 0.0055).rotateX(Math.PI / 2), MAT.bolt(), 'hrfSupport'), xS, yPiv, 0.0238),
    at(mesh(hexGeo(0.013, 0.0065).rotateX(Math.PI / 2), MAT.nut(), 'hrfSupport'), xS, yPiv, -0.0243));
  brk.add(at(mesh(new THREE.BoxGeometry(0.07, 0.012, 0.044), alu, 'hrfSupport'), xS, yT + 0.011, 0));        // rel
  const spTag = tag('Support', 'hrfSupport'); spTag.position.set(xS + 0.02, yT + 0.06, 0.02); brk.add(spTag);

  // ---------- Plat dasar + 4 baut M5 (85 × 85) ke muka atas sensor ----------
  brk.add(at(mesh(new THREE.BoxGeometry(0.1, 0.005, 0.1), alu, 'hrfBase'), xS, yT + 0.0025, 0));
  const h = HRF.hole / 2, washGeo = new THREE.CylinderGeometry(M5.washR, M5.washR, M5.washT, 16), headGeo = hexGeo(M5.af, M5.head);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) brk.add(
    at(mesh(washGeo, steel, 'hrfBase'), xS + sx * h, yT + 0.005 + M5.washT / 2, sz * h),
    at(mesh(headGeo, MAT.bolt(), 'hrfBase'), xS + sx * h, yT + 0.005 + M5.washT + M5.head / 2, sz * h));

  // ---------- Sensor HRF600S (host): pola baut di bawah pusat bracket, sumbu panjang searah arus ----------
  const zs0 = -HRF.holeOff;                                                   // tengah muka atas sensor (joint ke +z / hilir)
  // Warna sesuai foto user: aluminium anodize abu-abu gelap (doff), waterpass hijau, plastic joint + tutup hitam
  brk.add(at(mesh(hrfGeo, new THREE.MeshStandardMaterial({ color: 0x505456, metalness: 0.55, roughness: 0.6 }), 'hrf600s'), xS, yT, zs0));
  const jBlack = new THREE.MeshStandardMaterial({ color: 0x141517, roughness: 0.55 }), xJ = xS + HRF.joint[1], yJ = yT + HRF.joint[2];
  brk.add(at(mesh(new THREE.CylinderGeometry(0.0108, 0.0108, 0.0052, 8).rotateX(Math.PI / 2), jBlack, 'hrf600s'), xJ, yJ, zs0 + 0.0825),   // mur joint (segi 8)
    at(mesh(new THREE.CylinderGeometry(0.0082, 0.0082, 0.0082, 24).rotateX(Math.PI / 2), jBlack, 'hrf600s'), xJ, yJ, zs0 + 0.0891));      // badan joint
  brk.add(at(mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.0012, 20), new THREE.MeshStandardMaterial({ color: 0x8be04a, emissive: 0x2a5a10, roughness: 0.2 }), 'hrf600s'),
    xS, yT - 0.0012, zs0 - 0.069));                                                                                                     // waterpass
  const snTag = tag('Radar flow meter HRF600S', 'hrf600s'); snTag.position.set(xS + HRF.W / 2, yT - 0.04, zs0); brk.add(snTag);
  const yBot = yT - HRF.H, xd = xS + 0.16;
  const lvDim = dimension([xd, yBot, 0], [xd, RIVER.water, 0], [0.03, 0, 0], `${(yBot - RIVER.water).toFixed(2)} m ke muka air`, 12);
  brk.add(lvDim); U.lvDim = { dim: lvDim, x: xd, yBot }; U.yBot = yBotNow = yBot;   // ikut muka air (awlrRiver.update)

  // ---------- Kabel sensor dalam conduit hitam → konektor SP21 kedua di box (jalur sama dengan AWLR Sungai) ----------
  // Ujung conduit di sisi pipa bawah, kabel turun di sisi hilir bracket lalu masuk plastic joint dari arah hilir
  const cable = U.hrfCable = newG(), xj = xS + HRF.joint[1], zj = zs0 + HRF.joint[0], yj = yT + HRF.joint[2];
  sp21Cable(S, {
    slot: -1, wireToY: -0.1085, group: cable, phi: 30, yH: d.encY - 0.45,
    route: [[POLE_GAP * Math.cos(Math.PI / 6), yA0 - 0.03, zc], [0.12, yA0 - 0.03, zc], [0.12, yb, zc], [xb1 - 0.12, yb, zc]],
    endCable: [[xb1 - 0.135, yb, zc], [xb1 - 0.15, yb - 0.06, 0.07], [xj - 0.03, yj + 0.01, zj + 0.06], [xj, yj, zj + 0.015], [xj, yj, zj - 0.002]],
    tagText: 'Kabel sensor + conduit', tagAt: [1.2, yb - 0.02, zc + 0.01], plugTag: 'SP21 sensor',
  });

  // ---------- Penampang sungai di 3D (bidang tegak di bawah lengan): garis dasar + luas basah yang ikut muka air ----------
  const P = section(), N = P.length;
  const sec = U.sec = new THREE.Group(); sec.name = 'penampang'; root.add(sec);
  const bed = new THREE.Line(new THREE.BufferGeometry().setFromPoints(P.map(([x, y]) => new THREE.Vector3(x, y + 0.01, 0))),
    new THREE.LineBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true }));
  bed.renderOrder = 999; sec.add(bed);
  const wg = new THREE.BufferGeometry(), idx = [];
  wg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 6), 3));
  for (let i = 0; i < N - 1; i++) { const a = 2 * i; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  wg.setIndex(idx);
  const water = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ color: 0x3cb4f2, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
  water.renderOrder = 998; water.frustumCulled = false; sec.add(water);
  const wTop = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: 0x3cb4f2, depthTest: false, transparent: true }));
  wTop.renderOrder = 999; wTop.frustumCulled = false; sec.add(wTop);
  const secTag = tag('Penampang sungai', 'riverAfmr'); secTag.position.set(AFMR.dP, RIVER.water - 0.5, 0); sec.add(secTag);
  U.setSection = wl => {                                                      // isi luas basah antara dasar & muka air
    const p = wg.attributes.position; let xa = null, xb = null;
    P.forEach(([x, y], i) => { p.setXYZ(2 * i, x, Math.min(y, wl), 0); p.setXYZ(2 * i + 1, x, wl, 0); if (y < wl) { xa ??= x; xb = x; } });
    p.needsUpdate = true; wg.computeBoundingSphere();
    const t = wTop.geometry.attributes.position; t.setXYZ(0, xa ?? 0, wl, 0); t.setXYZ(1, xb ?? 0, wl, 0); t.needsUpdate = true;
  };
  U.secDh = null;
  addCctvSide(model, ctx.params);
}

// ---------- Sisi CCTV: stasiun kedua di punggung tiang + kamera CCTV di bawah panel surya ----------
// Kamera bullet (perkiraan dari foto): dudukan bulat Ø90, leher, badan putih 160 × 70 × 70 mm, muka hitam + kaca + lensa
const CAM = { below: 0.62, plateH: 0.16, plateW: 0.09, plateT: 0.006, baseR: 0.045, baseT: 0.012, neck: 0.05, L: 0.16, S: 0.07 };
const KEEP = new Set(['enclosure', 'door', 'hinge', 'latch', 'mountPlate', 'encMount', 'sp21']);   // isi box logger tidak disalin
function addCctvSide(model, params) {
  const d = model.userData.d, S = model.userData.station, ro = S.ro, at = (m, x, y, z) => { m.position.set(x, y, z); return m; };
  const twin = buildMonopole(params, { pvBulge: awlrRiver.pvBulge(d) });
  const back = new THREE.Group(); back.name = 'sisiCctv'; back.rotation.y = Math.PI; model.add(back);
  const TG = twin.userData.groups, TC = twin.userData.clamp;
  for (const k of ['enclosure', 'encMount', 'cage', 'solar', 'pvCable']) back.add(TG[k]);
  back.add(TC.front);                                                  // setengah klem krangkeng CCTV menggantikan strap klem depan
  model.userData.clamp.strap.visible = false;
  // Box CCTV: isi box logger dibuang (isi box CCTV belum dimodelkan)
  const drop = [];
  twin.userData.station.enc.traverse(o => {
    const part = o.userData.part ?? o.element?.dataset?.part;
    if ((o.isMesh || o.isCSS2DObject) && part && !KEEP.has(part)) drop.push(o);
  });
  for (const o of drop) o.parent.remove(o);
  // Label pembeda kedua sisi
  const relabel = (root, from, to) => root.traverse(o => { const sp = o.isCSS2DObject && o.element.querySelector('span'); if (sp && sp.textContent === from) sp.textContent = to; });
  relabel(model.userData.groups.enclosure, 'Enclosure B&J 504020', 'Enclosure logger AFMR (B&J 504020)');
  relabel(back, 'Enclosure B&J 504020', 'Enclosure CCTV (B&J 504020)');
  relabel(back, 'Krangkeng pelindung', 'Krangkeng CCTV');
  relabel(back, 'Panel surya', 'Panel surya CCTV');
  relabel(back, 'Kabel panel + conduit', 'Kabel panel CCTV + conduit');

  // Panel surya butterfly: U-bolt kedua bracket diganti 4 baut tembus M10 yang menjepit kedua plat belakang bracket
  const MP = model.userData.pv, TP = twin.userData.pv;
  MP.ubolt.visible = TP.ubolt.visible = false;
  const thru = new THREE.Group(); thru.name = 'bautTembusPanel'; model.add(thru);
  const uR = ro + 0.005, bH = d.pvBrH / 1000, yTopW = -0.06, zN = ro + 0.003 + 0.014;
  for (const y of [d.yTop + yTopW - 0.045, d.yTop + yTopW - bH + 0.045]) for (const sx of [-1, 1])
    thru.add(rodBetween([sx * uR, y, -zN], [sx * uR, y, zN], 0.005, MAT.bolt(), 'solarBracket'));
  const thTag = tag('Baut tembus 2 bracket panel', 'solarBracket', { maxDist: 3 }); thTag.position.set(uR + 0.01, d.yTop + yTopW - 0.045, 0); thru.add(thTag);

  // ---------- Kamera CCTV di sisi +x tiang (searah lengan), menunduk ke sensor ----------
  const cam = new THREE.Group(); cam.name = 'cctv'; model.add(cam);
  const yC = d.yTop - CAM.below, xP = ro + CAM.plateT, white = MAT.whitePl(), black = new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.4 });
  // Dudukan tiang: plat tegak + 2 klem cincin stainless melingkari tiang & plat
  cam.add(at(mesh(new THREE.BoxGeometry(CAM.plateT, CAM.plateH, CAM.plateW), MAT.alu(), 'cctvMount'), ro + CAM.plateT / 2, yC, 0));
  const bt = 0.0008, Ro = ro + bt, bandSh = new THREE.Shape(), hole = new THREE.Path();
  bandSh.absarc(0, 0, Ro, Math.PI / 2, Math.PI * 1.5, false); bandSh.lineTo(xP + bt, -Ro); bandSh.lineTo(xP + bt, Ro); bandSh.closePath();
  hole.absarc(0, 0, ro, Math.PI / 2, Math.PI * 1.5, false); hole.lineTo(xP, -ro); hole.lineTo(xP, ro); hole.closePath(); bandSh.holes.push(hole);
  const bandGeo = new THREE.ExtrudeGeometry(bandSh, { depth: 0.012, bevelEnabled: false, curveSegments: 24 }).rotateX(Math.PI / 2).translate(0, 0.006, 0);
  for (const dy of [-0.05, 0.05]) cam.add(at(mesh(bandGeo, MAT.galv(), 'cctvMount'), 0, yC + dy, 0));
  // Dudukan bulat kamera di plat, pangkal melebar, leher mendatar, sendi bola (sesuai foto)
  const xB = xP + CAM.baseT / 2, xN0 = xB + CAM.baseT / 2;
  cam.add(at(mesh(new THREE.CylinderGeometry(CAM.baseR, CAM.baseR, CAM.baseT, 32).rotateZ(Math.PI / 2), white, 'cctv'), xB, yC, 0));
  cam.add(at(mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.016, 24).rotateZ(Math.PI / 2), white, 'cctv'), xN0 + 0.008, yC, 0));   // pangkal leher
  cam.add(at(mesh(new THREE.CylinderGeometry(0.017, 0.019, CAM.neck, 20).rotateZ(Math.PI / 2), white, 'cctv'), xN0 + 0.016 + CAM.neck / 2, yC, 0));
  const xK = xN0 + 0.016 + CAM.neck + 0.012;
  cam.add(at(mesh(new THREE.SphereGeometry(0.019, 20, 14), white, 'cctv'), xK, yC, 0));
  // Badan: sambungan di punggung (belakang) badan, segaris leher, menunduk ke arah sensor di ujung lengan
  const sx = xBracket(), sy = sensorTop(params.encY), tilt = Math.atan2(yC - sy, sx - xK);
  const body = new THREE.Group(); body.position.set(xK, yC, 0); body.rotation.z = -tilt; cam.add(body);
  const bs = CAM.S, wL = CAM.L - 0.04, x0 = 0.022;                           // x0 = punggung badan putih
  body.add(at(mesh(new THREE.CylinderGeometry(0.013, 0.013, x0 + 0.004, 16).rotateZ(Math.PI / 2), white, 'cctv'), (x0 + 0.004) / 2, 0, 0));   // tangkai sendi → punggung
  body.add(at(mesh(new RoundedBoxGeometry(wL, bs, bs, 4, 0.02), white, 'cctv'), x0 + wL / 2, 0, 0));
  const xF = x0 + wL;                                                         // muka depan badan putih
  body.add(at(mesh(new RoundedBoxGeometry(0.045, bs + 0.006, bs + 0.006, 3, 0.012), black, 'cctv'), xF + 0.0225 - 0.004, 0, 0));   // muka hitam
  body.add(at(mesh(new THREE.BoxGeometry(0.004, bs - 0.012, bs - 0.012), new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.08, metalness: 0.4 }), 'cctv'),
    xF + 0.041 + 0.0021, 0, 0));                                              // kaca depan
  body.add(at(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.004, 24).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2b3036, roughness: 0.15, metalness: 0.6 }), 'cctv'),
    xF + 0.0445, 0.008, 0));                                                  // lensa
  const cTag = tag('CCTV (bullet)', 'cctv'); cTag.position.set(xF, bs / 2, bs / 2); body.add(cTag);
  const mTag = tag('Dudukan CCTV + klem', 'cctvMount', { maxDist: 3 }); mTag.position.set(xP, yC - CAM.plateH / 2, CAM.plateW / 2); cam.add(mTag);

  // ---------- Kabel CCTV: SP21 slot −1 box CCTV → conduit turun di 225° (belakang-kiri, celah jari antipanjat) → kamera ----------
  // Koordinat sisi CCTV (diputar 180°): sudut a di stasiun → a − 180 di sini, (x, z) → (−x, −z)
  const B = awlrRiver.pvBulge(d), TS = twin.userData.station, rad = THREE.MathUtils.degToRad;
  const pol = (deg, y, r = 0.063) => [r * Math.cos(rad(deg)), y, r * Math.sin(rad(deg))];
  const yW = yC - 0.13, rW = 0.085, yBase = yC - CAM.baseR + 0.004;
  const cctvCable = new THREE.Group(); cctvCable.name = 'kabelCctv'; back.add(cctvCable);
  sp21Cable(TS, {
    slot: -1, wireToY: -0.1085, group: cctvCable, phi: 45, yH: TS.cy - 0.45, part: 'cctvCable',
    route: [pol(45, B.y0 - 0.05), pol(45, B.y0, B.R), pol(45, B.y1, B.R), pol(45, B.y1 + 0.05), pol(45, yW)],
    // melingkar di luar conduit panel (315° stasiun) ke sisi +x stasiun, berhenti di bawah dudukan kamera
    tail: [pol(45, yW), pol(70, yW + 0.01, rW), pol(100, yW + 0.015, rW), pol(135, yW + 0.02, rW), pol(165, yW + 0.025, rW), [-(xP + 0.016), yW + 0.03, 0]],
    endCable: [[-(xP + 0.016), yW + 0.04, 0], [-(xP + 0.016), yBase - 0.03, 0], [-(xB), yBase, 0]],
    tagText: 'Kabel CCTV + conduit', tagAt: pol(45, B.y1 + 0.3), plugTag: 'SP21 CCTV',
  });
  model.userData.twin = { G: TG, clamp: TC, pv: TP, encMount: twin.userData.encMount, cdp: twin.userData.cageDoorPivot, dp: twin.userData.doorPivot, cable: cctvCable };
}
// Sisi CCTV ikut explode & pintu stasiun utama (posisi lokal sama; bingkainya diputar 180° → bergerak ke belakang).
// Saat disembunyikan: stasiun kembali seperti AFMR biasa (strap klem & U-bolt panel tampil lagi). true = visibilitas berubah.
function syncTwin(model) {
  const T = model.userData.twin; if (!T) return false;
  const G = model.userData.groups, C = model.userData.clamp, P = model.userData.pv, on = cctvOn, changed = T.on !== on;
  T.on = on;
  model.getObjectByName('sisiCctv').visible = model.getObjectByName('cctv').visible = on;
  C.strap.visible = P.ubolt.visible = !on;
  for (const k of ['enclosure', 'encMount', 'cage', 'solar', 'pvCable']) T.G[k].position.copy(G[k].position);
  T.clamp.front.position.copy(C.front.position);
  for (const k of ['asm', 'nuts']) T.pv[k].position.copy(P[k].position);
  T.encMount.bolts.position.copy(model.userData.encMount.bolts.position);
  T.cable.position.copy(G.pvCable.position);
  T.cdp.rotation.y = model.userData.cageDoorPivot.rotation.y; T.dp.rotation.y = model.userData.doorPivot.rotation.y;
  model.getObjectByName('bautTembusPanel').visible = on && P.asm.position.lengthSq() < 1e-8;
  return changed;
}

const level = () => dhAt(ENV, AFMR.xc);
const ST_COLOR = { low: '#93c5fd', good: '#46d78f', warn: '#f4cf6a', alert: '#f7a766', crit: '#ff7a6b' };

function update(now, ctx) {
  awlrRiver.update(now, ctx);                                         // dimensi sensor → muka air, label sungai
  const U = ctx.model?.userData.awlr; let changed = false;
  const twinChanged = !!ctx.model && syncTwin(ctx.model);
  if (U?.sec) {
    const dh = level(), vis = secOn && !document.body.classList.contains('map-mode');   // penampang hanya di tampilan logger
    if (U.secDh === null || Math.abs(dh - U.secDh) > 0.002) { U.secDh = dh; U.setSection(RIVER.water + dh); changed = true; }
    if (U.sec.visible !== vis) { U.sec.visible = vis; changed = true; }
  }
  if (ui && now - ui.t > 200) { ui.t = now; ui.sync(); }
  return twinChanged ? 'shadow' : changed ? 'redraw' : false;
}

// ---------- Panel: status, penampang sungai (SVG), bacaan muka air, kecepatan & debit ----------
const TESTS = [['Surut', -0.4], ['Normal', 0], ['Siaga', 0.72], ['Banjir', 1.35]];
const ROWS = [['tma', 'Tinggi muka air'], ['dMax', 'Kedalaman maks'], ['B', 'Lebar muka air'], ['A', 'Luas penampang basah'],
  ['vs', 'Kecepatan permukaan (sensor)'], ['v', 'Kecepatan rata-rata'], ['Q', 'Debit'], ['read', 'Pembacaan level']];
function panel(el, { params, flyTo, invalidate }) {
  const td = 'style="text-align:right;font-weight:600"';
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span>Status muka air</span><output id="afSt" style="font-weight:700"></output></div>
    <svg id="afSvg" viewBox="0 0 320 150" style="width:100%;height:auto;display:block;background:rgba(255,255,255,.03);border-radius:8px"></svg>
    <div id="afCap" style="color:var(--muted);font-size:11px;margin:4px 0 10px"></div>
    <table id="afTab" style="width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;margin-bottom:12px">
      ${ROWS.map(([k, t]) => `<tr><td>${t}</td><td data-k="${k}" ${td}></td></tr>`).join('')}
    </table>
    <div style="color:var(--muted);margin-bottom:6px">Uji muka air (manual)</div>
    <div id="afTests" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:6px">${TESTS.map(([t, v]) => `<button type="button" data-v="${v}">${t}</button>`).join('')}</div>
    <div class="btn-row" style="margin-bottom:10px"><button type="button" id="afAuto">Otomatis dari hujan</button></div>
    <label class="switch" style="margin-bottom:10px">Penampang di 3D <input type="checkbox" id="afSec3d"></label>
    <label class="switch" style="margin-bottom:10px">Tampilkan CCTV (box, panel surya & kamera) <input type="checkbox" id="afCctv"></label>
    <div class="btn-row"><button type="button" id="afLook">Lihat sensor</button><button type="button" id="afLookSec">Lihat penampang</button></div>
    <div class="btn-row" style="margin-top:6px"><button type="button" id="afLookCam">Lihat CCTV</button><button type="button" id="afLookBack">Lihat box CCTV</button></div>
    <p class="note" style="margin:10px 0 0">Debit = luas penampang basah × kecepatan rata-rata (k ${HYD.k} × kecepatan permukaan). Kecepatan disimulasikan
      dengan rumus Manning (n ${HYD.n}, kemiringan ${HYD.S}) — perkiraan.</p>`;
  const $ = s => el.querySelector(s), tests = [...$('#afTests').children];
  const o = Object.fromEntries(['afSt', 'afSvg', 'afCap', 'afTab', 'afAuto', 'afSec3d'].map(k => [k, $('#' + k)]));
  for (const b of tests) b.addEventListener('click', () => { ENV.auto = false; ENV.manual = +b.dataset.v; ENV.storm = null; sync(); });
  o.afAuto.addEventListener('click', () => { ENV.auto = true; sync(); });
  o.afSec3d.checked = secOn;
  o.afSec3d.addEventListener('change', () => { secOn = o.afSec3d.checked; invalidate(); });
  const cctvBox = $('#afCctv'), showCctv = on => { cctvOn = cctvBox.checked = on; invalidate(); };
  cctvBox.checked = cctvOn;
  cctvBox.addEventListener('change', () => showCctv(cctvBox.checked));
  const yb = armLevels(params.encY).yb, xS = xBracket(), yT = sensorTop(params.encY);
  $('#afLook').addEventListener('click', () => flyTo([xS - 0.5, yb - 0.06, 0.3], [xS, yb - 0.17, -0.02], 1300));   // dari sisi darat-hilir
  $('#afLookCam').addEventListener('click', () => { showCctv(true); const y = derive(params).yTop - CAM.below; flyTo([0.95, y + 0.12, 0.75], [0.2, y - 0.03, 0], 1300); });
  $('#afLookBack').addEventListener('click', () => showCctv(true) || flyTo([-0.9, params.encY + 0.5, -2.4], [0, params.encY, -0.2], 1300));
  $('#afLookSec').addEventListener('click', () => flyTo([AFMR.dP - 0.5, 1.5, 12], [AFMR.dP - 0.5, -0.3, 0], 1300));   // dari hilir, memandang penampang

  // Penampang (SVG): x lokal SEC.x0..x1 → 10..310, y −1,9..2,4 m → 140..10 (skala tegak dibesarkan)
  const P = section(), Y0 = -1.9, Y1 = 2.4, kx = 300 / (SEC.x1 - SEC.x0), ky = 130 / (Y1 - Y0);
  const X = x => (10 + (x - SEC.x0) * kx).toFixed(1), Yp = y => (10 + (Y1 - y) * ky).toFixed(1);
  const bedPts = P.map(([x, y]) => `${X(x)},${Yp(y)}`).join(' ');
  o.afSvg.innerHTML = `
    <polygon points="${X(SEC.x0)},${Yp(Y0)} ${bedPts} ${X(SEC.x1)},${Yp(Y0)}" fill="#6b5a43" opacity=".85"/>
    <polygon id="afW" fill="#3cb4f2" opacity=".55"/><line id="afWl" stroke="#7fd3ff" stroke-width="1.2"/>
    <polyline points="${bedPts}" fill="none" stroke="#ffd166" stroke-width="1.2"/>
    <line x1="${X(0)}" y1="${Yp(0)}" x2="${X(0)}" y2="${Yp(Y1 + 1)}" stroke="#2f6fe0" stroke-width="3"/>
    <line x1="${X(0)}" y1="${Yp(yb)}" x2="${X(SLEEVE.R + ARM_AF.bottom)}" y2="${Yp(yb)}" stroke="#2f6fe0" stroke-width="2"/>
    <rect x="${(+X(xS) - 4).toFixed(1)}" y="${Yp(yT)}" width="8" height="${(HRF.H * ky).toFixed(1)}" fill="#c9ccce"/>
    <line id="afBeam" x1="${X(xS)}" y1="${Yp(yT - HRF.H)}" x2="${X(xS)}" stroke="#ffd166" stroke-dasharray="3 3"/>
    <text x="${X(0) - 4}" y="${Yp(Y1) + 9}" fill="#9aa8bd" font-size="9" text-anchor="end">tiang</text>
    <text x="${+X(xS) + 7}" y="${+Yp(yT) + 6}" fill="#dfe6ef" font-size="9">HRF600S</text>
    <text id="afWt" fill="#bfe8ff" font-size="9"></text>`;
  o.afCap.textContent = `Penampang sungai tepat di bawah lengan (dari tiang ke seberang, ${(SEC.x1 - SEC.x0).toFixed(1)} m) · skala tegak ×${(ky / kx).toFixed(1)}`;
  const W = { poly: $('#afW'), line: $('#afWl'), beam: $('#afBeam'), text: $('#afWt') };
  const fmt = { tma: v => `${v.toFixed(2)} mdpl`, dMax: v => `${v.toFixed(2)} m`, B: v => `${v.toFixed(2)} m`, A: v => `${v.toFixed(2)} m²`,
    vs: v => `${v.toFixed(2)} m/s`, v: v => `${v.toFixed(2)} m/s`, Q: v => `${v.toFixed(2)} m³/s`, read: v => `${v.toFixed(2)} m` };
  function sync() {
    if (!o.afSt.isConnected) return;                                          // panel sudah diganti seri lain
    const dh = level(), S = STATUS[levelStatus(dh)], F = flow(dh), wl = F.wl;
    o.afSt.textContent = S.label; o.afSt.style.color = ST_COLOR[S.st];
    const R = { ...F, tma: MDPL0 + SITES.afmr.y + wl, read: yBotNow - wl };
    for (const [k] of ROWS) o.afTab.querySelector(`[data-k="${k}"]`).textContent = fmt[k](R[k]);
    let xa = null, xb = null;
    W.poly.setAttribute('points', P.map(([x, y]) => `${X(x)},${Yp(Math.min(y, wl))}`).join(' ') + ` ${X(SEC.x1)},${Yp(wl)} ${X(SEC.x0)},${Yp(wl)}`);
    for (const [x, y] of P) if (y < wl) { xa ??= x; xb = x; }
    W.line.setAttribute('x1', X(xa ?? 0)); W.line.setAttribute('x2', X(xb ?? 0)); W.line.setAttribute('y1', Yp(wl)); W.line.setAttribute('y2', Yp(wl));
    W.beam.setAttribute('y2', Yp(wl));
    W.text.setAttribute('x', X((xb ?? SEC.x1) - 0.2)); W.text.setAttribute('y', +Yp(wl) - 4); W.text.setAttribute('text-anchor', 'end');
    W.text.textContent = `muka air · Q ${F.Q.toFixed(2)} m³/s`;
    for (const b of tests) { const on = !ENV.auto && Math.abs(ENV.manual - +b.dataset.v) < 0.005; b.style.borderColor = on ? 'var(--accent)' : ''; b.style.color = on ? 'var(--accent)' : ''; }
    o.afAuto.style.borderColor = ENV.auto ? 'var(--accent)' : ''; o.afAuto.style.color = ENV.auto ? 'var(--accent)' : '';
  }
  ui = { sync, t: 0 };
  sync();
}

// Explode: 3 klem dilepas (digeser ke samping), sadel + support + sensor diturunkan dari pipa, lalu kabel sensor dilepas
const explode = {
  steps: [{ key: 'sensor', before: 'cable', w: 8, label: 'kendurkan 3 clamp, support + sensor diturunkan' }, ...awlrRiver.explode.steps.filter(s => s.key !== 'sensor')],
  apply(model, seg, t) {
    awlrRiver.explode.apply(model, seg, t);
    const U = model.userData.awlr, eDn = seg('sensor', 0.35, 1);
    U.hrfBands.position.z = 0.12 * seg('sensor', 0, 0.4);
    U.hrf.position.y = -0.3 * eDn;
    U.hrfCable.position.set(0.3 * seg('cable', 0.44, 1), -0.18 * seg('cable', 0, 0.44) - 0.3 * eDn, 0);
  },
};

const G = 'AFMR Sungai';
const parts = {
  ...Object.fromEntries(Object.entries(awlrRiver.parts).filter(([k]) => k !== 'river' && k !== 'awlrSensor').map(([k, P]) => [k, { ...P, group: G }])),
  awlrArm: { name: 'Lengan Sensor', group: G, specs: () => [
    ['Material', `Pipa Ø${(ARM.pipeR * 2000).toFixed(1)} mm (perkiraan), cat biru`],
    ['Rangka', `Pipa atas ${ARM_AF.top * 1000} mm, bawah ${ARM_AF.bottom * 1000} mm (lengan AWLR + 2 m), celah 100 mm`],
    ['Pipa tegak', `${ARM_AF.posts.length} buah, jarak 1000 mm`],
    ['Pangkal', 'Dilas ke pipa sleeve'],
    ['Ujung', 'Pipa ditutup plat; bracket clamp sensor ± 50 mm dari ujung pipa bawah'],
  ]},
  hrf600s: { name: 'Radar Flow Meter HRF600S (Host)', group: G, specs: () => [
    ['Merek / varian', 'Holykell HRF600S, plastic joint'],
    ['Ukuran', '160 × 100 × 89,9 mm (badan 83,2 + lensa)'],
    ['Warna', 'Aluminium abu-abu gelap doff, plastic joint hitam, waterpass hijau (sesuai foto)'],
    ['Level', 'Radar 80 GHz, lensa di muka bawah'],
    ['Kecepatan', 'Radar 24 GHz di muka miring (kecepatan permukaan), menghadap ke hulu (asumsi)'],
    ['Debit', 'Luas penampang basah × kecepatan rata-rata'],
    ['Pasang', 'Sumbu panjang searah arus, digantung bracket clamp + support; waterpass di muka atas'],
    ['Tinggi ke muka air', `${(yBotNow - RIVER.water - level()).toFixed(2)} m dari lensa (saat ini)`],
    ['Kabel', 'Plastic joint → conduit hitam → konektor SP21 di box'],
  ]},
  awlrStay: { name: 'Sling Penahan Tiang', group: G, specs: () => [
    ['Fungsi', 'Menahan tiang dari tarikan lengan 5 m + sensor (sisi berlawanan lengan)'],
    ['Dari', 'Kuping kiri klem sling di tiang (kuping kanan untuk sling lengan)'],
    ['Ke', 'Mata angkur tanah ± 3,2 m dari tiang'],
    ['Ukuran', 'Sling baja Ø6 mm + spanskrup M10 + shackle (perkiraan, sama dengan sling lengan)'],
  ]},
  awlrAnchor: { name: 'Angkur Tanah', group: G, specs: () => [
    ['Bentuk', 'Blok beton tertanam + batang angkur Ø16 miring searah sling, ujung bermata'],
    ['Ukuran', 'Blok 500 × 500 × 500 mm, batang menonjol ± 360 mm (perkiraan)'],
    ['Letak', '± 3,2 m dari tiang, segaris lengan di sisi darat'],
  ]},
  hrfClamp: { name: 'Clamp', group: G, specs: () => [
    ['Tipe', '3 klem cincin (sekrup cacing) stainless, sesuai foto'],
    ['Mengikat', 'Sadel bracket ke pipa bawah lengan, ± 50 mm dari ujung'],
    ['Ukuran', `Lebar ${BR.band * 1000} mm, jarak ${(BR.bands[1] - BR.bands[0]) * 1000} mm (perkiraan)`],
  ]},
  hrfSupport: { name: 'Support', group: G, specs: () => [
    ['Bentuk', 'Sadel + yoke atas + badan + yoke bawah + rel, sesuai foto'],
    ['Engsel', 'Baut atas sejajar pipa, baut pivot bawah tegak lurus pipa (atur kemiringan 2 arah)'],
    ['Tinggi', `± ${BR.drop * 1000} mm dari bawah sadel ke muka atas sensor (perkiraan dari foto)`],
  ]},
  hrfBase: { name: 'Plat Dasar Support', group: G, specs: () => [
    ['Pasang', '4 baut M5 + ring ke lubang ulir muka atas sensor'],
    ['Pola', '85 × 85 mm (gambar sensor)'],
    ['Ukuran plat', '100 × 100 × 5 mm (perkiraan)'],
  ]},
  cctv: { name: 'CCTV', group: G, specs: () => [
    ['Tipe', 'Kamera bullet (sesuai foto Hikvision), badan putih, muka hitam'],
    ['Letak', `Di tiang ± ${CAM.below * 1000} mm di bawah ujung tiang (di bawah panel surya), sisi lengan`],
    ['Arah', 'Menunduk ke sensor di ujung lengan & alur sungai'],
    ['Ukuran', `Badan ± ${CAM.L * 1000} × ${CAM.S * 1000} × ${CAM.S * 1000} mm, dudukan Ø${CAM.baseR * 2000} mm (perkiraan)`],
    ['Daya & kabel', 'Panel surya & enclosure CCTV sendiri; kabel lewat conduit → SP21 box CCTV'],
  ]},
  cctvMount: { name: 'Dudukan CCTV', group: G, specs: () => [
    ['Bentuk', 'Plat tegak + 2 klem cincin stainless melingkari tiang (perkiraan)'],
    ['Ukuran', `${CAM.plateH * 1000} × ${CAM.plateW * 1000} × ${CAM.plateT * 1000} mm (perkiraan)`],
  ]},
  cctvCable: { name: 'Kabel CCTV + Conduit', group: G, specs: () => [
    ['Dari', 'Konektor SP21 di dinding bawah enclosure CCTV'],
    ['Jalur', 'Conduit hitam naik di sisi belakang-kiri tiang, melingkar di bawah kamera'],
    ['Ke', 'Kamera CCTV'],
  ]},
  riverAfmr: { name: 'Sungai & Penampang', group: G, specs: () => { const F = flow(level()); return [
    ['Letak', `± ${Math.round(AFMR.xc - AWLR_POS.x)} m di hulu stasiun AWLR (diorama)`],
    ['Penampang', `Di bawah lengan, dari tiang ke seberang (${(SEC.x1 - SEC.x0).toFixed(1)} m, profil medan diorama)`],
    ['Lebar muka air', `${F.B.toFixed(2)} m (saat ini)`],
    ['Luas basah', `${F.A.toFixed(2)} m² (saat ini)`],
    ['Hidrolis', `Manning n ${HYD.n}, kemiringan ${HYD.S}, k ${HYD.k} (perkiraan)`],
  ]; } },
};

export const afmr = {
  station: awlrRiver.station,
  encYMax: awlrRiver.encYMax, pvBulge: awlrRiver.pvBulge,
  extend, panel, parts, update, explode,
  mapStatus: () => STATUS[levelStatus(level())].st,
  views: awlrRiver.views,
};
// Dimuat lewat products.js: definisi siap setelah geometri STL sensor terbaca
export const ready = loadSensor().then(() => afmr);
