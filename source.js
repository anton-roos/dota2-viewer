// Parsers for Source engine model and texture files, as used by Dota 2 (2011-2015).
//   MDL (studiohdr_t, v44-49), VVD (vertex data), VTX (strip/index data, v7), VTF (textures), VMT (materials)
// No rendering code here: everything returns plain typed arrays so it can be tested under Node.

const td = new TextDecoder('latin1');

function cstr(dv, off) {
  const u8 = new Uint8Array(dv.buffer, dv.byteOffset);
  let e = off;
  while (e < u8.length && u8[e] !== 0) e++;
  return td.decode(u8.subarray(off, e));
}

// ---------------------------------------------------------------- MDL
export function parseMDL(buf) {
  const dv = new DataView(buf);
  const id = td.decode(new Uint8Array(buf, 0, 4));
  if (id !== 'IDST') throw new Error('not an MDL file');
  const version = dv.getInt32(4, true);
  const i32 = (o) => dv.getInt32(o, true);
  const f32 = (o) => dv.getFloat32(o, true);

  const hdr = {
    _dv: dv,
    version,
    checksum: i32(8),
    name: cstr(dv, 12),
    hullMin: [f32(104), f32(108), f32(112)],
    hullMax: [f32(116), f32(120), f32(124)],
    numBones: i32(156),
    numSeq: i32(188),
  };

  // textures: 64-byte mstudiotexture_t, name offset is relative to each entry
  const numTex = i32(204), texIdx = i32(208);
  hdr.textures = [];
  for (let i = 0; i < numTex; i++) {
    const o = texIdx + i * 64;
    hdr.textures.push(cstr(dv, o + i32(o)));
  }
  const numCd = i32(212), cdIdx = i32(216);
  hdr.cdtextures = [];
  for (let i = 0; i < numCd; i++) hdr.cdtextures.push(cstr(dv, i32(cdIdx + i * 4)));

  const numSkinRef = i32(220), numSkinFam = i32(224), skinIdx = i32(228);
  hdr.skins = [];
  for (let f = 0; f < numSkinFam; f++) {
    const row = [];
    for (let r = 0; r < numSkinRef; r++) row.push(dv.getInt16(skinIdx + (f * numSkinRef + r) * 2, true));
    hdr.skins.push(row);
  }

  // bones (mstudiobone_t, 216 bytes in v44-49)
  const boneIdx = i32(160);
  hdr.bones = [];
  for (let i = 0; i < hdr.numBones; i++) {
    const o = boneIdx + i * 216;
    const v3 = (p) => [f32(o + p), f32(o + p + 4), f32(o + p + 8)];
    const m = [];
    for (let k = 0; k < 12; k++) m.push(f32(o + 96 + k * 4)); // poseToBone, 3x4 row-major
    hdr.bones.push({
      name: cstr(dv, o + i32(o)), parent: i32(o + 4),
      pos: v3(32), quat: [f32(o + 44), f32(o + 48), f32(o + 52), f32(o + 56)], rot: v3(60),
      posscale: v3(72), rotscale: v3(84), poseToBone: m,
    });
  }

  // animation descriptions (mstudioanimdesc_t, 100 bytes)
  const numAnim = i32(180), animIdx = i32(184);
  hdr.anims = [];
  for (let i = 0; i < numAnim; i++) {
    const o = animIdx + i * 100;
    hdr.anims.push({
      offset: o, name: cstr(dv, o + i32(o + 4)), fps: f32(o + 8), flags: i32(o + 12), numFrames: i32(o + 16),
      animBlock: i32(o + 52), animIndex: i32(o + 56), sectionIndex: i32(o + 80), sectionFrames: i32(o + 84),
    });
  }

  // pose parameters (mstudioposeparamdesc_t, 20 bytes): what drives blended sequences, e.g. body turning
  const numPose = i32(300), poseIdx = i32(304);
  hdr.poseParams = [];
  for (let i = 0; i < numPose && i < 64; i++) {
    const o = poseIdx + i * 20;
    hdr.poseParams.push({ name: cstr(dv, o + i32(o)), start: f32(o + 8), end: f32(o + 12) });
  }

  // sequences (mstudioseqdesc_t, 212 bytes in Dota's v49) with their animation events
  const seqIdx = i32(192);
  hdr.sequences = [];
  hdr.seqs = [];
  for (let i = 0; i < hdr.numSeq; i++) {
    const o = seqIdx + i * 212;
    const events = [];
    const nev = i32(o + 24), evi = o + i32(o + 28);
    for (let e = 0; e < nev; e++) {
      const eo = evi + e * 80;
      events.push({ cycle: f32(eo), event: i32(eo + 4), type: i32(eo + 8), options: cstr(dv, eo + 12), name: cstr(dv, eo + i32(eo + 76)) });
    }
    const gx = Math.max(1, i32(o + 68)), gy = Math.max(1, i32(o + 72));
    const animIndexIdx = o + i32(o + 60);
    const blendAnims = [];
    for (let k = 0; k < gx * gy; k++) blendAnims.push(dv.getInt16(animIndexIdx + k * 2, true));
    const seq = {
      name: cstr(dv, o + i32(o + 4)), activity: cstr(dv, o + i32(o + 8)), flags: i32(o + 12),
      looping: !!(i32(o + 12) & 1), blend: [gx, gy], blendAnims, events,
      param: i32(o + 76), paramStart: f32(o + 84), paramEnd: f32(o + 92),
    };
    // the default pose of a blended sequence (e.g. run with a turn parameter) is the middle of the grid
    seq.anim = blendAnims[Math.floor(gy / 2) * gx + Math.floor(gx / 2)] ?? blendAnims[0];
    hdr.seqs.push(seq);
    hdr.sequences.push(seq.name);
  }

  // body parts -> models -> meshes
  const numBP = i32(232), bpIdx = i32(236);
  hdr.bodyparts = [];
  for (let b = 0; b < numBP; b++) {
    const bo = bpIdx + b * 16;
    const bp = { name: cstr(dv, bo + i32(bo)), base: i32(bo + 8), models: [] };
    const nModels = i32(bo + 4), mIdx = bo + i32(bo + 12);
    for (let m = 0; m < nModels; m++) {
      const mo = mIdx + m * 148;
      const model = {
        name: cstr(dv, mo),
        numVertices: i32(mo + 80),
        vertexIndex: i32(mo + 84) / 48, // byte offset into VVD vertex data -> vertex index
        meshes: [],
      };
      const nMesh = i32(mo + 72), meshIdx = mo + i32(mo + 76);
      for (let k = 0; k < nMesh; k++) {
        const so = meshIdx + k * 116;
        model.meshes.push({ material: i32(so), numVertices: i32(so + 8), vertexOffset: i32(so + 12) });
      }
      bp.models.push(model);
    }
    hdr.bodyparts.push(bp);
  }
  return hdr;
}

// ---------------------------------------------------------------- animation
// Source stores each animation as a linked list of per-bone tracks. A track holds either raw
// compressed values (Quaternion48/64, Vector48) or run-length-encoded shorts per channel that are
// scaled by the bone's rotscale/posscale and added to its bind pose.
const ANIM_RAWPOS = 0x01, ANIM_RAWROT = 0x02, ANIM_ANIMPOS = 0x04, ANIM_ANIMROT = 0x08, ANIM_DELTA = 0x10, ANIM_RAWROT2 = 0x20;
const ANIMDESC_ALLZEROS = 0x20;

export function eulerToQuat(x, y, z) { // Source AngleQuaternion(RadianEuler)
  const sr = Math.sin(x / 2), cr = Math.cos(x / 2), sp = Math.sin(y / 2), cp = Math.cos(y / 2);
  const sy = Math.sin(z / 2), cy = Math.cos(z / 2);
  return [sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy];
}

function halfToFloat(h) {
  const s = h >> 15, e = (h >> 10) & 31, f = h & 1023;
  const v = e === 0 ? f / 1024 * 2 ** -14 : e === 31 ? 0 : (1 + f / 1024) * 2 ** (e - 15);
  return s ? -v : v;
}

// mstudioanimvalue_t run: [valid, total] header followed by `valid` shorts; the last valid value repeats
function animValue(dv, p, frame) {
  let k = frame;
  for (let guard = 0; guard < 10000; guard++) {
    const valid = dv.getUint8(p), total = dv.getUint8(p + 1);
    if (total === 0) return 0;
    if (total > k) return dv.getInt16(p + 2 * (valid > k ? k + 1 : valid), true);
    k -= total;
    p += 2 * (valid + 1);
  }
  return 0;
}

function trackStart(mdl, anim, frame) {
  if (!anim.sectionFrames) return { base: anim.offset + anim.animIndex, frame };
  let section, f = frame;
  if (anim.numFrames > anim.sectionFrames && frame === anim.numFrames - 1) {
    f = 0; section = Math.floor(anim.numFrames / anim.sectionFrames) + 1;
  } else {
    section = Math.floor(frame / anim.sectionFrames);
    f = frame - section * anim.sectionFrames;
  }
  return { base: anim.offset + mdl._dv.getInt32(anim.offset + anim.sectionIndex + section * 8 + 4, true), frame: f };
}

// Returns local bone transforms for one frame: pos[b*3], quat[b*4] (x, y, z, w).
export function animFrame(mdl, animIndex, frame) {
  const dv = mdl._dv;
  const bones = mdl.bones, nb = bones.length;
  const pos = new Float32Array(nb * 3), quat = new Float32Array(nb * 4);
  for (let b = 0; b < nb; b++) { pos.set(bones[b].pos, b * 3); quat.set(bones[b].quat, b * 4); }
  const anim = mdl.anims[animIndex];
  if (!anim || anim.animBlock !== 0 || anim.flags & ANIMDESC_ALLZEROS) return { pos, quat };

  const { base, frame: f } = trackStart(mdl, anim, Math.min(frame, anim.numFrames - 1));
  let t = base;
  for (let guard = 0; guard < 512; guard++) {
    const b = dv.getUint8(t), flags = dv.getUint8(t + 1), next = dv.getInt16(t + 2, true);
    const bone = bones[b];
    if (bone) {
      const delta = !!(flags & ANIM_DELTA);
      let d = t + 4;
      if (flags & ANIM_RAWROT2) {
        const lo = dv.getUint32(d, true), hi = dv.getUint32(d + 4, true);
        const x = lo & 0x1FFFFF, y = (lo >>> 21) | ((hi & 0x3FF) << 11), z = (hi >>> 10) & 0x1FFFFF;
        const q = [(x - 1048576) / 1048576.5, (y - 1048576) / 1048576.5, (z - 1048576) / 1048576.5];
        const w = Math.sqrt(Math.max(0, 1 - q[0] * q[0] - q[1] * q[1] - q[2] * q[2]));
        quat.set([q[0], q[1], q[2], hi >>> 31 ? -w : w], b * 4);
        d += 8;
      } else if (flags & ANIM_RAWROT) {
        const x = dv.getUint16(d, true), y = dv.getUint16(d + 2, true), zw = dv.getUint16(d + 4, true);
        const q = [(x - 32768) / 32768, (y - 32768) / 32768, ((zw & 0x7FFF) - 16384) / 16384];
        const w = Math.sqrt(Math.max(0, 1 - q[0] * q[0] - q[1] * q[1] - q[2] * q[2]));
        quat.set([q[0], q[1], q[2], zw >> 15 ? -w : w], b * 4);
        d += 6;
      } else if (flags & ANIM_ANIMROT) {
        const e = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          const off = dv.getInt16(d + c * 2, true);
          const v = off ? animValue(dv, d + off, f) * bone.rotscale[c] : 0;
          e[c] = v + (delta ? 0 : bone.rot[c]);
        }
        quat.set(eulerToQuat(e[0], e[1], e[2]), b * 4);
        d += 6;
      }
      if (flags & ANIM_RAWPOS) {
        for (let c = 0; c < 3; c++) pos[b * 3 + c] = halfToFloat(dv.getUint16(d + c * 2, true));
      } else if (flags & ANIM_ANIMPOS) {
        for (let c = 0; c < 3; c++) {
          const off = dv.getInt16(d + c * 2, true);
          const v = off ? animValue(dv, d + off, f) * bone.posscale[c] : 0;
          pos[b * 3 + c] = v + (delta ? 0 : bone.pos[c]);
        }
      }
    }
    if (!next) break;
    t += next;
  }
  return { pos, quat };
}

// Sequence flags (studio.h)
export const SEQ_DELTA = 0x4, SEQ_HIDDEN = 0x400;

// Decodes every frame of a sequence. Blended sequences (e.g. "turns": left / centre / right driven by a
// pose parameter) decode one frame set per blend column; 2-D grids use their middle row.
// Delta sequences hold offsets meant to be layered on top of another pose, not a pose of their own.
export function decodeSequence(mdl, seqIndex) {
  const seq = mdl.seqs[seqIndex];
  const [cols, rows] = seq.blend;
  const row = Math.floor(rows / 2);
  const columns = [];
  for (let c = 0; c < cols; c++) columns.push(seq.blendAnims[row * cols + c] ?? seq.anim);
  const blends = columns.map((ai) => {
    const anim = mdl.anims[ai];
    const n = Math.max(1, anim?.numFrames || 1);
    const frames = [];
    for (let f = 0; f < n; f++) frames.push(animFrame(mdl, ai, f));
    return frames;
  });
  const mid = Math.floor((cols - 1) / 2);
  const first = mdl.anims[columns[mid]];
  return {
    name: seq.name, fps: first?.fps || 30, numFrames: Math.max(...blends.map((b) => b.length)),
    looping: seq.looping, events: seq.events, delta: !!(seq.flags & SEQ_DELTA), hidden: !!(seq.flags & SEQ_HIDDEN),
    blends, frames: blends[mid], blendPos: cols > 1 ? mid / (cols - 1) : 0,
  };
}

// ---------------------------------------------------------------- VVD
export function parseVVD(buf) {
  const dv = new DataView(buf);
  if (td.decode(new Uint8Array(buf, 0, 4)) !== 'IDSV') throw new Error('not a VVD file');
  const numLODVerts0 = dv.getInt32(16, true);
  const numFixups = dv.getInt32(48, true);
  const fixupStart = dv.getInt32(52, true);
  const vertStart = dv.getInt32(56, true);

  // LOD 0 vertex order, applying the fixup table if present
  let order;
  if (numFixups > 0) {
    order = [];
    for (let i = 0; i < numFixups; i++) {
      const o = fixupStart + i * 12;
      const lod = dv.getInt32(o, true), src = dv.getInt32(o + 4, true), n = dv.getInt32(o + 8, true);
      if (lod >= 0) for (let j = 0; j < n; j++) order.push(src + j);
    }
  }
  const count = order ? order.length : numLODVerts0;
  const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  const bone = new Uint16Array(count * 4), weight = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const o = vertStart + (order ? order[i] : i) * 48;
    // mstudioboneweight_t: float weight[3], char bone[3], byte numbones
    const nbw = Math.min(3, dv.getUint8(o + 15));
    let sum = 0;
    for (let k = 0; k < nbw; k++) {
      bone[i * 4 + k] = dv.getUint8(o + 12 + k);
      weight[i * 4 + k] = dv.getFloat32(o + k * 4, true);
      sum += weight[i * 4 + k];
    }
    if (sum > 0) for (let k = 0; k < nbw; k++) weight[i * 4 + k] /= sum;
    else weight[i * 4] = 1;
    for (let c = 0; c < 3; c++) {
      pos[i * 3 + c] = dv.getFloat32(o + 16 + c * 4, true);
      nrm[i * 3 + c] = dv.getFloat32(o + 28 + c * 4, true);
    }
    uv[i * 2] = dv.getFloat32(o + 40, true);
    uv[i * 2 + 1] = dv.getFloat32(o + 44, true);
  }
  return { count, pos, nrm, uv, bone, weight };
}

// ---------------------------------------------------------------- VTX
// Strip-group headers grew two ints (topology) for MDL v49; detect the size by sanity-checking.
export function parseVTX(buf, mdl) {
  const dv = new DataView(buf);
  const i32 = (o) => dv.getInt32(o, true);
  const version = i32(0);
  if (version !== 7) throw new Error('unsupported VTX version ' + version);
  const numBP = i32(28), bpOff = i32(32);

  const tryParse = (sgSize) => {
    const out = []; // out[bodypart][model] = array of { meshIndex, indices: Int32Array of model-relative verts }
    for (let b = 0; b < numBP; b++) {
      const bo = bpOff + b * 8;
      const models = [];
      const nModels = i32(bo), mOff = bo + i32(bo + 4);
      for (let m = 0; m < nModels; m++) {
        const mo = mOff + m * 8;
        const lodOff = mo + i32(mo + 4); // LOD 0 only
        const nMesh = i32(lodOff), meshOff = lodOff + i32(lodOff + 4);
        const meshes = [];
        const mdlModel = mdl?.bodyparts[b]?.models[m];
        for (let k = 0; k < nMesh; k++) {
          const so = meshOff + k * 9;
          const nSG = i32(so), sgOff = so + i32(so + 4);
          const idx = [];
          const meshVertOffset = mdlModel?.meshes[k]?.vertexOffset ?? 0;
          for (let g = 0; g < nSG; g++) {
            const go = sgOff + g * sgSize;
            const nVerts = i32(go), vOff = go + i32(go + 4);
            const nIdx = i32(go + 8), iOff = go + i32(go + 12);
            if (nVerts < 0 || nIdx < 0 || nIdx % 3 || vOff + nVerts * 9 > buf.byteLength || iOff + nIdx * 2 > buf.byteLength)
              throw new Error('bad strip group');
            for (let t = 0; t < nIdx; t++) {
              const sv = dv.getUint16(iOff + t * 2, true);
              if (sv >= nVerts) throw new Error('index out of range');
              idx.push(dv.getUint16(vOff + sv * 9 + 4, true) + meshVertOffset); // origMeshVertID
            }
          }
          meshes.push({ meshIndex: k, indices: Int32Array.from(idx) });
        }
        models.push(meshes);
      }
      out.push(models);
    }
    return out;
  };
  try { return tryParse(mdl && mdl.version >= 49 ? 33 : 25); }
  catch { return tryParse(mdl && mdl.version >= 49 ? 25 : 33); }
}

// ---------------------------------------------------------------- VMT
// Tiny KeyValues reader: enough to get the shader name and $basetexture-style parameters.
export function parseVMT(text) {
  // Quoted strings are matched before comments, so a "//" inside a quoted path
  // (e.g. "models/items/lycan//sanguinemoon_armor/...") is not mistaken for one.
  const tok = /"([^"]*)"|\/\/[^\n]*|([{}])|([^\s{}"]+)/g;
  const out = { shader: null, params: {} };
  let depth = 0, key = null, m;
  while ((m = tok.exec(text))) {
    if (m[1] === undefined && m[2] === undefined && m[3] === undefined) continue; // comment
    const s = m[1] ?? m[3];
    if (m[2] === '{') { depth++; key = null; continue; }
    if (m[2] === '}') { depth--; key = null; continue; }
    if (depth === 0) { if (!out.shader) out.shader = s; continue; }
    if (depth !== 1) continue;
    if (key === null) key = s.toLowerCase();
    else { out.params[key] = s; key = null; }
  }
  return out;
}

// ---------------------------------------------------------------- VTF
const FMT = {
  0: 'RGBA8888', 1: 'ABGR8888', 2: 'RGB888', 3: 'BGR888', 4: 'RGB565', 5: 'I8', 6: 'IA88',
  8: 'A8', 11: 'ARGB8888', 12: 'BGRA8888', 13: 'DXT1', 14: 'DXT3', 15: 'DXT5', 16: 'BGRX8888',
  17: 'BGR565', 20: 'DXT1_ONEBITALPHA', 24: 'RGBA16161616F',
};
const BPP = { RGBA8888: 4, ABGR8888: 4, ARGB8888: 4, BGRA8888: 4, BGRX8888: 4, RGB888: 3, BGR888: 3,
  RGB565: 2, BGR565: 2, I8: 1, IA88: 2, A8: 1, RGBA16161616F: 8 };

function mipBytes(fmt, w, h) {
  if (fmt.startsWith('DXT')) {
    const blocks = Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4));
    return blocks * (fmt === 'DXT1' || fmt === 'DXT1_ONEBITALPHA' ? 8 : 16);
  }
  return w * h * BPP[fmt];
}

function c565(v) {
  return [((v >> 11) & 31) * 255 / 31 | 0, ((v >> 5) & 63) * 255 / 63 | 0, (v & 31) * 255 / 31 | 0];
}

function decodeDXT(src, w, h, kind) {
  const out = new Uint8ClampedArray(w * h * 4);
  const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4);
  const blockSize = kind === 1 ? 8 : 16;
  let p = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++, p += blockSize) {
      const cOff = kind === 1 ? p : p + 8;
      const c0 = src[cOff] | (src[cOff + 1] << 8), c1 = src[cOff + 2] | (src[cOff + 3] << 8);
      const a = c565(c0), b = c565(c1);
      const pal = [a, b];
      if (c0 > c1 || kind !== 1) {
        pal.push(a.map((x, i) => (2 * x + b[i]) / 3 | 0), a.map((x, i) => (x + 2 * b[i]) / 3 | 0));
      } else {
        pal.push(a.map((x, i) => (x + b[i]) / 2 | 0), [0, 0, 0]);
      }
      const bits = src[cOff + 4] | (src[cOff + 5] << 8) | (src[cOff + 6] << 16) | (src[cOff + 7] << 24) >>> 0;

      let alpha = null;
      if (kind === 3) {
        alpha = new Uint8Array(16);
        for (let i = 0; i < 16; i++) alpha[i] = ((src[p + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
      } else if (kind === 5) {
        const a0 = src[p], a1 = src[p + 1];
        const ap = [a0, a1];
        if (a0 > a1) for (let i = 1; i < 7; i++) ap.push(((7 - i) * a0 + i * a1) / 7 | 0);
        else { for (let i = 1; i < 5; i++) ap.push(((5 - i) * a0 + i * a1) / 5 | 0); ap.push(0, 255); }
        alpha = new Uint8Array(16);
        let abits = 0n;
        for (let i = 0; i < 6; i++) abits |= BigInt(src[p + 2 + i]) << BigInt(8 * i);
        for (let i = 0; i < 16; i++) alpha[i] = ap[Number((abits >> BigInt(3 * i)) & 7n)];
      }

      for (let i = 0; i < 16; i++) {
        const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
        if (x >= w || y >= h) continue;
        const ci = (bits >>> (2 * i)) & 3;
        const c = pal[ci];
        const o = (y * w + x) * 4;
        out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
        out[o + 3] = alpha ? alpha[i] : (kind === 1 && c0 <= c1 && ci === 3 ? 0 : 255);
      }
    }
  }
  return out;
}

function half(h) {
  const s = h >> 15, e = (h >> 10) & 31, f = h & 1023;
  const v = e === 0 ? f / 1024 * 2 ** -14 : e === 31 ? (f ? NaN : Infinity) : (1 + f / 1024) * 2 ** (e - 15);
  return s ? -v : v;
}

export function parseVTF(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  if (td.decode(u8.subarray(0, 3)) !== 'VTF') throw new Error('not a VTF file');
  const minor = dv.getUint32(8, true);
  const headerSize = dv.getUint32(12, true);
  const width = dv.getUint16(16, true), height = dv.getUint16(18, true);
  const flags = dv.getUint32(20, true);
  const frames = dv.getUint16(24, true) || 1;
  const fmtId = dv.getInt32(52, true);
  const mips = dv.getUint8(56);
  const lowFmtId = dv.getInt32(57, true);
  const lowW = dv.getUint8(61), lowH = dv.getUint8(62);
  const depth = minor >= 2 ? (dv.getUint16(63, true) || 1) : 1;
  const fmt = FMT[fmtId];
  if (!fmt) throw new Error('unsupported VTF format ' + fmtId);
  const faces = flags & 0x4000 ? (minor < 5 ? 7 : 6) : 1; // TEXTUREFLAGS_ENVMAP

  let dataStart = -1;
  if (minor >= 3) {
    const numRes = dv.getUint32(68, true);
    for (let i = 0; i < numRes; i++) {
      const o = 80 + i * 8;
      if (u8[o] === 0x30 && u8[o + 1] === 0 && u8[o + 2] === 0) dataStart = dv.getUint32(o + 4, true);
    }
  }
  if (dataStart < 0) {
    const lowBytes = lowFmtId >= 0 && FMT[lowFmtId] ? mipBytes(FMT[lowFmtId], lowW, lowH) : 0;
    dataStart = headerSize + lowBytes;
  }

  // mips are stored smallest first; mip 0 (largest) is last
  let off = dataStart;
  for (let m = mips - 1; m >= 1; m--) {
    const w = Math.max(1, width >> m), h = Math.max(1, height >> m);
    off += mipBytes(fmt, w, h) * frames * faces * Math.max(1, depth >> m);
  }
  const src = u8.subarray(off, off + mipBytes(fmt, width, height));

  let rgba;
  const n = width * height;
  if (fmt === 'DXT1' || fmt === 'DXT1_ONEBITALPHA') rgba = decodeDXT(src, width, height, 1);
  else if (fmt === 'DXT3') rgba = decodeDXT(src, width, height, 3);
  else if (fmt === 'DXT5') rgba = decodeDXT(src, width, height, 5);
  else {
    rgba = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const s = i * (BPP[fmt] || 4);
      let r = 0, g = 0, b = 0, a = 255;
      switch (fmt) {
        case 'RGBA8888': [r, g, b, a] = [src[s], src[s + 1], src[s + 2], src[s + 3]]; break;
        case 'ABGR8888': [a, b, g, r] = [src[s], src[s + 1], src[s + 2], src[s + 3]]; break;
        case 'ARGB8888': [a, r, g, b] = [src[s], src[s + 1], src[s + 2], src[s + 3]]; break;
        case 'BGRA8888': [b, g, r, a] = [src[s], src[s + 1], src[s + 2], src[s + 3]]; break;
        case 'BGRX8888': [b, g, r] = [src[s], src[s + 1], src[s + 2]]; break;
        case 'RGB888': [r, g, b] = [src[s], src[s + 1], src[s + 2]]; break;
        case 'BGR888': [b, g, r] = [src[s], src[s + 1], src[s + 2]]; break;
        case 'RGB565': [r, g, b] = c565(src[s] | (src[s + 1] << 8)); break;
        case 'BGR565': [b, g, r] = c565(src[s] | (src[s + 1] << 8)); break;
        case 'I8': r = g = b = src[s]; break;
        case 'IA88': r = g = b = src[s]; a = src[s + 1]; break;
        case 'A8': r = g = b = 255; a = src[s]; break;
        case 'RGBA16161616F': {
          const h16 = (k) => half(src[s + k * 2] | (src[s + k * 2 + 1] << 8));
          const t = (v) => Math.min(255, Math.max(0, Math.pow(v / (1 + v), 1 / 2.2) * 255)); // simple tonemap
          r = t(h16(0)); g = t(h16(1)); b = t(h16(2)); break;
        }
      }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    }
  }
  return { width, height, format: fmt, version: `7.${minor}`, frames, mips, rgba };
}

// ---------------------------------------------------------------- BSP (maps, v20-22)
// Reads what the world view needs: terrain (displacements + visible brush faces) grouped by material,
// entities, and static props. Coordinates stay in Source space (Z-up, units = inches).
export function parseBSP(buf) {
  const dv = new DataView(buf);
  if (td.decode(new Uint8Array(buf, 0, 4)) !== 'VBSP') throw new Error('not a BSP file');
  const version = dv.getInt32(4, true);
  const lump = (i) => ({ ofs: dv.getInt32(8 + i * 16, true), len: dv.getInt32(12 + i * 16, true), ver: dv.getInt32(16 + i * 16, true) });
  const f32 = (o) => dv.getFloat32(o, true), i32 = (o) => dv.getInt32(o, true);

  // texture names
  const strData = lump(43), strTable = lump(44);
  const texNames = [];
  for (let k = 0; k < strTable.len / 4; k++) texNames.push(cstr(dv, strData.ofs + i32(strTable.ofs + k * 4)));
  const texdata = [];
  for (let o = lump(2).ofs, e = o + lump(2).len; o < e; o += 32) {
    texdata.push({ name: texNames[i32(o + 12)] || '', width: i32(o + 16), height: i32(o + 20) });
  }
  const texinfo = [];
  for (let o = lump(6).ofs, e = o + lump(6).len; o < e; o += 72) {
    const v = []; for (let k = 0; k < 8; k++) v.push(f32(o + k * 4));
    texinfo.push({ s: v.slice(0, 4), t: v.slice(4, 8), flags: i32(o + 64), texdata: i32(o + 68) });
  }
  const verts = lump(3), edges = lump(12), surfedges = lump(13);
  const vertex = (k) => [f32(verts.ofs + k * 12), f32(verts.ofs + k * 12 + 4), f32(verts.ofs + k * 12 + 8)];
  const faceVerts = (first, num) => {
    const out = [];
    for (let k = 0; k < num; k++) {
      const se = i32(surfedges.ofs + (first + k) * 4);
      const e = edges.ofs + Math.abs(se) * 4;
      out.push(vertex(dv.getUint16(e + (se >= 0 ? 0 : 2), true)));
    }
    return out;
  };

  // group output geometry by material
  const groups = new Map();
  const group = (ti) => {
    const tdat = texdata[texinfo[ti].texdata];
    const name = tdat.name.toLowerCase();
    if (!groups.has(name)) groups.set(name, { material: name, width: tdat.width || 512, height: tdat.height || 512, pos: [], uv: [], alpha: [], idx: [] });
    return groups.get(name);
  };
  const uvOf = (ti, p, w, h) => {
    const { s, t } = texinfo[ti];
    return [(p[0] * s[0] + p[1] * s[1] + p[2] * s[2] + s[3]) / w, (p[0] * t[0] + p[1] * t[1] + p[2] * t[2] + t[3]) / h];
  };
  const SKIP = 0x0004 | 0x0002 | 0x0080 | 0x0200; // SURF_SKY, SURF_SKY2D, SURF_NODRAW, SURF_TRIGGER

  const faces = lump(7), dispinfo = lump(26), dispverts = lump(33);
  // ddispinfo_t is 176 bytes in BSP v20/21 but 180 in Dota's v22: derive it from the highest index used
  let maxDisp = -1;
  for (let o = faces.ofs, e = o + faces.len; o < e; o += 56) maxDisp = Math.max(maxDisp, dv.getInt16(o + 12, true));
  const dispSize = maxDisp >= 0 ? Math.floor(dispinfo.len / (maxDisp + 1)) : 176;
  let dispCount = 0, brushCount = 0;
  const displacements = [];
  for (let o = faces.ofs, e = o + faces.len; o < e; o += 56) {
    const firstEdge = i32(o + 4), numEdges = dv.getInt16(o + 8, true);
    const ti = dv.getInt16(o + 10, true), di = dv.getInt16(o + 12, true);
    if (ti < 0 || !texinfo[ti]) continue;
    const name = (texdata[texinfo[ti].texdata]?.name || '').toLowerCase();
    if (texinfo[ti].flags & SKIP || name.startsWith('tools/')) continue;
    const g = group(ti);
    const corners = faceVerts(firstEdge, numEdges);
    if (di >= 0 && corners.length === 4) {
      // displacement: a (2^power+1)² grid over the face, each vertex pushed out along its vector
      const d = dispinfo.ofs + di * dispSize;
      const start = [f32(d), f32(d + 4), f32(d + 8)];
      const vertStart = i32(d + 12), power = i32(d + 20);
      // minTess doubles as a flags word in this engine branch: 0x80000000 = flags valid,
      // 0x40000000 = this displacement has LUMP_DISP_MULTIBLEND records
      const flags = i32(d + 24) >>> 0;
      const hasMultiblend = (flags & 0x80000000) !== 0 && (flags & 0x40000000) !== 0;
      let best = 0, bestDist = Infinity;
      corners.forEach((c, k) => { const dd = (c[0] - start[0]) ** 2 + (c[1] - start[1]) ** 2 + (c[2] - start[2]) ** 2; if (dd < bestDist) { bestDist = dd; best = k; } });
      const c = [0, 1, 2, 3].map((k) => corners[(best + k) % 4]);
      const n = (1 << power) + 1, base = g.pos.length / 3;
      displacements.push({ di, group: g, first: base, count: n * n, hasMultiblend });
      for (let i = 0; i < n; i++) {
        const a = i / (n - 1);
        const left = [0, 1, 2].map((k) => c[0][k] + (c[1][k] - c[0][k]) * a);
        const right = [0, 1, 2].map((k) => c[3][k] + (c[2][k] - c[3][k]) * a);
        for (let j = 0; j < n; j++) {
          const b = j / (n - 1);
          const p0 = [0, 1, 2].map((k) => left[k] + (right[k] - left[k]) * b);
          const v = dispverts.ofs + (vertStart + i * n + j) * 20;
          const dist = f32(v + 12);
          g.pos.push(p0[0] + f32(v) * dist, p0[1] + f32(v + 4) * dist, p0[2] + f32(v + 8) * dist);
          g.uv.push(...uvOf(ti, p0, g.width, g.height));
          g.alpha.push(f32(v + 16) / 255);
        }
      }
      for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) {
        const q = base + i * n + j;
        g.idx.push(q, q + 1, q + n, q + 1, q + n + 1, q + n);
      }
      dispCount++;
    } else {
      const base = g.pos.length / 3;
      for (const p of corners) { g.pos.push(...p); g.uv.push(...uvOf(ti, p, g.width, g.height)); g.alpha.push(0); }
      for (let k = 1; k < corners.length - 1; k++) g.idx.push(base, base + k, base + k + 1);
      brushCount++;
    }
  }

  // entities: { "key" "value" } blocks
  const ent = lump(0);
  const text = td.decode(new Uint8Array(buf, ent.ofs, ent.len));
  const entities = [];
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    const o = {};
    for (const kv of m[1].matchAll(/"([^"]*)"\s+"([^"]*)"/g)) if (!(kv[1] in o)) o[kv[1]] = kv[2];
    entities.push(o);
  }

  // static props (game lump 'sprp'): model dictionary, leaf list, then fixed-size prop records
  const props = [];
  const game = lump(35);
  const nGame = i32(game.ofs);
  for (let k = 0; k < nGame; k++) {
    const g = game.ofs + 4 + k * 16;
    const id = td.decode(new Uint8Array(buf, g, 4)).split('').reverse().join('');
    if (id !== 'sprp') continue;
    const ofs = i32(g + 8), len = i32(g + 12);
    let p = ofs;
    const nDict = i32(p); p += 4;
    const dict = [];
    for (let j = 0; j < nDict; j++) dict.push(cstr(dv, p + j * 128).toLowerCase().split('\\').join('/'));
    p += nDict * 128;
    const nLeaf = i32(p); p += 4 + nLeaf * 2;
    const nProps = i32(p); p += 4;
    const size = nProps ? Math.floor((ofs + len - p) / nProps) : 0;
    for (let j = 0; j < nProps; j++) {
      const r = p + j * size;
      props.push({ origin: [f32(r), f32(r + 4), f32(r + 8)], angles: [f32(r + 12), f32(r + 16), f32(r + 20)],
        model: dict[dv.getUint16(r + 24, true)], skin: i32(r + 32) });
    }
  }

  // LUMP_DISP_MULTIBLEND (63): 80 bytes per vertex of each MultiBlend displacement, in dispinfo order:
  // vec4 layer weights, vec4 layer alphas, 4 × vec3 layer tint colours. Assigned by applyMultiblend()
  // once the caller knows which materials use the MultiBlend shader.
  const mbl = lump(63);
  const multiblend = mbl.len ? new Float32Array(buf.slice(mbl.ofs, mbl.ofs + mbl.len)) : null;
  displacements.sort((a, b) => a.di - b.di);

  return { version, groups: [...groups.values()], entities, props, displacements, multiblend, stats: { dispCount, brushCount } };
}

// Gives each group with MultiBlend displacements per-vertex `mb` (4 weights) and `mbc` (4 RGB tints).
// Records belong to displacements flagged hasMultiblend, consumed in dispinfo order.
// Returns how many records were used, so callers can check it against the lump size.
export function applyMultiblend(map) {
  if (!map.multiblend) return 0;
  const src = map.multiblend, records = src.length / 20;
  let r = 0;
  for (const d of map.displacements) {
    if (!d.hasMultiblend) continue;
    const g = d.group;
    const nv = g.pos.length / 3;
    g.mb ||= new Float32Array(nv * 4).fill(0);
    g.mbc ||= new Float32Array(nv * 12).fill(1);
    for (let k = 0; k < d.count && r < records; k++, r++) {
      const v = d.first + k, s = r * 20;
      for (let c = 0; c < 4; c++) g.mb[v * 4 + c] = src[s + c];
      for (let c = 0; c < 12; c++) g.mbc[v * 12 + c] = src[s + 8 + c];
    }
  }
  for (const g of map.groups) if (g.mb) {
    // brush faces and non-multiblend vertices in a multiblend group: show layer 1 untinted
    for (let v = 0; v < g.pos.length / 3; v++) {
      if (g.mb[v * 4] + g.mb[v * 4 + 1] + g.mb[v * 4 + 2] + g.mb[v * 4 + 3] === 0) g.mb[v * 4] = 1;
    }
  }
  return r;
}

// ---------------------------------------------------------------- assembly
// Combines MDL + VVD + VTX into flat meshes: one per (bodypart, model, mesh) with a material slot.
export function buildModel(mdlBuf, vvdBuf, vtxBuf) {
  const mdl = parseMDL(mdlBuf);
  const vvd = parseVVD(vvdBuf);
  const vtx = parseVTX(vtxBuf, mdl);
  const meshes = [];
  mdl.bodyparts.forEach((bp, b) => {
    // only the first model of each bodypart (the default sub-model) is shown
    const model = bp.models[0];
    if (!model || !model.meshes.length) return;
    const vmeshes = vtx[b]?.[0] || [];
    vmeshes.forEach((vm) => {
      const mesh = model.meshes[vm.meshIndex];
      if (!vm.indices.length) return;
      // gather used vertices into a compact buffer
      const remap = new Map();
      const pos = [], nrm = [], uv = [], bone = [], weight = [], idx = new Uint32Array(vm.indices.length);
      for (let i = 0; i < vm.indices.length; i++) {
        const gv = model.vertexIndex + vm.indices[i];
        let li = remap.get(gv);
        if (li === undefined) {
          li = remap.size;
          remap.set(gv, li);
          pos.push(vvd.pos[gv * 3], vvd.pos[gv * 3 + 1], vvd.pos[gv * 3 + 2]);
          nrm.push(vvd.nrm[gv * 3], vvd.nrm[gv * 3 + 1], vvd.nrm[gv * 3 + 2]);
          uv.push(vvd.uv[gv * 2], vvd.uv[gv * 2 + 1]);
          for (let k = 0; k < 4; k++) { bone.push(vvd.bone[gv * 4 + k]); weight.push(vvd.weight[gv * 4 + k]); }
        }
        idx[i] = li;
      }
      // Source winds triangles clockwise; flip to counter-clockwise for WebGL
      for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
      meshes.push({
        bodypart: bp.name, material: mesh.material,
        pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), uv: Float32Array.from(uv), idx,
        bone: Uint16Array.from(bone), weight: Float32Array.from(weight),
      });
    });
  });
  return { mdl, meshes, vertexCount: vvd.count };
}

// VMT texture references are written loosely: with or without "materials/", with or without ".vtf",
// with either slash. Normalise the way the engine does before looking the file up.
export function texturePath(ref) {
  let p = String(ref || '').trim().split('\\').join('/').toLowerCase().replace(/\/{2,}/g, '/').replace(/^\/+/, '');
  if (p.startsWith('materials/')) p = p.slice('materials/'.length);
  if (p.endsWith('.vtf')) p = p.slice(0, -4);
  return p ? `materials/${p}.vtf` : null;
}

// Candidate .vmt paths for a material slot, following MDL texture names and $cdmaterials folders.
export function materialPaths(mdl, slot, skin = 0) {
  const ref = mdl.skins[skin]?.[slot] ?? slot;
  const name = (mdl.textures[ref] || '').replace(/\\/g, '/').toLowerCase();
  const out = [];
  for (const cd of mdl.cdtextures.length ? mdl.cdtextures : ['']) {
    const dir = cd.replace(/\\/g, '/').toLowerCase().replace(/^\/+/, '');
    out.push(`materials/${dir}${dir && !dir.endsWith('/') ? '/' : ''}${name}.vmt`.replace(/\/+/g, '/'));
  }
  return out;
}
