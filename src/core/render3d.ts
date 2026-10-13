// Modello 3D della casa con Three.js: muri estrusi, pavimenti per stanza, luci legate alle entità HA.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FloorPlan, StateMap, entityDomain, isActive } from './model';
import { FloorPattern, Skin, roomColor } from './skins';

export interface Scene3DOptions {
  onEntityClick?: (entityId: string) => void;
}

export class FloorScene3D {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  private controls: OrbitControls;
  private root = new THREE.Group();
  private ambient = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  private sun = new THREE.DirectionalLight(0xffffff, 0.6);
  private lights = new Map<string, { light: THREE.PointLight; bulb: THREE.Mesh }>();
  private markers = new Map<string, THREE.Mesh>();
  private roomDims = new Map<string, THREE.Mesh>();
  private plan?: FloorPlan;
  private skin?: Skin;
  private states: StateMap = {};
  private resizeObs: ResizeObserver;
  private frame = 0;

  constructor(private container: HTMLElement, private opts: Scene3DOptions = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2.05;
    this.controls.addEventListener('change', () => this.requestRender());
    this.sun.position.set(10, 20, 8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.scene.add(this.ambient, this.sun, this.root);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.renderer.domElement.addEventListener('click', (ev) => this.pick(ev));
    this.resize();
  }

  setPlan(plan: FloorPlan, skin: Skin, resetCamera = true) {
    this.plan = plan;
    this.skin = skin;
    this.build();
    if (resetCamera) this.frameCamera();
    this.applyStates();
  }

  setSkin(skin: Skin) {
    if (!this.plan) return;
    this.setPlan(this.plan, skin, false);
  }

  setStates(states: StateMap) {
    this.states = states;
    this.applyStates();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private clear() {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          (m as THREE.MeshStandardMaterial).map?.dispose();
          m.dispose();
        }
      }
    });
    this.root.clear();
    this.lights.clear();
    this.markers.clear();
    this.roomDims.clear();
  }

  private toWorld(x: number, y: number): THREE.Vector3 {
    const p = this.plan!;
    return new THREE.Vector3((x - p.width / 2) / p.scale, 0, (y - p.height / 2) / p.scale);
  }

  private build() {
    this.clear();
    const plan = this.plan!;
    const skin = this.skin!;
    this.scene.background = new THREE.Color(skin.background);
    this.ambient.intensity = skin.ambient * 1.4;
    this.sun.intensity = skin.ambient * 1.2;
    const H = plan.wallHeight;

    // terreno
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(plan.width / plan.scale + 6, plan.height / plan.scale + 6),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(skin.background).multiplyScalar(0.92), roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.receiveShadow = true;
    this.root.add(ground);

    const floorTex = makeFloorTexture(skin.floorPattern);
    plan.rooms.forEach((room, i) => {
      const shape = new THREE.Shape(room.polygon.map((p) => {
        const w = this.toWorld(p.x, p.y);
        return new THREE.Vector2(w.x, -w.z);
      }));
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshStandardMaterial({ color: roomColor(skin, i), roughness: 0.85 });
      if (floorTex) {
        const t = floorTex.clone();
        t.needsUpdate = true;
        mat.map = t;
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      this.root.add(mesh);

      // velo scuro per le stanze con luci spente
      const dim = new THREE.Mesh(
        geo.clone().translate(0, 0.005, 0),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false }),
      );
      this.roomDims.set(room.id, dim);
      this.root.add(dim);

      for (const e of room.entities) {
        const pos = this.toWorld(e.position.x, e.position.y);
        if (entityDomain(e.entity_id) === 'light') {
          const light = new THREE.PointLight(skin.glow, 0, 6, 1.5);
          light.position.set(pos.x, H - 0.3, pos.z);
          const bulb = new THREE.Mesh(
            new THREE.SphereGeometry(0.12, 16, 12),
            new THREE.MeshStandardMaterial({ color: skin.entityOff, emissive: skin.glow, emissiveIntensity: 0 }),
          );
          bulb.position.copy(light.position);
          bulb.userData.entityId = e.entity_id;
          this.root.add(light, bulb);
          this.lights.set(e.entity_id, { light, bulb });
        } else {
          const m = new THREE.Mesh(
            new THREE.CylinderGeometry(0.15, 0.15, 0.08, 20),
            new THREE.MeshStandardMaterial({ color: skin.entityOff, emissive: skin.entityOn, emissiveIntensity: 0 }),
          );
          m.position.set(pos.x, 1.2, pos.z);
          m.userData.entityId = e.entity_id;
          this.root.add(m);
          this.markers.set(e.entity_id, m);
        }
      }
    });

    const wallMat = new THREE.MeshStandardMaterial({
      color: skin.wall,
      roughness: 0.9,
      transparent: skin.wallOpacity < 1,
      opacity: skin.wallOpacity,
    });
    const topMat = new THREE.MeshStandardMaterial({ color: skin.wallTop, roughness: 0.9 });
    for (const w of plan.walls) {
      const a = this.toWorld(w.a.x, w.a.y);
      const b = this.toWorld(w.b.x, w.b.y);
      const len = a.distanceTo(b);
      const t = w.thickness / plan.scale;
      const axisAligned = w.a.x === w.b.x || w.a.y === w.b.y;
      // gli estremi di muri assiali sono già "pieni" nell'immagine; i muri obliqui si allungano di t per chiudere gli angoli
      const geo = new THREE.BoxGeometry(len + (axisAligned ? 0 : t), H, t);
      // facce: +x -x +y -y +z -z → la superiore (+y) prende il colore di "cappello"
      const mesh = new THREE.Mesh(geo, [wallMat, wallMat, topMat, wallMat, wallMat, wallMat]);
      mesh.position.set((a.x + b.x) / 2, H / 2, (a.z + b.z) / 2);
      mesh.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }

    const span = Math.max(plan.width, plan.height) / plan.scale;
    const cam = this.sun.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -span;
    cam.right = cam.top = span;
    cam.updateProjectionMatrix();
    this.requestRender();
  }

  private applyStates() {
    if (!this.plan || !this.skin) return;
    const skin = this.skin;
    for (const [id, { light, bulb }] of this.lights) {
      const st = this.states[id];
      const on = isActive(st);
      const bri = typeof st?.attributes.brightness === 'number' ? (st.attributes.brightness as number) / 255 : 1;
      light.intensity = on ? 6 * bri : 0;
      const rgb = st?.attributes.rgb_color as number[] | undefined;
      light.color.set(rgb ? new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255) : new THREE.Color(skin.glow));
      const m = bulb.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = on ? 2 : 0;
      m.color.set(on ? skin.entityOn : skin.entityOff);
    }
    for (const [id, mesh] of this.markers) {
      const on = isActive(this.states[id]);
      const m = mesh.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = on ? 1 : 0;
      m.color.set(on ? skin.entityOn : skin.entityOff);
    }
    for (const room of this.plan.rooms) {
      const lightsIds = room.entities.filter((e) => entityDomain(e.entity_id) === 'light').map((e) => e.entity_id);
      const anyOn = lightsIds.some((id) => isActive(this.states[id]));
      const dim = this.roomDims.get(room.id);
      if (dim) (dim.material as THREE.MeshBasicMaterial).opacity = lightsIds.length && !anyOn ? skin.dimOff * 0.6 : 0;
    }
    this.requestRender();
  }

  private frameCamera() {
    const p = this.plan!;
    const span = Math.max(p.width, p.height) / p.scale;
    this.camera.position.set(0, span * 0.9, span * 0.75);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.requestRender();
  }

  private resize() {
    const w = this.container.clientWidth || 300;
    const h = this.container.clientHeight || 300;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  private pick(ev: MouseEvent) {
    if (!this.opts.onEntityClick) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const targets = [...[...this.lights.values()].map((l) => l.bulb), ...this.markers.values()];
    const hit = ray.intersectObjects(targets)[0];
    if (hit) this.opts.onEntityClick(hit.object.userData.entityId as string);
  }

  private needsRender = false;
  requestRender() {
    if (this.needsRender) return;
    this.needsRender = true;
    this.frame = requestAnimationFrame(() => {
      this.needsRender = false;
      // il damping richiede qualche frame in più finché la camera si assesta
      if (this.controls.update()) this.requestRender();
      this.renderer.render(this.scene, this.camera);
    });
  }
}

function makeFloorTexture(pattern: FloorPattern): THREE.CanvasTexture | null {
  if (pattern === 'plain' || typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(0,0,0,0.18)';
  g.lineWidth = 2;
  if (pattern === 'wood') {
    for (let y = 0; y < 256; y += 32) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(256, y);
      g.stroke();
      const off = (y / 32) % 2 ? 64 : 0;
      for (let x = off; x < 256; x += 128) {
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x, y + 32);
        g.stroke();
      }
      for (let k = 0; k < 6; k++) {
        g.fillStyle = `rgba(0,0,0,${0.02 + Math.random() * 0.04})`;
        g.fillRect(Math.random() * 256, y + 4 + Math.random() * 24, 40 + Math.random() * 60, 1.5);
      }
    }
  } else {
    const step = pattern === 'tiles' ? 64 : 32;
    for (let i = 0; i <= 256; i += step) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i, 256);
      g.moveTo(0, i);
      g.lineTo(256, i);
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  // ShapeGeometry usa coordinate in metri come UV: 1 ripetizione ogni 2 m
  tex.repeat.set(0.5, 0.5);
  return tex;
}
