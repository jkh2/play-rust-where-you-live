import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { sampleRelief, type Relief } from "@/lib/relief";
import type { RustMonument } from "@/lib/rustmaps.functions";

export type Probe = {
  east: number;
  north: number;
  elevation: number;
  grid: string;
};

export type Chart = {
  size: number;
  image: HTMLImageElement;
  relief: Relief;
  monuments: RustMonument[];
  showSmall: boolean;
};

type ControlsProbe = {
  getYaw: () => number;
  getSpeed: () => number;
  getPos: () => { x: number; y: number; z: number };
  setKeys: (codes: string[]) => void;
  setFly: (on: boolean) => void;
};

declare global {
  interface Window {
    __controlsTest?: ControlsProbe;
  }
}

const TERRAIN_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec2 vUv;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const TERRAIN_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uSun;
  uniform vec3 uFog;
  uniform float uFogFar;
  uniform float uCell;
  uniform float uContour;
  uniform float uGridOn;
  uniform float uContourOn;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec2 vUv;
  void main() {
    vec3 albedo = texture2D(uMap, vUv).rgb;
    float ndl = clamp(dot(normalize(vNormal), normalize(uSun)), 0.0, 1.0);
    vec3 col = albedo * (0.62 + 0.48 * ndl);
    if (uContourOn > 0.5) {
      float bands = vWorld.y / uContour;
      float fw = fwidth(bands);
      float edge = min(fract(bands), 1.0 - fract(bands));
      float line = 1.0 - smoothstep(0.0, fw * 1.25, edge);
      col = mix(col, vec3(0.95, 0.9, 0.8), line * 0.45);
    }
    if (uGridOn > 0.5 && uCell > 1.0) {
      vec2 g = vWorld.xz / uCell;
      vec2 fw = fwidth(g);
      vec2 dist = min(fract(g), 1.0 - fract(g));
      float line = 1.0 - smoothstep(0.0, max(fw.x, fw.y) * 1.15, min(dist.x, dist.y));
      col = mix(col, vec3(0.93, 0.86, 0.7), line * 0.4);
    }
    float fog = smoothstep(uFogFar * 0.55, uFogFar, distance(vWorld, cameraPosition));
    gl_FragColor = vec4(mix(col, uFog, fog), 1.0);
  }
`;

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vDir = world.xyz - cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uSun;
  varying vec3 vDir;
  void main() {
    vec3 dir = normalize(vDir);
    float h = dir.y * 0.5 + 0.5;
    vec3 zenith = vec3(0.42, 0.58, 0.7);
    vec3 horizon = vec3(0.86, 0.75, 0.62);
    vec3 ground = vec3(0.22, 0.18, 0.15);
    vec3 col = mix(horizon, zenith, smoothstep(0.48, 0.85, h));
    col = mix(ground, col, smoothstep(0.0, 0.45, h));
    float sun = pow(max(dot(dir, normalize(uSun)), 0.0), 380.0);
    col += sun * vec3(1.0, 0.86, 0.62);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const WATER_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorld;
  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - abs(dot(viewDir, vec3(0.0, 1.0, 0.0))), 1.6);
    vec3 deep = vec3(0.04, 0.16, 0.22);
    vec3 shallow = vec3(0.16, 0.42, 0.46);
    vec3 col = mix(deep, shallow, fres);
    float spark = sin(vWorld.x * 0.08 + uTime * 0.6) * sin(vWorld.z * 0.07 - uTime * 0.45);
    col += spark * 0.025;
    gl_FragColor = vec4(col, 0.72);
  }
`;

function colLabel(index: number) {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

export class MapScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly scene = new THREE.Scene();
  readonly controls: OrbitControls;
  mode: "orbit" | "fly" = "orbit";
  reliefScale = 180;
  exaggeration = 1.7;
  private chart: Chart | null = null;
  private terrain: THREE.Mesh | null = null;
  private terrainMat: THREE.ShaderMaterial | null = null;
  private water: THREE.Mesh | null = null;
  private waterMat: THREE.ShaderMaterial | null = null;
  private skyMat: THREE.ShaderMaterial | null = null;
  private texture: THREE.Texture | null = null;
  private labels: HTMLButtonElement[] = [];
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = -0.45;
  private speed = 0;
  private last = performance.now();
  private look = new THREE.Vector3();
  private right = new THREE.Vector3();
  private velocity = new THREE.Vector3();
  private wish = new THREE.Vector3();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private sun = new THREE.Vector3(0.45, 0.72, 0.35).normalize();
  private onProbe: (probe: Probe | null) => void;
  private onMode: (mode: "orbit" | "fly") => void;
  private labelRoot: HTMLElement;
  private disposed = false;

  constructor(
    mount: HTMLElement,
    labelRoot: HTMLElement,
    onProbe: (probe: Probe | null) => void,
    onMode: (mode: "orbit" | "fly") => void,
  ) {
    this.onProbe = onProbe;
    this.onMode = onMode;
    this.labelRoot = labelRoot;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mount.clientWidth < 800 ? 1.25 : 1.75));
    this.renderer.setSize(mount.clientWidth, mount.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.touchAction = "none";
    mount.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.5, 20000);
    this.camera.position.set(0, 900, 1600);
    this.resize();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 30;
    this.controls.target.set(0, 40, 0);

    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(9000, 24, 16),
      (this.skyMat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: { uSun: { value: this.sun } },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
      })),
    );
    this.scene.add(sky);

    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("click", this.onCanvasClick);
    canvas.addEventListener("dblclick", this.onDoubleClick);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.clearKeys);
    document.addEventListener("mousemove", this.onMouseLook);
    document.addEventListener("pointerlockchange", this.onLockChange);

    window.__controlsTest = {
      getYaw: () => this.yaw,
      getSpeed: () => this.speed,
      getPos: () => ({ x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z }),
      setKeys: (codes) => {
        this.keys = new Set(codes);
      },
      setFly: (on) => this.setMode(on ? "fly" : "orbit"),
    };

    this.renderer.setAnimationLoop(this.frame);
  }

  resize() {
    const parent = this.renderer.domElement.parentElement;
    if (!parent) return;
    const w = parent.clientWidth || 1;
    const h = parent.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  setMode(mode: "orbit" | "fly") {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === "fly") {
      const euler = new THREE.Euler(0, 0, 0, "YXZ").setFromQuaternion(this.camera.quaternion);
      this.yaw = euler.y;
      this.pitch = euler.x;
      this.controls.enabled = false;
      this.velocity.set(0, 0, 0);
    } else {
      this.controls.enabled = true;
      this.syncLook();
      this.controls.target.copy(this.camera.position).addScaledVector(this.look, 280);
      if (document.pointerLockElement) document.exitPointerLock();
    }
    this.onMode(mode);
  }

  setExaggeration(value: number) {
    this.exaggeration = value;
    this.rebuildHeights();
  }

  setGrid(on: boolean) {
    if (this.terrainMat) this.terrainMat.uniforms.uGridOn.value = on ? 1 : 0;
  }

  setContours(on: boolean) {
    if (this.terrainMat) this.terrainMat.uniforms.uContourOn.value = on ? 1 : 0;
  }

  setSun(azimuthDeg: number) {
    const a = (azimuthDeg * Math.PI) / 180;
    this.sun.set(Math.cos(a) * 0.85, 0.62, Math.sin(a) * 0.85).normalize();
  }

  load(chart: Chart, keepView = false) {
    this.chart = chart;
    this.clearLabels();
    if (this.terrain) {
      this.scene.remove(this.terrain);
      this.terrain.geometry.dispose();
      this.terrain = null;
    }
    if (this.water) {
      this.scene.remove(this.water);
      this.water.geometry.dispose();
      this.water = null;
    }
    this.texture?.dispose();
    const tex = new THREE.Texture(chart.image);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    this.texture = tex;

    const res = chart.relief.resolution;
    const seg = Math.min(res - 1, window.innerWidth < 800 ? 160 : res - 1);
    const geo = new THREE.PlaneGeometry(chart.size, chart.size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    this.writeHeights(geo, chart);

    const cells = Math.max(8, Math.round(chart.size / 150));
    this.terrainMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: tex },
        uSun: { value: this.sun },
        uFog: { value: new THREE.Color("#cbb89a") },
        uFogFar: { value: chart.size * 1.35 },
        uCell: { value: chart.size / cells },
        uContour: { value: 18 },
        uGridOn: { value: 1 },
        uContourOn: { value: 1 },
      },
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
    });
    this.terrain = new THREE.Mesh(geo, this.terrainMat);
    this.scene.add(this.terrain);

    const waterGeo = new THREE.PlaneGeometry(chart.size * 1.15, chart.size * 1.15);
    waterGeo.rotateX(-Math.PI / 2);
    this.waterMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        varying vec3 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: WATER_FRAG,
    });
    this.water = new THREE.Mesh(waterGeo, this.waterMat);
    this.water.position.y = this.scale() * 0.02;
    this.water.renderOrder = 2;
    this.scene.add(this.water);

    this.camera.far = chart.size * 4;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = 24;
    this.controls.maxDistance = chart.size * 1.6;
    if (!keepView) {
      this.camera.position.set(chart.size * 0.05, chart.size * 0.42, chart.size * 0.62);
      this.controls.target.set(0, this.scale() * 0.12, 0);
    }
    this.controls.update();
    this.placeLabels();
  }

  swapImage(image: HTMLImageElement) {
    if (!this.chart || !this.texture) return;
    this.chart.image = image;
    this.texture.image = image;
    this.texture.needsUpdate = true;
  }

  setShowSmall(on: boolean) {
    if (!this.chart) return;
    this.chart.showSmall = on;
    this.placeLabels();
  }

  focusMonument(m: RustMonument) {
    if (!this.chart) return;
    const z = -m.y;
    const y = sampleRelief(this.chart.relief, this.chart.size, m.x, z) * this.scale();
    this.controls.target.set(m.x, y + 12, z);
    this.camera.position.set(m.x + this.chart.size * 0.06, y + this.chart.size * 0.08, z + this.chart.size * 0.1);
    this.controls.update();
  }

  heading() {
    return this.yaw;
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.clearLabels();
    this.controls.dispose();
    this.terrain?.geometry.dispose();
    this.terrainMat?.dispose();
    this.water?.geometry.dispose();
    this.waterMat?.dispose();
    this.skyMat?.dispose();
    this.texture?.dispose();
    this.renderer.domElement.remove();
    this.renderer.dispose();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.clearKeys);
    document.removeEventListener("mousemove", this.onMouseLook);
    document.removeEventListener("pointerlockchange", this.onLockChange);
    if (window.__controlsTest) delete window.__controlsTest;
  }

  private scale() {
    return this.reliefScale * this.exaggeration;
  }

  private writeHeights(geo: THREE.BufferGeometry, chart: Chart) {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
    const scale = this.scale();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = sampleRelief(chart.relief, chart.size, x, z);
      pos.setY(i, h * scale);
      uv.setXY(i, x / chart.size + 0.5, 0.5 - z / chart.size);
    }
    pos.needsUpdate = true;
    uv.needsUpdate = true;
    geo.computeVertexNormals();
  }

  private rebuildHeights() {
    if (!this.chart || !this.terrain) return;
    this.writeHeights(this.terrain.geometry, this.chart);
    if (this.water) this.water.position.y = this.scale() * 0.02;
    if (this.terrainMat) this.terrainMat.uniforms.uContour.value = Math.max(8, 12 * this.exaggeration);
  }

  private placeLabels() {
    this.clearLabels();
    if (!this.chart) return;
    const list = this.chart.monuments.filter((m) =>
      this.chart!.showSmall ? true : m.category === "LargeMonument",
    );
    for (const m of list) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pin";
      const name = document.createElement("span");
      name.textContent = m.name;
      const dot = document.createElement("i");
      btn.append(name, dot);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.focusMonument(m);
      });
      btn.dataset.x = String(m.x);
      btn.dataset.y = String(m.y);
      this.labelRoot.appendChild(btn);
      this.labels.push(btn);
    }
  }

  private clearLabels() {
    for (const el of this.labels) el.remove();
    this.labels = [];
  }

  private updateLabels() {
    if (!this.chart) return;
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    const v = new THREE.Vector3();
    const scale = this.scale();
    const ranked: { el: HTMLButtonElement; sx: number; sy: number; depth: number }[] = [];
    for (const el of this.labels) {
      const x = Number(el.dataset.x);
      const north = Number(el.dataset.y);
      const z = -north;
      const y = Math.max(sampleRelief(this.chart.relief, this.chart.size, x, z) * scale, scale * 0.03);
      v.set(x, y, z).project(this.camera);
      if (v.z > 1 || v.z < -1) {
        el.style.display = "none";
        continue;
      }
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      if (sx < -40 || sy < -40 || sx > w + 40 || sy > h + 40) {
        el.style.display = "none";
        continue;
      }
      ranked.push({ el, sx, sy, depth: v.z });
    }
    ranked.sort((a, b) => a.depth - b.depth);
    const placed: { x: number; y: number }[] = [];
    for (const item of ranked) {
      const crowded = placed.some((p) => (p.x - item.sx) ** 2 + (p.y - item.sy) ** 2 < 70 * 70);
      if (crowded) {
        item.el.style.display = "none";
        continue;
      }
      placed.push({ x: item.sx, y: item.sy });
      item.el.style.display = "flex";
      item.el.style.left = `${item.sx}px`;
      item.el.style.top = `${item.sy}px`;
    }
  }

  private gridAt(x: number, z: number) {
    if (!this.chart) return "";
    const size = this.chart.size;
    const cells = Math.max(8, Math.round(size / 150));
    const col = Math.max(0, Math.min(cells - 1, Math.floor(((x + size / 2) / size) * cells)));
    const row = Math.max(0, Math.min(cells - 1, Math.floor(((z + size / 2) / size) * cells)));
    return `${colLabel(col)}${row}`;
  }

  private syncLook() {
    const cp = Math.cos(this.pitch);
    this.look.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  private frame = (now: number) => {
    if (this.disposed) return;
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    if (this.waterMat) this.waterMat.uniforms.uTime.value = now / 1000;
    if (this.mode === "fly") {
      this.look.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? 2.4 : 1;
      const accel = (this.chart ? this.chart.size * 0.35 : 400) * sprint;
      const wish = this.wish;
      wish.set(0, 0, 0);
      if (this.keys.has("KeyW")) wish.add(this.look);
      if (this.keys.has("KeyS")) wish.sub(this.look);
      if (this.keys.has("KeyD")) wish.add(this.right);
      if (this.keys.has("KeyA")) wish.sub(this.right);
      if (this.keys.has("Space")) wish.y += 1;
      if (this.keys.has("ControlLeft") || this.keys.has("KeyC")) wish.y -= 1;
      if (wish.lengthSq() > 0) {
        wish.normalize().multiplyScalar(accel);
        this.velocity.lerp(wish, 1 - Math.exp(-6 * dt));
      } else {
        this.velocity.multiplyScalar(Math.exp(-4 * dt));
      }
      this.camera.position.addScaledVector(this.velocity, dt);
      this.speed = Math.hypot(this.velocity.x, this.velocity.z);
      this.camera.rotation.order = "YXZ";
      this.camera.rotation.y = this.yaw;
      this.camera.rotation.x = this.pitch;
    } else {
      this.controls.update();
      const euler = new THREE.Euler(0, 0, 0, "YXZ").setFromQuaternion(this.camera.quaternion);
      this.yaw = euler.y;
      this.speed = 0;
    }
    this.updateLabels();
    this.renderer.render(this.scene, this.camera);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.terrain || document.pointerLockElement) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.terrain)[0];
    if (!hit) {
      this.onProbe(null);
      return;
    }
    const { x, y, z } = hit.point;
    this.onProbe({
      east: x,
      north: -z,
      elevation: y,
      grid: this.gridAt(x, z),
    });
  };

  private onCanvasClick = () => {
    if (this.mode !== "fly") return;
    const canvas = this.renderer.domElement;
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
  };

  private onDoubleClick = (e: MouseEvent) => {
    if (!this.terrain || !this.chart) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.terrain)[0];
    if (!hit) return;
    this.controls.target.copy(hit.point);
  };

  private onMouseLook = (e: MouseEvent) => {
    if (this.mode !== "fly" || document.pointerLockElement !== this.renderer.domElement) return;
    this.yaw -= e.movementX * 0.0022;
    this.pitch -= e.movementY * 0.0022;
    this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch));
  };

  private onLockChange = () => {
    /* pointer lock is optional; WASD still flies */
  };

  private onKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (this.mode === "fly" && (e.code === "Space" || e.code.startsWith("Arrow"))) e.preventDefault();
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private clearKeys = () => {
    this.keys.clear();
  };
}
