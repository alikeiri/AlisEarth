// Standalone WebGL-vs-WebGPU benchmark for an Ali's Earth-style scene: a heavy
// field of shadow-casting, moving instanced units over a lit ground. Renders the
// SAME scene with both backends back-to-back and reports average FPS, so we can
// see whether a WebGPU port is worth it on real hardware. Not part of the game.
import * as THREE from 'three';
import WebGPURenderer from 'three/examples/jsm/renderers/webgpu/WebGPURenderer.js';

const out = document.getElementById('out')!;
const log = (s: string) => { out.textContent = s; };
const append = (s: string) => { out.textContent += '\n' + s; };

// build a representative scene; returns the pieces + a per-frame animator that
// moves every unit (so shadows must re-render each frame, like real play)
function buildScene(nInf: number, nVeh: number, shadows: boolean) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x223042);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 600);
  camera.position.set(70, 70, 110);
  camera.lookAt(70, 0, 70);

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x40391f, 1.0));
  const sun = new THREE.DirectionalLight(0xffe7c4, 2.2);
  sun.position.set(110, 90, 60); sun.target.position.set(70, 0, 70);
  sun.castShadow = shadows;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -90; sc.right = 90; sc.top = 90; sc.bottom = -90; sc.far = 320;
  scene.add(sun, sun.target);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(220, 220),
    new THREE.MeshStandardMaterial({ color: 0x6b7a4a, roughness: 0.95, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2; ground.position.set(70, 0, 70); ground.receiveShadow = true;
  scene.add(ground);

  const dummy = new THREE.Object3D();
  const mkInst = (geo: THREE.BufferGeometry, color: number, n: number) => {
    const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.15 }), n);
    m.castShadow = shadows; m.frustumCulled = false;
    scene.add(m);
    return m;
  };
  const inf = mkInst(new THREE.CapsuleGeometry(0.35, 0.9, 4, 8), 0x556b2f, nInf);
  const veh = mkInst(new THREE.BoxGeometry(1.4, 0.8, 2.0), 0x4d5a6b, nVeh);

  // scatter units across the field, each with its own orbit so they all move
  const seed = (i: number, k: number) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
  const place = (mesh: THREE.InstancedMesh, n: number, t: number) => {
    for (let i = 0; i < n; i++) {
      const bx = 6 + seed(i, 1) * 128, bz = 6 + seed(i, 2) * 128;
      const r = 2 + seed(i, 3) * 4, sp = 0.3 + seed(i, 4) * 0.7;
      dummy.position.set(bx + Math.cos(t * sp + i) * r, 0.6, bz + Math.sin(t * sp + i) * r);
      dummy.rotation.y = t * sp + i;
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  const animate = (t: number) => { place(inf, nInf, t); place(veh, nVeh, t); };
  animate(0);
  return { scene, camera, animate };
}

async function runBench(
  make: (canvas: HTMLCanvasElement) => any | Promise<any>, label: string,
  nInf: number, nVeh: number, shadows: boolean, ms: number,
): Promise<{ label: string; fps: number; tris: number; calls: number }> {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const renderer = await make(canvas);
  renderer.setPixelRatio(Math.min(1, devicePixelRatio));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = shadows;
  if ((THREE as any).PCFSoftShadowMap) renderer.shadowMap.type = (THREE as any).PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const { scene, camera, animate } = buildScene(nInf, nVeh, shadows);

  // warm up (shader compile / pipeline build) before timing
  for (let i = 0; i < 20; i++) { animate(i * 0.05); await renderFrame(renderer, scene, camera); }

  const t0 = performance.now();
  let frames = 0, last = t0;
  while (performance.now() - t0 < ms) {
    const now = performance.now();
    animate(now / 1000);
    await renderFrame(renderer, scene, camera);
    frames++; last = now;
  }
  const secs = (last - t0) / 1000;
  const info = (renderer.info && renderer.info.render) || {};
  const res = { label, fps: frames / Math.max(0.001, secs), tris: info.triangles || 0, calls: info.drawCalls || info.calls || 0 };
  renderer.dispose && renderer.dispose();
  canvas.remove();
  return res;
}

// drive one frame, waiting for vsync, and (WebGPU) for the GPU submit to resolve
function renderFrame(renderer: any, scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
  return new Promise(res => requestAnimationFrame(async () => {
    if (renderer.renderAsync) await renderer.renderAsync(scene, camera);
    else renderer.render(scene, camera);
    res();
  }));
}

async function main() {
  const nInf = +(document.getElementById('nInf') as HTMLInputElement).value || 6000;
  const nVeh = +(document.getElementById('nVeh') as HTMLInputElement).value || 1500;
  const shadows = (document.getElementById('shadows') as HTMLInputElement).checked;
  const gpuOk = !!(navigator as any).gpu;
  const secure = (window as any).isSecureContext;
  log(`Scene: ${nInf} soldiers + ${nVeh} vehicles, shadows ${shadows ? 'on' : 'off'}\n`
    + `WebGPU available: ${gpuOk}${!gpuOk && !secure ? '  (this page is HTTP — WebGPU needs HTTPS or localhost)' : ''}\n`
    + `Running… (each backend ~5s)`);

  const results: any[] = [];
  // WebGL first
  const gl = await runBench((canvas) => new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' } as any), 'WebGL', nInf, nVeh, shadows, 5000);
  results.push(gl);
  append(`WebGL : ${gl.fps.toFixed(1)} fps   (${(gl.tris / 1e6).toFixed(2)}M tris, ${gl.calls} draws)`);

  if (gpuOk) {
    try {
      const wgpu = await runBench(async (canvas) => { const r = new WebGPURenderer({ canvas, antialias: true } as any); await r.init(); return r; }, 'WebGPU', nInf, nVeh, shadows, 5000);
      results.push(wgpu);
      append(`WebGPU: ${wgpu.fps.toFixed(1)} fps   (${(wgpu.tris / 1e6).toFixed(2)}M tris, ${wgpu.calls} draws)`);
      const d = ((wgpu.fps - gl.fps) / gl.fps * 100);
      append(`\nWebGPU is ${d >= 0 ? '+' : ''}${d.toFixed(0)}% vs WebGL`);
    } catch (e: any) {
      append(`WebGPU failed: ${e?.message || e}`);
    }
  } else if (!secure) {
    append('WebGPU unavailable: this page is served over HTTP. WebGPU requires a\nsecure context — open it on https:// or http://localhost to test it.\n(Note: WebGPU would also need HTTPS in the live game — but it works in an\nElectron/Steam build, which is always a secure context.)');
  } else {
    append('WebGPU not available (needs Chrome/Edge ~113+ with WebGPU enabled).');
  }
  (window as any).__bench = results;
}

(document.getElementById('run') as HTMLButtonElement).addEventListener('click', () => {
  (document.getElementById('run') as HTMLButtonElement).disabled = true;
  main().finally(() => { (document.getElementById('run') as HTMLButtonElement).disabled = false; });
});
