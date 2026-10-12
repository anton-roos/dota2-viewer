// Whole-map mode for a view: an RTS-style camera over the entire dota.bsp, landmark labels (towers,
// barracks, Ancients, shops, runes, neutral camps, Roshan, spawns), creep-lane lines, and a minimap
// rendered from the map itself. Double-click the ground to send the hero running there.
// Everything it creates lives under its own DOM node and THREE group and is freed by leave().
import * as THREE from 'three';

const GLYPH = { tower: '▲', rax: '■', fort: '◆', fountain: '●', shop: '$', rune: '✦', camp: '•', roshan: '☠', spawn: '★' };
const LANE_COLOR = { good: 0x5ad35a, bad: 0xe0503c };
const SNAP = 512; // minimap snapshot resolution

// Source (x, y, z) -> three.js world (the world container rotates Z-up to Y-up)
const toThree = (p) => new THREE.Vector3(p[0], p[2], -p[1]);

export class MapMode {
  constructor(view, world, { onWalk, onBattle } = {}) {
    this.view = view;
    this.world = world;
    this.onWalk = onWalk;
    this.onBattle = onBattle;
    this.keys = new Set();
    this.showLabels = true;
    this.showLanes = true;
    this.showCamps = true;
    this.buildOverlay();
    this.buildDom();
    this.setupCamera();
    this.overview();
  }

  // ------------------------------------------------------------ scene overlay: lane lines
  buildOverlay() {
    this.group = new THREE.Group();
    this.group.name = 'map-overlay';
    for (const [key, pts] of Object.entries(this.world.lanes)) {
      const route = this.world.sampleRoute(pts.slice(1)); // skip the spawn point the walker starts at
      const geo = new THREE.BufferGeometry().setFromPoints(route.map((p) => toThree([p[0], p[1], p[2] + 24])));
      const mat = new THREE.LineDashedMaterial({ color: LANE_COLOR[key.split('_')[1]], dashSize: 90, gapSize: 60, transparent: true,
        opacity: 0.85, depthTest: false, fog: false });
      const line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      line.renderOrder = 10;
      line.userData.lane = key;
      this.group.add(line);
    }
    this.view.scene.add(this.group);
  }

  // ------------------------------------------------------------ DOM: labels, minimap, legend
  buildDom() {
    const v = this.view;
    this.el = document.createElement('div');
    this.el.className = 'mapmode';
    this.el.innerHTML = `<div class="maplabels"></div>`
      + `<div class="minimap"><canvas width="${SNAP}" height="${SNAP}"></canvas><div class="mmcap">minimap · click to fly</div></div>`
      + `<div class="maplegend">`
      + `<label><input type="checkbox" data-o="showLabels" checked> landmarks</label>`
      + `<label><input type="checkbox" data-o="showLanes" checked> lanes</label>`
      + `<label><input type="checkbox" data-o="showCamps" checked> camps</label>`
      + `<button class="btn" data-a="overview" title="Back to the whole map">⤢ overview</button>`
      + `<button class="btn" data-a="hero" title="Fly to the hero">◎ hero</button>`
      + `<button class="btn" data-a="battle" title="Creep waves on all three lanes, fighting each other and the towers (click again to stop)">⚔ waves</button>`
      + `</div>`;
    v.el.append(this.el);
    this.labelsEl = this.el.querySelector('.maplabels');
    this.mm = this.el.querySelector('.minimap canvas');
    this.mmCtx = this.mm.getContext('2d');
    for (const cb of this.el.querySelectorAll('[data-o]')) cb.onchange = () => { this[cb.dataset.o] = cb.checked; this.refreshVisibility(); };
    this.el.querySelector('[data-a=overview]').onclick = () => this.overview(true);
    this.el.querySelector('[data-a=battle]').onclick = () => this.onBattle?.();
    this.el.querySelector('[data-a=hero]').onclick = () => this.flyTo(v.spin.position.clone(), 1800);

    // landmark labels
    this.labels = this.world.markers.map((m) => {
      const d = document.createElement('div');
      d.className = `mlabel k-${m.kind}${m.team ? ' t-' + m.team : ''}${m.kind === 'camp' ? ' s' + m.size : ''}`;
      d.innerHTML = `<i>${GLYPH[m.kind] || '•'}</i><span>${m.label}</span>`;
      d.title = `${m.label}\n${m.pos.map(Math.round).join(', ')}${m.name ? '\n' + m.name : ''}`;
      d.onclick = () => this.flyTo(toThree(m.pos), m.kind === 'tower' || m.kind === 'rax' ? 1400 : 1800);
      this.labelsEl.append(d);
      return { m, d, p: toThree(m.pos).add(new THREE.Vector3(0, m.kind === 'tower' ? 380 : m.kind === 'fort' ? 520 : 120, 0)) };
    });

    // minimap: click / drag to move the camera there
    const fromEvent = (e) => {
      const r = this.mm.getBoundingClientRect();
      return this.mmToSource((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    };
    this.mm.onpointerdown = (e) => {
      e.stopPropagation();
      this.mm.setPointerCapture(e.pointerId);
      this.panTo(toThree(fromEvent(e)));
      this.mm.onpointermove = (ev) => this.panTo(toThree(fromEvent(ev)));
    };
    this.mm.onpointerup = () => { this.mm.onpointermove = null; };

    // double-click the ground: the hero runs there
    this.onDbl = (e) => {
      const hit = this.pick(e);
      if (hit && this.onWalk) this.onWalk(hit);
    };
    v.renderer.domElement.addEventListener('dblclick', this.onDbl);
    this.onKeyDown = (e) => {
      if (/input|select|textarea/i.test(e.target.tagName) || !e.code.startsWith('Arrow')) return;
      if (v.el.matches(':hover') || this.view === window.dotaViewer?.hud?.view) { this.keys.add(e.code); e.preventDefault(); }
    };
    this.onKeyUp = (e) => this.keys.delete(e.code);
    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
  }

  refreshVisibility() {
    for (const c of this.group.children) c.visible = this.showLanes;
    this.labelsEl.hidden = !this.showLabels;
  }

  // ------------------------------------------------------------ camera
  setupCamera() {
    const c = this.view.controls, cam = this.view.camera;
    this.saved = { buttons: { ...c.mouseButtons }, ssp: c.screenSpacePanning, maxPolar: c.maxPolarAngle, maxDist: c.maxDistance,
      minDist: c.minDistance, near: cam.near, far: cam.far, pan: c.panSpeed };
    c.maxPolarAngle = THREE.MathUtils.degToRad(82);
    c.minDistance = 250;
    c.maxDistance = 32000;
    cam.near = 16; cam.far = 90000;
    cam.updateProjectionMatrix();
  }

  center() {
    const b = this.world.bounds;
    return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 128];
  }

  // the whole map, from above the Radiant corner like the in-game camera angle
  overview(animate = false) {
    const b = this.world.bounds;
    const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]);
    const target = toThree(this.center());
    // fit the map in the narrower of the two fields of view
    const cam = this.view.camera, vfov = THREE.MathUtils.degToRad(cam.fov / 2);
    const half = Math.min(vfov, Math.atan(Math.tan(vfov) * cam.aspect));
    const dist = size * 0.62 / Math.tan(half);
    const offset = new THREE.Vector3(0, Math.cos(THREE.MathUtils.degToRad(35)), Math.sin(THREE.MathUtils.degToRad(35))).multiplyScalar(dist);
    if (animate) this.tween(target, offset);
    else { this.view.controls.target.copy(target); this.view.camera.position.copy(target).add(offset); this.view.controls.update(); }
  }

  // keep the current viewing angle, move the target there and zoom to `dist`
  flyTo(target, dist) {
    const offset = this.view.camera.position.clone().sub(this.view.controls.target).setLength(dist);
    this.tween(target, offset);
  }

  panTo(target) {
    const offset = this.view.camera.position.clone().sub(this.view.controls.target);
    target.y = this.view.controls.target.y;
    this.view.controls.target.copy(target);
    this.view.camera.position.copy(target).add(offset);
    this.view.controls.update();
  }

  tween(target, offset, ms = 700) {
    const c = this.view.controls;
    this.anim = { t0: performance.now(), ms, fromT: c.target.clone(), toT: target.clone(),
      fromO: this.view.camera.position.clone().sub(c.target), toO: offset.clone() };
  }

  // ------------------------------------------------------------ picking
  pick(e) {
    const v = this.view, r = v.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, v.camera);
    const terrain = v.worldObj?.children[0]?.children.find((g) => g.children.length && g.children[0].name?.startsWith('terrain:'));
    const meshes = terrain ? terrain.children.filter((m) => !/water|black|map_edge/.test(m.name)) : [];
    const hit = ray.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    return [hit.point.x, -hit.point.z, hit.point.y]; // back to Source space
  }

  // ------------------------------------------------------------ minimap
  mmRect() {
    const b = this.world.bounds;
    const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]);
    const [cx, cy] = this.center();
    return { x0: cx - size / 2, y0: cy - size / 2, size };
  }
  mmToSource(u, v) {
    const r = this.mmRect();
    const x = r.x0 + u * r.size, y = r.y0 + (1 - v) * r.size;
    return [x, y, this.world.groundZ(x, y, 128)];
  }
  sourceToMm(x, y) {
    const r = this.mmRect();
    return [((x - r.x0) / r.size) * SNAP, (1 - (y - r.y0) / r.size) * SNAP];
  }

  // Render the map straight down with an orthographic camera into a texture and keep the pixels.
  // Cached on the world object, so every view showing this build shares it.
  snapshot(force = false) {
    const w = this.world;
    if (w.minimap && !force) { this.snap = w.minimap; return; }
    const v = this.view, r = this.mmRect();
    const [cx, cy] = this.center();
    const cam = new THREE.OrthographicCamera(-r.size / 2, r.size / 2, r.size / 2, -r.size / 2, 1, 40000);
    cam.up.set(0, 0, -1); // screen-up = Source +y (north)
    cam.position.set(cx, 20000, -cy);
    cam.lookAt(cx, 0, -cy);
    const rt = new THREE.WebGLRenderTarget(SNAP, SNAP, { colorSpace: THREE.SRGBColorSpace });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const hide = [this.group, v.spin, v.actorRoot, v.particles?.group].filter(Boolean);
    const vis = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    const fog = v.scene.fog;
    v.scene.fog = null;
    v.renderer.setRenderTarget(rt);
    v.renderer.render(v.scene, cam);
    const px = new Uint8Array(SNAP * SNAP * 4);
    v.renderer.readRenderTargetPixels(rt, 0, 0, SNAP, SNAP, px);
    v.renderer.setRenderTarget(null);
    v.scene.fog = fog;
    hide.forEach((o, i) => (o.visible = vis[i]));
    rt.dispose();
    // rows come back bottom-up
    const img = new ImageData(SNAP, SNAP);
    for (let y = 0; y < SNAP; y++) img.data.set(px.subarray((SNAP - 1 - y) * SNAP * 4, (SNAP - y) * SNAP * 4), y * SNAP * 4);
    const c = document.createElement('canvas');
    c.width = c.height = SNAP;
    c.getContext('2d').putImageData(img, 0, 0);
    w.minimap = c;
    this.snap = c;
  }

  drawMinimap() {
    const g = this.mmCtx, v = this.view;
    g.clearRect(0, 0, SNAP, SNAP);
    if (this.snap) g.drawImage(this.snap, 0, 0);
    g.fillStyle = 'rgba(0,0,0,.15)';
    g.fillRect(0, 0, SNAP, SNAP);
    // lanes
    if (this.showLanes) for (const [key, pts] of Object.entries(this.world.lanes)) {
      g.strokeStyle = key.endsWith('good') ? 'rgba(90,211,90,.75)' : 'rgba(224,80,60,.75)';
      g.lineWidth = 3;
      g.setLineDash([10, 7]);
      g.beginPath();
      pts.slice(1).forEach((p, i) => { const [x, y] = this.sourceToMm(p[0], p[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
    }
    g.setLineDash([]);
    // landmarks
    for (const { m } of this.labels) {
      if (m.kind === 'camp' && !this.showCamps) continue;
      const [x, y] = this.sourceToMm(m.pos[0], m.pos[1]);
      const col = m.team === 'radiant' ? '#6fe06f' : m.team === 'dire' ? '#ff6650' : m.kind === 'rune' ? '#7ad0ff' : m.kind === 'roshan' ? '#ffcf6a' : '#e8e0c8';
      const s = { fort: 11, rax: 7, tower: 7, fountain: 9, roshan: 10, shop: 7, spawn: 7 }[m.kind] || 5;
      g.fillStyle = col;
      g.strokeStyle = '#000';
      g.lineWidth = 2;
      g.beginPath();
      if (m.kind === 'tower') { g.moveTo(x, y - s); g.lineTo(x + s, y + s * 0.8); g.lineTo(x - s, y + s * 0.8); g.closePath(); }
      else if (m.kind === 'rax' || m.kind === 'shop') g.rect(x - s / 2 - 1, y - s / 2 - 1, s + 2, s + 2);
      else if (m.kind === 'fort') { g.moveTo(x, y - s); g.lineTo(x + s, y); g.lineTo(x, y + s); g.lineTo(x - s, y); g.closePath(); }
      else g.arc(x, y, s / 2 + 1, 0, Math.PI * 2);
      g.fill(); g.stroke();
    }
    // creeps and towers of a running battle
    for (const u of v.battle?.units || []) {
      if (u.state === 'dead') continue;
      const [x, y] = this.sourceToMm(u.pos[0], u.pos[1]);
      g.fillStyle = u.team === 'radiant' ? '#9dff7a' : '#ff5a3a';
      if (u.kind === 'tower') continue; // drawn as landmarks
      g.fillRect(x - 2.5, y - 2.5, 5, 5);
    }
    // what the camera sees: its frustum corners projected onto the ground plane
    const cam = v.camera, ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(v.controls.target.y));
    const ray = new THREE.Raycaster();
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
      ray.setFromCamera(new THREE.Vector2(x, y), cam);
      const p = new THREE.Vector3();
      if (!ray.ray.intersectPlane(ground, p)) {
        // looking above the horizon: clamp far along the ray's ground direction
        const d = ray.ray.direction.clone().setY(0).normalize();
        p.copy(ray.ray.origin).addScaledVector(d, 30000);
      }
      return this.sourceToMm(p.x, -p.z);
    });
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    corners.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.stroke();
    // the hero
    const hp = v.spin.position, [hx, hy] = this.sourceToMm(hp.x, -hp.z);
    g.fillStyle = '#ffd24a';
    g.strokeStyle = '#000';
    g.beginPath(); g.arc(hx, hy, 7, 0, Math.PI * 2); g.fill(); g.stroke();
  }

  // ------------------------------------------------------------ per frame
  update(dt) {
    const v = this.view, c = v.controls, cam = v.camera;
    if (this.anim) {
      const k = Math.min(1, (performance.now() - this.anim.t0) / this.anim.ms), e = 1 - Math.pow(1 - k, 3);
      c.target.lerpVectors(this.anim.fromT, this.anim.toT, e);
      cam.position.copy(c.target).add(new THREE.Vector3().lerpVectors(this.anim.fromO, this.anim.toO, e));
      if (k >= 1) this.anim = null;
    }
    // arrow keys fly across the ground, faster when zoomed out
    if (this.keys.size) {
      const fwd = c.target.clone().sub(cam.position).setY(0).normalize();
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
      const sp = cam.position.distanceTo(c.target) * 1.2 * dt;
      const mv = new THREE.Vector3();
      if (this.keys.has('ArrowUp')) mv.add(fwd);
      if (this.keys.has('ArrowDown')) mv.sub(fwd);
      if (this.keys.has('ArrowRight')) mv.add(right);
      if (this.keys.has('ArrowLeft')) mv.sub(right);
      mv.setLength(sp);
      c.target.add(mv); cam.position.add(mv);
      c.dispatchEvent({ type: 'change' });
    }
    // lane lines help from above but look like streaks up close: fade them out as you zoom in
    const camDist = cam.position.distanceTo(c.target);
    const laneAlpha = Math.max(0, Math.min(0.85, (camDist - 2500) / 4000));
    for (const l of this.group.children) { l.material.opacity = laneAlpha; l.visible = this.showLanes && laneAlpha > 0.02; }
    // labels: project each landmark; names appear when zoomed in close enough or on hover
    if (this.showLabels) {
      const r = v.renderer.domElement.getBoundingClientRect(), W = r.width, H = r.height;
      const zoomed = cam.position.distanceTo(c.target) < 6000;
      const p = new THREE.Vector3();
      for (const L of this.labels) {
        const hide = L.m.kind === 'camp' && !this.showCamps;
        p.copy(L.p).project(cam);
        const on = !hide && p.z < 1 && Math.abs(p.x) < 1.05 && Math.abs(p.y) < 1.05;
        if (!on) { if (!L.d.hidden) L.d.hidden = true; continue; }
        L.d.hidden = false;
        L.d.style.transform = `translate(${((p.x + 1) / 2 * W).toFixed(1)}px, ${((1 - p.y) / 2 * H).toFixed(1)}px)`;
        L.d.classList.toggle('named', zoomed && cam.position.distanceTo(L.p) < 4500);
      }
    }
    // the minimap is cheap to redraw, but 20 fps is plenty
    this.mmTimer = (this.mmTimer || 0) + dt;
    if (this.mmTimer > 0.05) { this.mmTimer = 0; this.drawMinimap(); }
  }

  // ------------------------------------------------------------ cleanup
  leave() {
    const v = this.view, c = v.controls, cam = v.camera;
    v.renderer.domElement.removeEventListener('dblclick', this.onDbl);
    removeEventListener('keydown', this.onKeyDown);
    removeEventListener('keyup', this.onKeyUp);
    this.el.remove();
    v.scene.remove(this.group);
    for (const l of this.group.children) { l.geometry.dispose(); l.material.dispose(); }
    c.maxPolarAngle = this.saved.maxPolar;
    c.maxDistance = this.saved.maxDist;
    c.minDistance = this.saved.minDist;
    c.panSpeed = this.saved.pan;
    cam.near = this.saved.near; cam.far = this.saved.far;
    cam.updateProjectionMatrix();
  }
}
