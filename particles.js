// Lightweight particle FX for animation events: camera-facing additive sprites and weapon-trail ribbons.
// No external assets — sprite textures are generated on a canvas. Everything an effect creates is
// disposed when it finishes or when clear()/dispose() is called (version switches, model changes).
import * as THREE from 'three';

function glowTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Presets: Valve effect names (e.g. AXE_ATTACK_BLUR, PUDGE_DEATH_DUST) are mapped to one of these.
export const PRESETS = {
  trail: { kind: 'trail', life: 0.32, color: 0xff6a2a, width: 1 },
  crit: { kind: 'trail', life: 0.4, color: 0xffd040, width: 1.3, flash: true },
  sparks: { kind: 'burst', life: 0.55, count: 22, speed: 260, size: 14, gravity: -500, color: 0xffb050 },
  flash: { kind: 'burst', life: 0.25, count: 1, speed: 0, size: 140, grow: 1.8, color: 0xfff0c0 },
  dust: { kind: 'burst', life: 1.4, count: 18, speed: 70, size: 70, gravity: 40, grow: 2.2, color: 0x8a7a64, normal: true },
  blood: { kind: 'burst', life: 0.7, count: 26, speed: 220, size: 12, gravity: -600, color: 0xb01010, normal: true },
  spin: { kind: 'ring', life: 0.45, count: 28, radius: 150, size: 26, color: 0xff5a20 },
  magic: { kind: 'burst', life: 0.8, count: 30, speed: 140, size: 22, gravity: 60, color: 0x7ab8ff },
};

export function presetForEffect(name = '') {
  const n = name.toUpperCase();
  if (PRESETS[name]) return name;
  if (/CRIT/.test(n)) return 'crit';
  if (/COUNTERHELIX|HELIX|SPIN|WHIRL/.test(n)) return 'spin';
  if (/BLUR|TRAIL|SLASH|SWIPE|CLEAVE/.test(n)) return 'trail';
  if (/DUST|SMOKE/.test(n)) return 'dust';
  if (/BLOOD|DISMEMBER|GORE/.test(n)) return 'blood';
  if (/IMPACT|HIT|FLASH/.test(n)) return 'flash';
  if (/MAGIC|CAST|SPELL|FROST|LIGHTNING/.test(n)) return 'magic';
  return 'sparks';
}

export class ParticleSystem {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'particles';
    scene.add(this.group);
    this.live = [];
    this.tex = glowTexture();
  }

  // socket: an Object3D that follows the animated skeleton (or null for the model origin)
  spawn(presetName, socket, { follow = true, fallback = null } = {}) {
    const p = PRESETS[presetName] || PRESETS.sparks;
    const anchor = socket || fallback;
    if (!anchor) return;
    const origin = new THREE.Vector3();
    anchor.updateWorldMatrix(true, false);
    anchor.getWorldPosition(origin);
    if (p.kind === 'trail') this.live.push(this.makeTrail(p, anchor, follow));
    else if (p.kind === 'ring') this.live.push(this.makeRing(p, origin));
    else this.live.push(this.makeBurst(p, origin));
    if (p.flash) this.live.push(this.makeBurst(PRESETS.flash, origin));
  }

  material(color, normal = false) {
    return new THREE.SpriteMaterial({ map: this.tex, color, transparent: true, depthWrite: false,
      blending: normal ? THREE.NormalBlending : THREE.AdditiveBlending, fog: false });
  }

  makeBurst(p, origin) {
    const sprites = [];
    for (let i = 0; i < p.count; i++) {
      const s = new THREE.Sprite(this.material(p.color, p.normal));
      s.position.copy(origin);
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize();
      s.userData.v = dir.multiplyScalar(p.speed * (0.5 + Math.random() * 0.7));
      s.scale.setScalar(p.size);
      this.group.add(s);
      sprites.push(s);
    }
    return { p, age: 0, sprites, update: (fx, dt) => {
      const k = fx.age / p.life;
      for (const s of fx.sprites) {
        s.userData.v.y += (p.gravity || 0) * dt;
        s.position.addScaledVector(s.userData.v, dt);
        s.material.opacity = Math.max(0, 1 - k);
        s.scale.setScalar(p.size * (1 + (p.grow ? (p.grow - 1) * k : 0)));
      }
    } };
  }

  makeRing(p, origin) {
    const sprites = [];
    for (let i = 0; i < p.count; i++) {
      const s = new THREE.Sprite(this.material(p.color));
      s.userData.a = (i / p.count) * Math.PI * 2;
      s.scale.setScalar(p.size);
      this.group.add(s);
      sprites.push(s);
    }
    return { p, age: 0, sprites, origin: origin.clone(), update: (fx, dt) => {
      const k = fx.age / p.life;
      for (const s of fx.sprites) {
        const a = s.userData.a + k * Math.PI * 2.5;
        s.position.set(fx.origin.x + Math.cos(a) * p.radius * (0.4 + k), fx.origin.y + 40, fx.origin.z + Math.sin(a) * p.radius * (0.4 + k));
        s.material.opacity = Math.max(0, 1 - k);
      }
    } };
  }

  // A ribbon between the socket and its parent bone (hand → weapon tip), sampled every frame while
  // the effect lives, fading from the newest sample to the oldest — a weapon swing trail.
  makeTrail(p, anchor, follow) {
    const N = 20;
    const pos = new Float32Array(N * 2 * 3), col = new Float32Array(N * 2 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const idx = [];
    for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, fog: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    const samples = [];
    const base = new THREE.Color(p.color);
    return { p, age: 0, mesh, update: (fx, dt) => {
      const tip = new THREE.Vector3(), root = new THREE.Vector3();
      anchor.updateWorldMatrix(true, false);
      anchor.getWorldPosition(tip);
      // the blade direction: up the bone chain until a node is far enough away to define one
      // (sockets often sit exactly on their bone, e.g. Juggernaut's blade_attachment on sword_1)
      let node = anchor.parent;
      while (node) { node.getWorldPosition(root); if (root.distanceTo(tip) > 4) break; node = node.parent; }
      if (!node || root.distanceTo(tip) <= 4) root.copy(tip).add(new THREE.Vector3(0, -1, 0));
      const len = Math.max(40, Math.min(160, tip.distanceTo(root)));
      root.copy(tip).addScaledVector(root.sub(tip).normalize(), len * p.width);
      // sample only when the weapon actually moved (so pausing doesn't collapse the ribbon)
      const moved = !samples.length || samples[0][0].distanceTo(tip) > 0.5;
      if ((follow || !samples.length) && moved && dt > 0) samples.unshift([tip, root]);
      else if (!samples.length) samples.unshift([tip, root]);
      if (samples.length > N) samples.length = N;
      const fade = Math.max(0, 1 - fx.age / p.life);
      for (let i = 0; i < N; i++) {
        const s = samples[Math.min(i, samples.length - 1)];
        const w = samples.length > 1 ? (1 - i / (samples.length - 1)) * fade : 0;
        pos.set([s[0].x, s[0].y, s[0].z], i * 6); pos.set([s[1].x, s[1].y, s[1].z], i * 6 + 3);
        col.set([base.r * w, base.g * w, base.b * w], i * 6); col.set([base.r * w * 0.3, base.g * w * 0.3, base.b * w * 0.3], i * 6 + 3);
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    } };
  }

  update(dt) {
    for (const fx of this.live) { fx.age += dt; fx.update(fx, dt); }
    const dead = this.live.filter((fx) => fx.age >= fx.p.life);
    for (const fx of dead) this.disposeFx(fx);
    this.live = this.live.filter((fx) => fx.age < fx.p.life);
  }

  disposeFx(fx) {
    for (const s of fx.sprites || []) { this.group.remove(s); s.material.dispose(); }
    if (fx.mesh) { this.group.remove(fx.mesh); fx.mesh.geometry.dispose(); fx.mesh.material.dispose(); }
  }

  clear() {
    for (const fx of this.live) this.disposeFx(fx);
    this.live = [];
  }

  dispose() {
    this.clear();
    this.scene.remove(this.group);
    this.tex.dispose();
  }
}
