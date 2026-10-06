import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * 3D 도면 뷰어. 데이터는 둘 중 하나로 들어온다.
 *
 * (1) window.__GLB__  = "<.glb 파일의 base64>"   ← Blender에서 glTF로 내보낸 파일 그대로
 *     바 종류는 오브젝트 이름의 첫 '_' 앞부분으로 묶는다 (NS112SL104_Left → NS112SL104).
 *     재질 이름이 DIM 으로 시작하거나 이름이 D숫자_ 로 시작하면 '치수선'으로 묶는다.
 * (2) window.__BARS__ = [{ id, name, length, color:"#rrggbb", positions:[x,y,z,...], indices:[a,b,c,...] }]
 *
 * window.__INFO__ = { title, note, color } (선택). color 는 주문 색상(화이트/블랙/실버/헨켈/기타)이며 모든 바를 그 색으로 칠한다.
 * 단위는 mm(숫자 그대로).
 */
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

// 주문 색상 -> 화면에 칠할 색과 외곽선 색
const ORDER_COLORS = {
  화이트: { fill: '#f1f2f3', edge: '#8a929a' },
  블랙: { fill: '#1f2124', edge: '#6a7178' },
  실버: { fill: '#c4cacf', edge: '#6a747e' },
  헨켈: { fill: '#c0a073', edge: '#6a5233' }, // 밝은 브론즈
  기타: { fill: '#8c9f7a', edge: '#4d5c40' }, // 그 밖의 색 (연한 올리브)
};
const PAINT = ORDER_COLORS[info.color] || ORDER_COLORS['실버'];
const DIM_GROUP = '치수선';
const DIM_COLOR = 0xff2020; // 치수선 색 (밝은 배경·어두운 배경 모두에서 잘 보이는 빨간색)
const BACKGROUNDS = { light: 0xf4f6f8, dark: 0x1b1d20 };

// 그룹 이름 -> { items: [{ mesh, label, length }], lengths: Set }  (items 하나가 바 하나)
const groups = new Map();
const root = new THREE.Group();
scene.add(root);

function addToGroup(name, mesh, length, label) {
  if (!groups.has(name)) groups.set(name, { items: [], lengths: new Set() });
  const g = groups.get(name);
  g.items.push({ mesh, label: label || mesh.name || name, length: length ? Math.round(length) : 0 });
  if (length) g.lengths.add(Math.round(length));
}

// 모든 바를 같은 색으로 칠한다 (면마다 밝기가 달라 보이지 않도록 금속 느낌은 약하게)
function decorate(mesh) {
  mesh.material = new THREE.MeshStandardMaterial({ color: PAINT.fill, metalness: 0.15, roughness: 0.7, side: THREE.DoubleSide });
  mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 45), new THREE.LineBasicMaterial({ color: PAINT.edge })));
}

function loadBars(bars) {
  for (const b of bars) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
    g.setIndex(b.indices);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    decorate(mesh);
    root.add(mesh);
    addToGroup(b.name, mesh, b.length, b.id);
  }
  root.rotation.x = -Math.PI / 2; // Blender는 Z-up, three.js는 Y-up
}

// base64 -> ArrayBuffer. gzip 으로 압축되어 있으면(앞 두 바이트 1f 8b) 브라우저 기능으로 풀어서 돌려준다.
// 압축해서 넣으면 도면 파일이 훨씬 작아져 올리기·열기가 빨라진다.
async function decodeGlb(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  return bytes.buffer;
}

async function loadGlb(base64) {
  const arrayBuffer = await decodeGlb(base64);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, '', (gltf) => {
      gltf.scene.updateMatrixWorld(true);
      const meshes = [];
      gltf.scene.traverse((o) => o.isMesh && meshes.push(o));
      for (const m of meshes) {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        const isDim = mats.some((x) => x?.name?.startsWith('DIM')) || /^D\d+_/.test(m.name);
        const name = isDim ? DIM_GROUP : m.name.split('_')[0];
        const size = new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3());
        // 치수선(선·눈금·글자)은 항상 빨간색. 조명 영향을 받지 않는 재질로 어느 배경에서도 선명하게 보인다.
        if (isDim) m.material = new THREE.MeshBasicMaterial({ color: DIM_COLOR, side: THREE.DoubleSide });
        else decorate(m);
        addToGroup(name, m, isDim ? 0 : Math.max(size.x, size.y, size.z), m.name);
      }
      root.add(gltf.scene); // glTF는 이미 Y-up
      resolve();
    }, reject);
  });
}

async function main() {
  try {
    if (window.__GLB__) await loadGlb(window.__GLB__);
    else loadBars(window.__BARS__ || []);
  } catch (e) {
    document.getElementById('note').textContent = '도면을 읽지 못했습니다: ' + (e && e.message ? e.message : e);
    return;
  }
  start();
}

function start() {
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 100);
  root.position.sub(center);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false; // 손을 떼면 바로 멈춘다 (관성으로 미끄러지지 않게)
  controls.screenSpacePanning = true; // 오른쪽 버튼/두 손가락으로 이동
  controls.minDistance = radius * 0.25; // 너무 가까이/멀리 가서 길을 잃지 않게
  controls.maxDistance = radius * 6;

  // 조작 감도: 느리게/보통/빠르게 (선택은 기억해 둔다)
  const SENS = {
    slow: { rotate: 0.2, zoom: 0.3, pan: 0.4 },
    normal: { rotate: 0.4, zoom: 0.5, pan: 0.6 },
    fast: { rotate: 0.9, zoom: 1.0, pan: 1.0 },
  };
  const sensSel = document.getElementById('sens');
  const applySens = (key) => {
    const s = SENS[key] || SENS.normal;
    controls.rotateSpeed = s.rotate;
    controls.zoomSpeed = s.zoom;
    controls.panSpeed = s.pan;
    sensSel.value = key in SENS ? key : 'normal';
    try { localStorage.setItem('drawing.sens', sensSel.value); } catch (e) { /* 저장 못 해도 상관없음 */ }
  };
  let saved = 'normal';
  try { saved = localStorage.getItem('drawing.sens') || 'normal'; } catch (e) { /* 무시 */ }
  applySens(saved);
  sensSel.onchange = () => applySens(sensSel.value);

  // 배경색: 버튼을 누를 때마다 밝은 배경 <-> 어두운 배경 (선택은 기억해 둔다)
  // 버튼 글자(Dark / White)는 '누르면 바뀔 배경'을 알려 준다.
  const bgBtn = document.getElementById('bg');
  let bgKey = 'light';
  const applyBg = (key) => {
    bgKey = key in BACKGROUNDS ? key : 'light';
    scene.background = new THREE.Color(BACKGROUNDS[bgKey]);
    bgBtn.textContent = bgKey === 'light' ? 'Dark' : 'White';
    try { localStorage.setItem('drawing.bg', bgKey); } catch (e) { /* 저장 못 해도 상관없음 */ }
  };
  let savedBg = 'light';
  try { savedBg = localStorage.getItem('drawing.bg') || 'light'; } catch (e) { /* 무시 */ }
  applyBg(savedBg);
  bgBtn.onclick = () => applyBg(bgKey === 'light' ? 'dark' : 'light');
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

  // ---------- 오른쪽 패널: 바 종류(그룹) 아래에 바 하나하나를 보여 주고 각각 숨김/표시 ----------
  const list = document.getElementById('list');
  const groupRows = []; // { gcb, items:[{cb, mesh}] }
  const names = [...groups.keys()].sort((a, b) => (a === DIM_GROUP) - (b === DIM_GROUP));

  // 목록 위에 마우스를 올리면(또는 손가락으로 누르면) 그 바가 3D 화면에서 주황색으로 깜빡여 어디인지 알 수 있다
  const flash = (mesh, on) => {
    if (mesh.material && mesh.material.emissive) mesh.material.emissive.set(on ? 0xff6a00 : 0x000000);
  };
  const syncGroup = (row) => {
    const n = row.items.filter((i) => i.cb.checked).length;
    row.gcb.checked = n === row.items.length;
    row.gcb.indeterminate = n > 0 && n < row.items.length;
  };

  for (const name of names) {
    const grp = groups.get(name);
    const isDim = name === DIM_GROUP;
    const box = document.createElement('div');
    box.className = 'grp';

    const head = document.createElement('div');
    head.className = 'row head';
    const gl = document.createElement('label');
    gl.className = 'lbl';
    const gcb = document.createElement('input');
    gcb.type = 'checkbox';
    gcb.checked = true;
    const gt = document.createElement('span');
    const lens = [...grp.lengths].sort((a, b) => b - a).join(', ');
    gt.textContent = isDim ? name : `${name} × ${grp.items.length}` + (lens ? ` (${lens}mm)` : '');
    gl.append(gcb, gt);
    const exp = document.createElement('button');
    exp.type = 'button';
    exp.className = 'exp';
    head.append(gl, exp);
    box.append(head);

    const sub = document.createElement('div');
    sub.className = 'sub';
    const rowData = { gcb, items: [] };
    for (const it of grp.items) {
      const r = document.createElement('label');
      r.className = 'row item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.onchange = () => { it.mesh.visible = cb.checked; syncGroup(rowData); };
      const t = document.createElement('span');
      t.textContent = it.label + (it.length ? ` · ${it.length}mm` : '');
      r.append(cb, t);
      r.onmouseenter = () => flash(it.mesh, true);
      r.onmouseleave = () => flash(it.mesh, false);
      r.ontouchstart = () => { flash(it.mesh, true); setTimeout(() => flash(it.mesh, false), 900); };
      sub.append(r);
      rowData.items.push({ cb, mesh: it.mesh });
    }
    box.append(sub);
    gcb.onchange = () => {
      rowData.items.forEach(({ cb, mesh }) => { cb.checked = gcb.checked; mesh.visible = gcb.checked; });
      gcb.indeterminate = false;
    };

    // 처음에는 모두 접어 둔다 (펼치기를 누르면 바 하나하나가 나온다)
    const setOpen = (open) => { sub.hidden = !open; exp.textContent = open ? '접기 ▲' : '펼치기 ▼'; };
    exp.onclick = () => setOpen(sub.hidden);
    setOpen(false);
    list.append(box);
    groupRows.push(rowData);
  }

  const setAll = (v) => groupRows.forEach((row) => {
    row.items.forEach(({ cb, mesh }) => { cb.checked = v; mesh.visible = v; });
    syncGroup(row);
  });
  // 초기화면: 시점을 처음으로 되돌리고, 숨겨 둔 바도 모두 다시 보이게 한다
  document.getElementById('home').onclick = () => { setAll(true); home(); };
  document.getElementById('title').textContent = info.title || '3D 도면';
  document.getElementById('note').textContent = info.note || '';
  if (!groups.size) document.getElementById('note').textContent = '표시할 바가 없습니다.';

  // ---------- 패널 숨기기 / 보이기 ----------
  const panel = document.getElementById('panel');
  const toggle = document.getElementById('toggle');
  const applyPanel = (show) => {
    panel.hidden = !show;
    toggle.textContent = show ? '패널 숨기기 ▶' : '◀ 패널 보기';
    resize(); // 3D 화면 크기를 다시 맞춘다
  };
  toggle.onclick = () => applyPanel(panel.hidden);
}

main();