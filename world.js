// World view: renders a build's dota.bsp (terrain, trees, props, buildings) and finds spawn spots.
// Everything is built in Source space (Z-up, inches) inside a group; the caller rotates it to Y-up.
import * as THREE from 'three';
import { parseBSP, applyMultiblend, parseVMT, parseVTF, texturePath, buildModel, materialPaths, decodeSequence } from './source.js?v=9';

const worlds = new Map(); // build -> Promise<world>, in least-recently-used order

export function loadWorld(build, tryFile, onProgress = () => {}) {
  if (!worlds.has(build)) worlds.set(build, buildWorld(build, tryFile, onProgress));
  const w = worlds.get(build);
  worlds.delete(build); worlds.set(build, w); // mark as most recently used
  return w;
}

// Keep at most `keep` maps that no view is showing; free the GPU resources of older ones.
// (A map is ~140k terrain triangles, a few hundred models and their textures.)
export async function trimWorlds(inUse, keep = 3) {
  const idle = [...worlds.keys()].filter((b) => !inUse.has(b));
  for (const build of idle.slice(0, Math.max(0, idle.length - keep))) {
    const w = await worlds.get(build);
    worlds.delete(build);
    const textures = new Set();
    w.group.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material || [])) {
        for (const k of ['map', 'emissiveMap']) if (m[k]) textures.add(m[k]);
        for (const t of m.userData.layerTex || []) textures.add(t);
        m.dispose();
      }
    });
    for (const t of textures) t.dispose();
    w.clouds?.tex.value?.dispose?.();
  }
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
  // Dota's GlobalLitSimple keeps the see-through mask of translucent cards (glows, light rays, vapours,
  // water edges) in the alpha of $specTexture; the base texture is opaque DXT1. Combine the two.
  const masked = (basePath, specPath) => {
    const key = basePath + '|' + specPath;
    if (!texCache.has(key)) {
      texCache.set(key, (async () => {
        const [base, spec] = await Promise.all([texture(basePath), texture(specPath)]);
        if (!base || !spec) return base;
        const bi = base.image, si = spec.image, out = new Uint8Array(bi.data);
        for (let y = 0; y < bi.height; y++) {
          const sy = Math.floor((y * si.height) / bi.height);
          for (let x = 0; x < bi.width; x++) {
            const sx = Math.floor((x * si.width) / bi.width);
            out[(y * bi.width + x) * 4 + 3] = si.data[(sy * si.width + sx) * 4 + 3];
          }
        }
        const tex = new THREE.DataTexture(out, bi.width, bi.height, THREE.RGBAFormat);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.needsUpdate = true;
        return tex;
      })());
    }
    return texCache.get(key);
  };
  const vmt = async (path) => {
    const buf = await tryFile(build, path);
    return buf ? parseVMT(new TextDecoder().decode(buf)) : null;
  };
  return { texture, masked, vmt };
}

const GREY = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
GREY.needsUpdate = true;

// Dota's MultiBlend terrain shader, approximated: four layers, each with its own scale and rotation,
// weighted by the per-vertex paint (normalised) and tinted by the per-vertex layer colour. `clouds`
// holds shared uniforms for env_global_light's scrolling cloud shadows (texture, two layer offsets).
// shared by every terrain material: 1 = per-vertex layer tints on (as stored in the map), 0 = off
const TINTS = { value: 1 };
export function setTerrainTints(on) { TINTS.value = on ? 1 : 0; }

function multiBlendMaterial(layers, clouds) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  mat.onBeforeCompile = (shader) => {
    layers.forEach((l, i) => {
      shader.uniforms[`tex${i}`] = { value: l.tex || GREY };
      shader.uniforms[`xf${i}`] = { value: new THREE.Vector3(1 / (l.scale || 1), Math.cos(l.rot), Math.sin(l.rot)) };
    });
    shader.uniforms.tintMix = TINTS;
    shader.uniforms.cloudTex = clouds.tex;
    shader.uniforms.cloudOfs = clouds.ofs;
    shader.uniforms.cloudParams = clouds.params;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 tuv; attribute vec4 mb; attribute vec3 mbc0; attribute vec3 mbc1; attribute vec3 mbc2; attribute vec3 mbc3;
        varying vec2 vTuv; varying vec4 vMb; varying vec3 vC0; varying vec3 vC1; varying vec3 vC2; varying vec3 vC3; varying vec2 vSrc;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTuv = tuv; vMb = mb; vC0 = mbc0; vC1 = mbc1; vC2 = mbc2; vC3 = mbc3; vSrc = position.xy;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tex0; uniform sampler2D tex1; uniform sampler2D tex2; uniform sampler2D tex3;
        uniform vec3 xf0; uniform vec3 xf1; uniform vec3 xf2; uniform vec3 xf3;
        uniform sampler2D cloudTex; uniform vec4 cloudOfs; uniform vec2 cloudParams; uniform float tintMix;
        varying vec2 vTuv; varying vec4 vMb; varying vec3 vC0; varying vec3 vC1; varying vec3 vC2; varying vec3 vC3; varying vec2 vSrc;
        vec2 lay(vec3 xf) { vec2 u = vTuv * xf.x; return vec2(u.x * xf.y - u.y * xf.z, u.x * xf.z + u.y * xf.y); }`)
      .replace('#include <map_fragment>', `
        // Valve's multiblend (Alien Swarm branch, multiblend_ps2x.fxc): layers take their share in priority
        // order — each layer's vertex value is compared against its texture alpha (a height mask) and
        // capped by what earlier layers left; layer 4 gets the remainder (its vertex value is unused)
        vec4 t0 = texture2D(tex0, lay(xf0)), t1 = texture2D(tex1, lay(xf1)), t2 = texture2D(tex2, lay(xf2)), t3 = texture2D(tex3, lay(xf3));
        float rem = 1.0;
        float b1 = min(smoothstep(0.0, max(t0.a, 0.001), vMb.x), rem); rem -= b1;
        float b2 = min(smoothstep(0.0, max(t1.a, 0.001), vMb.y), rem); rem -= b2;
        float b3 = min(smoothstep(0.0, max(t2.a, 0.001), vMb.z), rem); rem -= b3;
        vec3 c = t0.rgb * mix(vec3(1.0), vC0, tintMix) * b1 + t1.rgb * mix(vec3(1.0), vC1, tintMix) * b2
               + t2.rgb * mix(vec3(1.0), vC2, tintMix) * b3 + t3.rgb * mix(vec3(1.0), vC3, tintMix) * rem;
        // two cloud layers drifting over the ground, darkening it a little where they overlap
        float cl = texture2D(cloudTex, vSrc / cloudParams.x + cloudOfs.xy).r * texture2D(cloudTex, vSrc / (cloudParams.x * 0.7) + cloudOfs.zw).r;
        c *= mix(1.0, 0.55 + 0.45 * cl, cloudParams.y);
        diffuseColor.rgb *= c;`);
  };
  mat.customProgramCacheKey = () => 'multiblend4';
  mat.userData.layerTex = layers.map((l) => l.tex).filter(Boolean); // so trimWorlds can free them
  return mat;
}

// ------------------------------------------------------------ lighting
const rgb = (s, scale = 1) => {
  const p = String(s || '').split(/[\s,]+/).map(Number);
  return new THREE.Color(((p[0] || 0) / 255) * scale, ((p[1] || 0) / 255) * scale, ((p[2] || 0) / 255) * scale);
};
// Source angles "pitch yaw roll" -> unit vector the light travels along (Z-up)
const lightDir = (s) => {
  const [p, y] = String(s || '45 0 0').split(/\s+/).map((v) => THREE.MathUtils.degToRad(+v || 0));
  return new THREE.Vector3(Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p));
};

function readLighting(entities, vec) {
  const g = entities.find((e) => e.classname === 'env_global_light') || {};
  const global = {
    color: rgb(g.color || '105 101 86', 2.2), dir: lightDir(g.angles || '50 0 0'),
    ambient: rgb(g.ambientcolor1 || '49 112 157', 1.4), ambient2: rgb(g.ambientcolor2 || '90 129 150', 1.2),
    clouds: { tex: g.texturename || null, scale: parseFloat(g.cloudscale || '6500'),
      l1: { speed: parseFloat(g.cloud1speed || '0'), dir: THREE.MathUtils.degToRad(vec(g.cloud1direction)[1]) },
      l2: { speed: parseFloat(g.cloud2speed || '0'), dir: THREE.MathUtils.degToRad(vec(g.cloud2direction)[1]) } },
  };
  // ent_dota_lightinfo: per-zone day / dusk / night / dawn lighting and fog
  const infos = entities.filter((e) => e.classname === 'ent_dota_lightinfo').map((e) => {
    const tod = {};
    for (const t of ['day', 'dusk', 'night', 'dawn']) {
      tod[t] = {
        color: rgb(e[`color_${t}`], 2.4), dir: lightDir(e[`light_direction_${t}`]),
        ambient: rgb(e[`ambient_color_${t}`], 1.2 + 1.2 * (parseFloat(e[`ambient_scale_${t}`]) || 0.35)),
        fog: { color: rgb(e[`fog_color_${t}`]), start: parseFloat(e[`fog_start_${t}`] || '1500'), end: parseFloat(e[`fog_end_${t}`] || '5500') },
      };
    }
    return { name: e.targetname || '', origin: vec(e.origin), inner: parseFloat(e.inner_radius || '1000'), outer: parseFloat(e.outer_radius || '3000'), tod };
  });
  // local lights: braziers, crystals, fountains
  const points = entities.filter((e) => /^env_deferred(_spot)?_light$/.test(e.classname || '')).map((e) => {
    const c = String(e.lightcolor || '255 255 255 200').split(/\s+/).map(Number);
    return { origin: vec(e.origin), color: rgb(e.lightcolor), intensity: (parseFloat(e.intensity || '1') || 1) * ((c[3] ?? 200) / 255),
      radius: parseFloat(e.radius || e.spot_light_distance || '512') };
  });
  // pick the lighting at a point for a time of day: the nearest zone, blended out between inner and outer radius
  const at = (p, todName = 'day') => {
    let best = null, bestW = 0;
    for (const z of infos) {
      const d = Math.hypot(z.origin[0] - p[0], z.origin[1] - p[1]);
      const w = d <= z.inner ? 1 : d >= z.outer ? 0 : 1 - (d - z.inner) / (z.outer - z.inner);
      if (w > bestW) { bestW = w; best = z; }
    }
    const base = { color: global.color.clone(), dir: global.dir.clone(), ambient: global.ambient.clone(),
      fog: { color: new THREE.Color(150 / 255, 200 / 255, 225 / 255), start: 1500, end: 5500 } };
    if (todName === 'night' && !best) { base.color.multiplyScalar(0.35); base.ambient.multiplyScalar(0.5); base.fog.color.multiplyScalar(0.35); }
    if (!best) return { ...base, zone: null };
    const z = best.tod[todName] || best.tod.day;
    return {
      color: base.color.lerp(z.color, bestW), dir: base.dir.lerp(z.dir, bestW).normalize(), ambient: base.ambient.lerp(z.ambient, bestW),
      fog: { color: base.fog.color.lerp(z.fog.color, bestW), start: z.fog.start, end: z.fog.end }, zone: best.name,
    };
  };
  return { global, infos, points, at };
}

// ------------------------------------------------------------ model placement
// Rest-pose geometry in Source space. Some models come out Y-up (Maya exports: trees, towers,
// buildings), others Z-up; the MDL hull is always Z-up, so pick whichever matches it.
// Multi-bone props with animations (fish, birds, flags) only look right in an animated pose; their
// rest pose can sit far from the origin. Use frame 0 of their first looping, non-delta sequence.
function posedBones(model) {
  const bones = model.mdl.bones;
  const rest = { pos: bones.map((b) => b.pos), quat: bones.map((b) => b.quat) };
  if (bones.length < 2) return rest;
  const si = model.mdl.seqs.findIndex((s) => s.looping && !(s.flags & 0x4) && s.name !== 'BindPose');
  if (si < 0) return rest;
  try {
    const f = decodeSequence(model.mdl, si).frames[0];
    return { pos: bones.map((_, i) => Array.from(f.pos.slice(i * 3, i * 3 + 3))), quat: bones.map((_, i) => Array.from(f.quat.slice(i * 4, i * 4 + 4))) };
  } catch { return rest; }
}

function restGeometry(model) {
  const bones = model.mdl.bones;
  const world = [];
  const pose = posedBones(model);
  const m4 = (p, q) => new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion(...q), new THREE.Vector3(1, 1, 1));
  bones.forEach((b, i) => { const l = m4(pose.pos[i], pose.quat[i]); world[i] = b.parent >= 0 ? world[b.parent].clone().multiply(l) : l; });
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

// Dota's GlobalLitSimple $ALPHA_ANGLE_POWER: a card fades as it turns edge-on to the camera
// (alpha *= |N·V|^power), so light rays and glows vanish instead of showing as flat slivers.
function angleFade(mat, power) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.fadePower = { value: power };
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', 'varying float vAngleFade;\nvoid main() {')
      .replace('#include <project_vertex>', `#include <project_vertex>
        mat3 nm = normalMatrix;
        #ifdef USE_INSTANCING
          nm = nm * mat3(instanceMatrix);
        #endif
        vAngleFade = abs(dot(normalize(nm * normal), normalize(-mvPosition.xyz)));`);
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'uniform float fadePower;\nvarying float vAngleFade;\nvoid main() {')
      .replace(/#include <(opaque|output)_fragment>/, (m) => `diffuseColor.a *= pow(vAngleFade, fadePower);\n${m}`);
  };
  mat.customProgramCacheKey = () => 'angleFade';
}

function anglesMatrix(origin, angles, scale = 1) {
  // Source QAngle (pitch, yaw, roll) degrees: R = Rz(yaw) · Ry(pitch) · Rx(roll)
  const [p, y, r] = angles.map((a) => THREE.MathUtils.degToRad(a));
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r, p, y, 'ZYX'));
  return new THREE.Matrix4().compose(new THREE.Vector3(...origin), q, new THREE.Vector3(scale, scale, scale));
}

// ------------------------------------------------------------ world
async function buildWorld(build, tryFile, onProgress) {
  const { texture, masked, vmt } = makeLoaders(build, tryFile);
  onProgress('reading the map…');
  const buf = await tryFile(build, 'maps/dota.bsp');
  if (!buf) throw new Error('this build has no maps/dota.bsp');
  const map = parseBSP(buf);
  applyMultiblend(map);
  const vec = (s) => (s || '0 0 0').split(/\s+/).map(Number);
  const lighting = readLighting(map.entities, vec);

  const group = new THREE.Group();
  group.name = 'world';
  const terrain = new THREE.Group();
  group.add(terrain);

  // shared cloud-shadow uniforms, advanced by world.tick()
  const lc = lighting.global.clouds;
  const clouds = {
    tex: { value: (lc.tex && await texture(texturePath(lc.tex))) || GREY },
    ofs: { value: new THREE.Vector4() },
    params: { value: new THREE.Vector2(lc.scale || 6500, lc.tex ? 1 : 0) },
    time: 0,
  };

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
      mat = multiBlendMaterial(layers, clouds);
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
    if (/camera|endcam/.test(model)) return; // cinematic camera rigs, not scenery
    if (!placements.has(model)) placements.set(model, []);
    placements.get(model).push(anglesMatrix(origin, angles, scale));
  };
  for (const p of map.props) place(p.model, p.origin, p.angles, 1);
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
            const glsSpec = /globallitsimple/i.test(mm.shader || '') && on('$translucent') && mm.params['$spectexture'];
            const tex = glsSpec
              ? await masked(texturePath(mm.params['$basetexture']), texturePath(mm.params['$spectexture']))
              : await texture(texturePath(mm.params['$basetexture']));
            // Source blend modes: $additive = glow cards, $translucent = soft see-through, $alphatest = cut-out
            const additive = on('$additive'), translucent = additive || on('$translucent');
            if (additive) {
              // glow cards, vapours, light shafts: unlit, added on top, and never fogged (fog would add
              // the fog colour itself and turn faint wisps into bright squares)
              if (!tex) return null;
              const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, depthWrite: false,
                blending: THREE.AdditiveBlending, fog: false });
              const power = parseFloat(mm.params['$alpha_angle_power']);
              if (power > 0) angleFade(mat, power);
              return mat;
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
  const rosh = ents('npc_dota_roshan_spawner')[0];
  const roshan = rosh ? (() => { const p = vec(rosh.origin); return [p[0], p[1], groundZ(p[0], p[1], p[2])]; })() : null;
  const spots = {
    radiant: { pos: [radiant[0], radiant[1], groundZ(radiant[0], radiant[1], radiant[2])], yaw: yawTo(radiant, [0, 0]), label: 'Radiant spawn' },
    dire: { pos: [dire[0], dire[1], groundZ(dire[0], dire[1], dire[2])], yaw: yawTo(dire, [0, 0]), label: 'Dire spawn' },
    mid: { pos: [mid[0], mid[1], groundZ(mid[0], mid[1], 0)], yaw: yawTo(mid, dire), label: 'Mid lane, river' },
  };
  if (roshan) {
    // stand a few hundred units from the pit, facing it
    const a = Math.atan2(-roshan[1], -roshan[0]);
    const x = roshan[0] + Math.cos(a) * 420, y = roshan[1] + Math.sin(a) * 420;
    spots.roshan = { pos: [x, y, groundZ(x, y, roshan[2])], yaw: yawTo([x, y], roshan), label: "Roshan's pit" };
  }

  // creep lanes: path_corner chains lane_<top|mid|bot>_pathcorner_<goodguys|badguys>_1 -> target -> …
  // Several 2011 maps (2011-01-25 … 2011-09-10) have two path_corners with the same name at the end of
  // each Radiant lane: one at the Dire base and a stray copy back in the Radiant base. Keep every
  // copy and follow the one that continues forward.
  const corners = new Map();
  for (const e of map.entities) if (e.classname === 'path_corner' && e.targetname) {
    if (!corners.has(e.targetname)) corners.set(e.targetname, []);
    corners.get(e.targetname).push(e);
  }
  const lanes = {};
  const forward = (cands, pts) => {
    if (!cands?.length) return null;
    if (cands.length === 1 || pts.length < 2) return cands[0];
    const [b, a] = [pts[pts.length - 2], pts[pts.length - 1]];
    const dir = (e) => { const p = vec(e.origin), bx = p[0] - a[0], by = p[1] - a[1];
      return ((a[0] - b[0]) * bx + (a[1] - b[1]) * by) / ((Math.hypot(a[0] - b[0], a[1] - b[1]) * Math.hypot(bx, by)) || 1); };
    return cands.reduce((best, e) => (dir(e) > dir(best) ? e : best));
  };
  for (const lane of ['top', 'mid', 'bot']) for (const side of ['goodguys', 'badguys']) {
    const pts = [];
    let e = corners.get(`lane_${lane}_pathcorner_${side}_1`)?.[0];
    const seen = new Set();
    while (e && !seen.has(e)) {
      const p = vec(e.origin), prev = pts[pts.length - 1];
      // still guard against a waypoint that jumps far back the way the lane came (long straight runs
      // are fine: January 2011's side lanes are just three ~9000-unit legs)
      const back = pts[pts.length - 2];
      if (prev && back && Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 4000) {
        const ax = prev[0] - back[0], ay = prev[1] - back[1], bx = p[0] - prev[0], by = p[1] - prev[1];
        if ((ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1) < -0.3) break;
      }
      seen.add(e); pts.push(p);
      // a waypoint that targets its own name is the end of the lane (it would land on the stray copy)
      e = e.target === e.targetname ? null : forward(corners.get(e.target)?.filter((c) => !seen.has(c)), pts);
    }
    if (pts.length > 1) {
      // start at the team's spawn so the walk begins in base
      pts.unshift(side === 'goodguys' ? [...radiant] : [...dire]);
      lanes[`${lane}_${side === 'goodguys' ? 'good' : 'bad'}`] = pts;
    }
  }
  // ground height samples every ~32 units along a polyline, for smooth walking without per-frame raycasts
  const sampleRoute = (pts) => {
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(len / 32));
      for (let k = 0; k < n; k++) {
        const t = k / n, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
        out.push([x, y, groundZ(x, y, a[2])]);
      }
    }
    const last = pts[pts.length - 1];
    out.push([last[0], last[1], groundZ(last[0], last[1], last[2])]);
    return out;
  };

  // ambient zones: env_soundscape entities name a soundscape and cover a radius around them
  const soundscapes = map.entities.filter((e) => /^env_soundscape/.test(e.classname || '') && e.soundscape)
    .map((e) => ({ name: e.soundscape, origin: vec(e.origin), radius: parseFloat(e.radius || '0') || 0 }));
  const soundscapeAt = (p) => {
    let best = null, bestScore = Infinity;
    for (const s of soundscapes) {
      const d = Math.hypot(s.origin[0] - p[0], s.origin[1] - p[1]);
      const score = s.radius > 0 && d <= s.radius ? d - 1e6 : d; // inside a zone's radius wins
      if (score < bestScore) { bestScore = score; best = s; }
    }
    return best?.name || null;
  };

  // cloud layers drift along their direction at their speed (units per second over cloudscale)
  let lastTick = 0;
  const tick = (now) => {
    if (now === lastTick) return;
    const dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 0;
    lastTick = now;
    const o = clouds.ofs.value, s = lc.scale || 6500;
    o.x += Math.cos(lc.l1.dir) * lc.l1.speed * dt / s; o.y += Math.sin(lc.l1.dir) * lc.l1.speed * dt / s;
    o.z += Math.cos(lc.l2.dir) * lc.l2.speed * dt / (s * 0.7); o.w += Math.sin(lc.l2.dir) * lc.l2.speed * dt / (s * 0.7);
  };

  // map landmarks for the overview: structures, shops, runes, neutral camps, Roshan, spawns
  const markers = [];
  const teamOf = (s, x) => (/good|radiant/i.test(s) ? 'radiant' : /bad|dire/i.test(s) ? 'dire' : x < 0 ? 'radiant' : 'dire');
  const teamName = (t) => (t === 'radiant' ? 'Radiant' : 'Dire');
  const mark = (kind, team, label, e, extra = {}) => {
    const p = Array.isArray(e) ? e : vec(e.origin);
    markers.push({ kind, team, label, pos: [p[0], p[1], groundZ(p[0], p[1], p[2])], ...extra });
  };
  for (const e of ents('npc_dota_tower')) {
    const n = e.targetname || '', m = n.match(/tower(\d)(?:_(top|mid|bot))?/), t = teamOf(n, vec(e.origin)[0]);
    mark('tower', t, `${teamName(t)} tier ${m?.[1] || '?'} tower${m?.[2] ? ' · ' + m[2] : ''}`, e, { tier: +(m?.[1] || 0), name: n });
  }
  for (const e of ents('npc_dota_barracks')) {
    const n = e.targetname || '', m = n.match(/(melee|range)\w*_(top|mid|bot)/), t = teamOf(n, vec(e.origin)[0]);
    mark('rax', t, `${teamName(t)} ${m ? (m[1] === 'range' ? 'ranged' : 'melee') + ' barracks · ' + m[2] : 'barracks'}`, e, { name: n });
  }
  for (const e of ents('npc_dota_fort')) { const t = teamOf(e.targetname || '', vec(e.origin)[0]); mark('fort', t, `${teamName(t)} Ancient`, e); }
  for (const e of fountains) { const t = teamOf(e.targetname || '', vec(e.origin)[0]); mark('fountain', t, `${teamName(t)} fountain`, e); }
  for (const e of ents('ent_dota_shop')) {
    const st = +(e.shoptype || 0);
    mark('shop', null, ['Home shop', 'Side shop', 'Secret shop'][st] || 'Shop', e, { shoptype: st, model: e.model || '' });
  }
  for (const e of ents('dota_item_rune_spawner')) mark('rune', null, 'Rune spot', e);
  for (const e of ents('npc_dota_neutral_spawner')) {
    const nt = +(e.NeutralType || 0);
    mark('camp', null, `${['Small', 'Medium', 'Large', 'Ancient'][nt] || 'Neutral'} camp`, e, { size: nt });
  }
  if (roshan) mark('roshan', null, 'Roshan', roshan);
  mark('spawn', 'radiant', 'Radiant hero spawn', spots.radiant.pos);
  mark('spawn', 'dire', 'Dire hero spawn', spots.dire.pos);
  // playable area: the extent of the terrain
  const tb = new THREE.Box3();
  for (const m of terrain.children) { m.geometry.computeBoundingBox(); tb.union(m.geometry.boundingBox); }
  // (some maps have extra terrain far outside the playfield, e.g. July 2011 reaches y = 11776, so the
  // landmarks plus a margin define the area, clamped to the terrain)
  const mb = new THREE.Box3();
  for (const m of markers) mb.expandByPoint(new THREE.Vector3(...m.pos));
  mb.expandByScalar(1600);
  if (!tb.isEmpty()) mb.intersect(tb);
  const bounds = mb.isEmpty() ? { min: [-8000, -8000, 0], max: [8000, 8000, 512] } : { min: mb.min.toArray(), max: mb.max.toArray() };

  const world = {
    build, group, spots, soundscapes, soundscapeAt, lighting, tick, clouds, lanes, sampleRoute, roshan, groundZ, markers, bounds, terrain,
    stats: { ...map.stats, props: map.props.length, models: models.length, trees: ents('ent_dota_tree').length },
    ready: null,
  };
  // models stream in after the world is returned, so terrain shows immediately
  world.ready = Promise.all(Array.from({ length: 6 }, worker)).then(() => onProgress(`done — ${models.length - failed} models`));
  return world;
}
