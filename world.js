// World view: renders a build's dota.bsp (terrain, trees, props, buildings) and finds spawn spots.
// Everything is built in Source space (Z-up, inches) inside a group; the caller rotates it to Y-up.
import * as THREE from 'three';
import { parseBSP, applyMultiblend, parseVMT, parseVTF, texturePath, buildModel, materialPaths } from './source.js?v=9';

const worlds = new Map(); // build -> Promise<world>

export function loadWorld(build, tryFile, onProgress = () => {}) {
  if (!worlds.has(build)) worlds.set(build, buildWorld(build, tryFile, onProgress));
  return worlds.get(build);
}

// ------------------------------------------------------------ textures & materials
function makeLoaders(build, tryFile) {
  const texCache = new Map();
  const texture = (path, { repeat = true } = {}) => {
    if (!path) return Promise.resolve(null);
    if (!texCache.has(path)) {
      texCache.set(path, (async () => {
        const buf = await tryFile(build, path);
        if (!buf) return null;
        try {
          const t = parseVTF(buf);
          const tex = new THREE.DataTexture(t.rgba, t.width, t.height, THREE.RGBAFormat);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
          tex.generateMipmaps = true;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.anisotropy = 8;
          tex.needsUpdate = true;
          return tex;
        } catch { return null; }
      })());
    }
    return texCache.get(path);
  };
  const vmt = async (path) => {
    const buf = await tryFile(build, path);
    return buf ? parseVMT(new TextDecoder().decode(buf)) : null;
  };
  return { texture, vmt };
}

const GREY = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
GREY.needsUpdate = true;

// Dota's MultiBlend terrain shader, approximated: four layers, each with its own scale and rotation,
// weighted by the per-vertex paint (normalised) and tinted by the per-vertex layer colour.
function multiBlendMaterial(layers) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  mat.onBeforeCompile = (shader) => {
    layers.forEach((l, i) => {
      shader.uniforms[`tex${i}`] = { value: l.tex || GREY };
      shader.uniforms[`xf${i}`] = { value: new THREE.Vector3(1 / (l.scale || 1), Math.cos(l.rot), Math.sin(l.rot)) };
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 tuv; attribute vec4 mb; attribute vec3 mbc0; attribute vec3 mbc1; attribute vec3 mbc2; attribute vec3 mbc3;
        varying vec2 vTuv; varying vec4 vMb; varying vec3 vC0; varying vec3 vC1; varying vec3 vC2; varying vec3 vC3;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTuv = tuv; vMb = mb; vC0 = mbc0; vC1 = mbc1; vC2 = mbc2; vC3 = mbc3;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tex0; uniform sampler2D tex1; uniform sampler2D tex2; uniform sampler2D tex3;
        uniform vec3 xf0; uniform vec3 xf1; uniform vec3 xf2; uniform vec3 xf3;
        varying vec2 vTuv; varying vec4 vMb; varying vec3 vC0; varying vec3 vC1; varying vec3 vC2; varying vec3 vC3;
        vec2 lay(vec3 xf) { vec2 u = vTuv * xf.x; return vec2(u.x * xf.y - u.y * xf.z, u.x * xf.z + u.y * xf.y); }`)
      .replace('#include <map_fragment>', `
        vec4 w = max(vMb, vec4(0.0));
        float s = w.x + w.y + w.z + w.w;
        w = s > 0.0001 ? w / s : vec4(1.0, 0.0, 0.0, 0.0);
        vec3 c = texture2D(tex0, lay(xf0)).rgb * vC0 * w.x + texture2D(tex1, lay(xf1)).rgb * vC1 * w.y
               + texture2D(tex2, lay(xf2)).rgb * vC2 * w.z + texture2D(tex3, lay(xf3)).rgb * vC3 * w.w;
        diffuseColor.rgb *= c;`);
  };
  mat.customProgramCacheKey = () => 'multiblend';
  return mat;
}

// ------------------------------------------------------------ model placement
// Rest-pose geometry in Source space. Some models come out Y-up (Maya exports: trees, towers,
// buildings), others Z-up; the MDL hull is always Z-up, so pick whichever matches it.
function restGeometry(model) {
  const bones = model.mdl.bones;
  const world = [];
  const m4 = (p, q) => new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion(...q), new THREE.Vector3(1, 1, 1));
  bones.forEach((b, i) => { world[i] = b.parent >= 0 ? world[b.parent].clone().multiply(m4(b.pos, b.quat)) : m4(b.pos, b.quat); });
  const skin = bones.map((b, i) => {
    const m = b.poseToBone;
    return world[i].clone().multiply(new THREE.Matrix4().set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1));
  });
  const v = new THREE.Vector3(), acc = new THREE.Vector3(), tmp = new THREE.Vector3();
  const box = new THREE.Box3();
  const meshes = model.meshes.map((m) => {
    const n = m.pos.length / 3, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      v.set(m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]);
      acc.set(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = m.weight[i * 4 + k];
        if (w) acc.addScaledVector(tmp.copy(v).applyMatrix4(skin[m.bone[i * 4 + k]] || skin[0]), w);
      }
      pos.set([acc.x, acc.y, acc.z], i * 3);
      box.expandByPoint(acc);
    }
    return { ...m, pos };
  });
  const size = box.getSize(new THREE.Vector3());
  const h = [0, 1, 2].map((k) => model.mdl.hullMax[k] - model.mdl.hullMin[k]);
  const errZ = Math.abs(size.x - h[0]) + Math.abs(size.y - h[1]) + Math.abs(size.z - h[2]);
  const errY = Math.abs(size.z - h[0]) + Math.abs(size.x - h[1]) + Math.abs(size.y - h[2]);
  const yUp = h[2] > 1 && errY < errZ;
  for (const m of meshes) {
    if (!yUp) continue;
    for (let i = 0; i < m.pos.length; i += 3) { // Source = (vz, vx, vy)
      const x = m.pos[i], y = m.pos[i + 1], z = m.pos[i + 2];
      m.pos[i] = z; m.pos[i + 1] = x; m.pos[i + 2] = y;
    }
  }
  return meshes;
}

function anglesMatrix(origin, angles, scale = 1) {
  // Source QAngle (pitch, yaw, roll) degrees: R = Rz(yaw) · Ry(pitch) · Rx(roll)
  const [p, y, r] = angles.map((a) => THREE.MathUtils.degToRad(a));
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r, p, y, 'ZYX'));
  return new THREE.Matrix4().compose(new THREE.Vector3(...origin), q, new THREE.Vector3(scale, scale, scale));
}

// ------------------------------------------------------------ world
async function buildWorld(build, tryFile, onProgress) {
  const { texture, vmt } = makeLoaders(build, tryFile);
  onProgress('reading the map…');
  const buf = await tryFile(build, 'maps/dota.bsp');
  if (!buf) throw new Error('this build has no maps/dota.bsp');
  const map = parseBSP(buf);
  applyMultiblend(map);

  const group = new THREE.Group();
  group.name = 'world';
  const terrain = new THREE.Group();
  group.add(terrain);

  // ---- terrain
  onProgress('loading terrain textures…');
  await Promise.all(map.groups.map(async (g) => {
    const m = await vmt(`materials/${g.material}.vmt`);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
    geo.setIndex(g.idx);
    geo.computeVertexNormals();
    let mat;
    const shader = (m?.shader || '').toLowerCase();
    if (shader === 'multiblend') {
      const nv = g.pos.length / 3;
      geo.setAttribute('tuv', new THREE.Float32BufferAttribute(g.uv, 2));
      geo.setAttribute('mb', new THREE.Float32BufferAttribute(g.mb || new Float32Array(nv * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
      const ib = new THREE.InterleavedBuffer(g.mbc || new Float32Array(nv * 12).fill(1), 12);
      for (let k = 0; k < 4; k++) geo.setAttribute(`mbc${k}`, new THREE.InterleavedBufferAttribute(ib, 3, k * 3));
      const suffix = ['', '2', '3', '4'];
      const layers = await Promise.all(suffix.map(async (s) => ({
        tex: await texture(texturePath(m.params[`$basetexture${s}`])),
        scale: parseFloat(m.params[`$scale${s}`] || '1') || 1,
        rot: THREE.MathUtils.degToRad(parseFloat(m.params[`$rotation${s}`] || '0') || 0),
      })));
      mat = multiBlendMaterial(layers);
    } else if (shader === 'water' || /water/.test(g.material)) {
      mat = new THREE.MeshLambertMaterial({ color: 0x2f5f6e, transparent: true, opacity: 0.78 });
    } else if (/black|map_edge/.test(g.material)) {
      mat = new THREE.MeshBasicMaterial({ color: 0x050607 });
    } else {
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
      const tex = m ? await texture(texturePath(m.params['$basetexture'])) : null;
      mat = new THREE.MeshLambertMaterial({ map: tex, color: tex ? 0xffffff : 0x6b6b5e });
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'terrain:' + g.material;
    mesh.receiveShadow = false;
    terrain.add(mesh);
  }));

  // ---- placements: static props, plus every entity that names a model (trees, towers, buildings…)
  const unitModels = {};
  try {
    const units = await fetch(`/api/units?build=${build}`).then((r) => r.json());
    for (const [model, u] of Object.entries(units)) unitModels[u.unit] = model;
  } catch { /* no unit table */ }
  const placements = new Map(); // model -> [Matrix4]
  const place = (model, origin, angles, scale) => {
    if (!model || !model.endsWith('.mdl')) return;
    model = model.toLowerCase().split('\\').join('/');
    if (!placements.has(model)) placements.set(model, []);
    placements.get(model).push(anglesMatrix(origin, angles, scale));
  };
  for (const p of map.props) place(p.model, p.origin, p.angles, 1);
  const vec = (s) => (s || '0 0 0').split(/\s+/).map(Number);
  for (const e of map.entities) {
    if (!e.origin || /^(info_|trigger_|path_|env_|light|point_|func_|ambient_|logic_)/.test(e.classname || '')) continue;
    const model = e.model?.endsWith('.mdl') ? e.model : unitModels[e.MapUnitName];
    place(model, vec(e.origin), vec(e.angles), parseFloat(e.modelscale || e.scale || '1') || 1);
  }

  const props = new THREE.Group();
  props.name = 'props';
  group.add(props);
  const models = [...placements.keys()];
  let done = 0, failed = 0;
  const queue = [...models];
  const worker = async () => {
    while (queue.length) {
      const path = queue.shift();
      try {
        const base = path.replace(/\.mdl$/, '');
        const [a, v, x] = await Promise.all([tryFile(build, path), tryFile(build, base + '.vvd'),
          tryFile(build, base + '.dx90.vtx').then((b) => b || tryFile(build, base + '.vtx'))]);
        if (!a || !v || !x) throw new Error('missing');
        const model = buildModel(a, v, x);
        const meshes = restGeometry(model);
        const mats = await Promise.all(meshes.map(async (m) => {
          for (const vp of materialPaths(model.mdl, m.material)) {
            const mm = await vmt(vp);
            if (!mm) continue;
            const on = (k) => k in mm.params && mm.params[k] !== '0';
            if (/^(tools|nodraw)/i.test(mm.params['$basetexture'] || '')) return null; // invisible helper geometry
            const tex = await texture(texturePath(mm.params['$basetexture']));
            // Source blend modes: $additive = glow cards, $translucent = soft see-through, $alphatest = cut-out
            const additive = on('$additive'), translucent = additive || on('$translucent');
            if (additive) {
              // glow cards, vapours, light shafts: unlit, added on top, and never fogged (fog would add
              // the fog colour itself and turn faint wisps into bright squares)
              if (!tex) return null;
              return new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, depthWrite: false,
                blending: THREE.AdditiveBlending, fog: false });
            }
            return new THREE.MeshLambertMaterial({
              map: tex, color: tex ? 0xffffff : 0x8a8a80, side: THREE.DoubleSide,
              alphaTest: on('$alphatest') ? 0.5 : 0, transparent: translucent, depthWrite: !translucent,
            });
          }
          return new THREE.MeshLambertMaterial({ color: 0x8a8a80 });
        }));
        const matrices = placements.get(path);
        meshes.forEach((m, i) => {
          if (!mats[i]) return;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3));
          geo.setAttribute('uv', new THREE.Float32BufferAttribute(m.uv, 2));
          geo.setIndex(new THREE.BufferAttribute(m.idx, 1));
          geo.computeVertexNormals();
          const inst = new THREE.InstancedMesh(geo, mats[i], matrices.length);
          matrices.forEach((mx, k) => inst.setMatrixAt(k, mx));
          inst.name = path;
          inst.computeBoundingSphere();
          props.add(inst);
        });
      } catch { failed++; }
      done++;
      if (done % 10 === 0 || done === models.length) onProgress(`placing models ${done}/${models.length}${failed ? ` (${failed} missing)` : ''}`);
    }
  };

  // ---- spawn spots
  const ents = (cls) => map.entities.filter((e) => e.classname === cls);
  const avg = (es) => [0, 1, 2].map((k) => es.reduce((s, e) => s + vec(e.origin)[k], 0) / Math.max(1, es.length));
  const fountains = ents('ent_dota_fountain');
  const radiant = avg(ents('info_player_start_goodguys'));
  const dire = avg(ents('info_player_start_badguys'));
  const fr = fountains.find((f) => /good/.test(f.targetname || '')) || fountains.sort((a, b) => vec(a.origin)[0] - vec(b.origin)[0])[0];
  const fd = fountains.find((f) => /bad/.test(f.targetname || '')) || fountains.sort((a, b) => vec(b.origin)[0] - vec(a.origin)[0])[0];
  const mid = fr && fd ? [0, 1].map((k) => (vec(fr.origin)[k] + vec(fd.origin)[k]) / 2) : [0, 0];
  // ground height under a point: cast a ray down onto the terrain
  const ray = new THREE.Raycaster();
  const groundZ = (x, y, fallback = 0) => {
    terrain.updateMatrixWorld(true);
    ray.set(new THREE.Vector3(x, y, 20000), new THREE.Vector3(0, 0, -1));
    const hit = ray.intersectObjects(terrain.children.filter((m) => !/water/.test(m.name)), false)[0];
    return hit ? hit.point.z : fallback;
  };
  const yawTo = (from, to) => THREE.MathUtils.radToDeg(Math.atan2(to[1] - from[1], to[0] - from[0]));
  const spots = {
    radiant: { pos: [radiant[0], radiant[1], groundZ(radiant[0], radiant[1], radiant[2])], yaw: yawTo(radiant, [0, 0]), label: 'Radiant spawn' },
    dire: { pos: [dire[0], dire[1], groundZ(dire[0], dire[1], dire[2])], yaw: yawTo(dire, [0, 0]), label: 'Dire spawn' },
    mid: { pos: [mid[0], mid[1], groundZ(mid[0], mid[1], 0)], yaw: yawTo(mid, dire), label: 'Mid lane, river' },
  };

  const world = {
    build, group, spots,
    stats: { ...map.stats, props: map.props.length, models: models.length, trees: ents('ent_dota_tree').length },
    ready: null,
  };
  // models stream in after the world is returned, so terrain shows immediately
  world.ready = Promise.all(Array.from({ length: 6 }, worker)).then(() => onProgress(`done — ${models.length - failed} models`));
  return world;
}
