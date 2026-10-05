import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * 3D 도면 뷰어.
 * window.__BARS__ = [{ id, name, length, color:"#rrggbb", positions:[x,y,z,...], indices:[a,b,c,...] }]
 * (단위 mm, 같은 name의 바는 패널에서 한 줄로 묶어 숨김/표시)
 * window.__INFO__ = { title, note } (선택)
 */
const bars = window.__BARS__ || [];
const info = window.__INFO__ || {};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4f6f8);
const camera = new THREE.PerspectiveCamera(45, 1, 1, 100000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.getElementById('view').appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(1, 2, 3);
scene.add(sun);

// name -> { meshes: Mesh[], count }
const groups = new Map();
const root = new THREE.Group();
scene.add(root);

for (const b of bars) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
  g.setIndex(b.indices);
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: b.color || '#c8ccd0', metalness: 0.4, roughness: 0.5, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), new THREE.LineBasicMaterial({ color: 0x334155 })));
  root.add(mesh);
  if (!groups.has(b.name)) groups.set(b.name, { meshes: [], lengths: new Set() });
  const grp = groups.get(b.name);
  grp.meshes.push(mesh);
  if (b.length) grp.lengths.add(Math.round(b.length));
}

// Blender는 Z-up, three.js는 Y-up
root.rotation.x = -Math.PI / 2;

const box = new THREE.Box3().setFromObject(root);
const center = box.getCenter(new THREE.Vector3());
const size = box.getSize(new THREE.Vector3());
const radius = Math.max(size.x, size.y, size.z, 100);
root.position.sub(center);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.screenSpacePanning = true; // 오른쪽 버튼/두 손가락으로 이동
const home = () => {
  camera.position.set(radius * 0.9, radius * 0.7, radius * 1.4);
  camera.near = radius / 1000;
  camera.far = radius * 20;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
};
home();

function resize() {
  const el = document.getElementById('view');
  const w = el.clientWidth, h = el.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
(function loop() {
  requestAnimationFrame(loop);
  controls.update();
  renderer.render(scene, camera);
})();

// ---------- 오른쪽 패널: 바별 표시/숨김 ----------
const list = document.getElementById('list');
const rows = [];
for (const [name, grp] of groups) {
  const row = document.createElement('label');
  row.className = 'row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = true;
  cb.onchange = () => grp.meshes.forEach((m) => (m.visible = cb.checked));
  const text = document.createElement('span');
  const lens = [...grp.lengths].sort((a, b) => b - a).join(', ');
  text.textContent = `${name} × ${grp.meshes.length}` + (lens ? ` (${lens}mm)` : '');
  row.append(cb, text);
  list.append(row);
  rows.push({ cb, grp });
}
const setAll = (v) => rows.forEach(({ cb, grp }) => { cb.checked = v; grp.meshes.forEach((m) => (m.visible = v)); });
document.getElementById('all').onclick = () => setAll(true);
document.getElementById('none').onclick = () => setAll(false);
document.getElementById('home').onclick = home;
document.getElementById('title').textContent = info.title || '3D 도면';
document.getElementById('note').textContent = info.note || '';
if (!bars.length) document.getElementById('note').textContent = '표시할 바가 없습니다.';
