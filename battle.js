// Lane battles: creep waves spawn at each team's barracks every 30 s (3 melee + 1 ranged, a siege creep
// every 7th wave), march down their lane, fight whatever enemy comes into acquisition range, and push into
// the enemy towers. Stats come from the build's own unit files (health, armor, damage, attack rate and
// point, range, projectile speed, move speed), so a 2011 build fights by 2011 numbers.
// Everything lives in Source space (Z-up) under one group; dispose() frees it all.
import * as THREE from 'three';
import { ABILITIES, abilityValue } from './abilities.js?v=3';

const WAVE_INTERVAL = 30;   // seconds between waves (Dota)
const MAX_UNITS = 70;       // safety cap
const RADIUS = { melee: 32, ranged: 28, siege: 40, tower: 110, hero: 26 };
const HERO_ACQUIRE = 600; // idle heroes auto-attack enemies this close

// approximate Dota damage classes: attack type x armor type
const CLASS_MULT = {
  hero: { soft: 1, structure: 0.5 },
  basic: { soft: 1, structure: 0.7 },
  pierce: { soft: 1, structure: 0.35 },
  siege: { soft: 1, structure: 2.5, siegecreep: 0.5 },
};
const armorMult = (a) => 1 - (0.06 * a) / (1 + 0.06 * Math.abs(a));
const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

// A hero's combat numbers at a level, with the DotA / Source 1 Dota 2 attribute formulas the stats panel
// uses: 19 HP and 0.03 regen per STR, 1/7 armor and 1% attack speed per AGI, primary attribute adds damage.
export function heroCombatStats(s, level) {
  const n = (k, d = 0) => num(s[k], d), lv = (b, g) => n(b) + n(g) * (level - 1);
  const str = lv('AttributeBaseStrength', 'AttributeStrengthGain'), agi = lv('AttributeBaseAgility', 'AttributeAgilityGain'),
    int = lv('AttributeBaseIntelligence', 'AttributeIntelligenceGain');
  const prim = { STRENGTH: str, AGILITY: agi, INTELLECT: int }[(s.AttributePrimary || '').replace('DOTA_ATTRIBUTE_', '')] || 0;
  const ranged = /RANGED/.test(s.AttackCapabilities || '');
  return {
    maxHp: n('StatusHealth', 150) + str * 19, regen: n('StatusHealthRegen') + str * 0.03,
    armor: n('ArmorPhysical') + agi / 7, dmg: [n('AttackDamageMin') + prim, n('AttackDamageMax') + prim],
    rate: n('AttackRate', 1.7) / (1 + agi / 100), bat: n('AttackRate', 1.7), point: n('AttackAnimationPoint', 0.4),
    range: n('AttackRange', ranged ? 500 : 128), projSpeed: ranged ? n('ProjectileSpeed', 900) : 0,
    speed: n('MovementSpeed', 300), ranged,
    maxMana: n('StatusMana') + int * 13, manaRegen: n('StatusManaRegen') + int * 0.04,
  };
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d'), grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.4, 'rgba(255,255,255,.6)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Battle {
  // deps: spawnActor(unit) -> Promise<Actor|null>, disposeActor(actor), playSound(name, pos[x,y,z], volume),
  //       onEvent(text, kind)
  constructor(view, world, lanes, deps) {
    this.view = view;
    this.world = world;
    this.deps = deps;
    this.lanes = lanes; // e.g. ['mid'] or ['top', 'mid', 'bot']
    this.root = new THREE.Group();
    this.root.rotation.x = -Math.PI / 2;
    this.root.name = 'battle';
    view.scene.add(this.root);
    this.units = [];
    this.projectiles = [];
    this.fx = [];
    this.time = 0;
    this.nextWave = 0;
    this.wave = 0;
    this.kills = { radiant: 0, dire: 0 };
    this.hero = null; // the view's hero once it joins (see addHero)
    this.timers = []; // delayed ability effects: { at, fn }
    this.towersLost = { radiant: 0, dire: 0 };
    this.heights = new Map();
    this.glow = glowTexture();
    this.disposed = false;
    this.barBg = new THREE.SpriteMaterial({ color: 0x000000, depthTest: false, fog: false, transparent: true, opacity: 0.8 });
    this.barMat = { radiant: new THREE.SpriteMaterial({ color: 0x3fd13f, depthTest: false, fog: false }),
      dire: new THREE.SpriteMaterial({ color: 0xd63a2a, depthTest: false, fog: false }) };
    this.addTowers();
  }

  // ground height, cached on a 48-unit grid (a terrain raycast per creep per frame would be too slow)
  heightAt(x, y) {
    const k = `${Math.round(x / 48)},${Math.round(y / 48)}`;
    let z = this.heights.get(k);
    if (z === undefined) { z = this.world.groundZ(Math.round(x / 48) * 48, Math.round(y / 48) * 48, 128); this.heights.set(k, z); }
    return z;
  }

  // ------------------------------------------------------------ units
  makeBar(u, offset) {
    const bg = new THREE.Sprite(this.barBg), fg = new THREE.Sprite(this.barMat[u.team]);
    const w = u.kind === 'tower' ? 150 : 72, h = u.kind === 'tower' ? 14 : 9;
    bg.center.set(0, 0.5); fg.center.set(0, 0.5);
    bg.scale.set(w + 4, h + 4, 1); fg.scale.set(w, h, 1);
    bg.renderOrder = 20; fg.renderOrder = 21;
    const g = new THREE.Group();
    g.add(bg, fg);
    bg.position.set(-(w + 4) / 2, 0, 0); fg.position.set(-w / 2, 0, 0.1);
    u.bar = { g, fg, w, offset };
    this.root.add(g);
  }

  updateBar(u) {
    const b = u.bar;
    if (!b) return;
    b.g.position.set(u.pos[0], u.pos[1], u.pos[2] + b.offset);
    b.fg.scale.x = Math.max(0.001, b.w * (u.hp / u.maxHp));
    b.g.visible = u.state !== 'dead';
  }

  stats(u, s) {
    u.maxHp = u.hp = num(s.StatusHealth, 500);
    u.armor = num(s.ArmorPhysical);
    u.dmg = [num(s.AttackDamageMin, 20), num(s.AttackDamageMax, 25)];
    u.rate = num(s.AttackRate, 1);
    u.point = num(s.AttackAnimationPoint, 0.4);
    u.range = num(s.AttackRange, 100);
    u.acq = Math.max(u.range + 100, num(s.AttackAcquisitionRange, 800));
    u.projSpeed = num(s.ProjectileSpeed, 0);
    u.speed = num(s.MovementSpeed, 0);
    u.soundSet = s.SoundSet || '';
    u.bountyMin = num(s.BountyGoldMin); u.bountyMax = num(s.BountyGoldMax, u.bountyMin);
  }

  addTowers() {
    for (const m of this.world.markers) {
      if (m.kind !== 'tower') continue;
      const lane = (m.name || '').match(/_(top|mid|bot)$/)?.[1];
      if (lane ? !this.lanes.includes(lane) : this.lanes.length < 3) continue;
      const u = { kind: 'tower', team: m.team, pos: [...m.pos], yaw: 0, state: 'idle', cooldown: 0, marker: m, label: m.label, buffs: [] };
      this.stats(u, {});
      Object.assign(u, { maxHp: 1300, hp: 1300, armor: 18, dmg: [100, 120], rate: 1, point: 0.4, range: 700, acq: 700, projSpeed: 750, speed: 0,
        soundSet: m.team === 'radiant' ? 'Tower.Water' : 'Tower.Fire' });
      this.units.push(u);
      this.makeBar(u, 420);
      // the build's own tower stats arrive asynchronously
      const unit = `npc_dota_${m.team === 'radiant' ? 'goodguys' : 'badguys'}_tower${m.tier}${lane ? '_' + lane : ''}`;
      this.deps.unitStats?.(unit).then((s) => { if (s?.StatusHealth) { this.stats(u, s); u.speed = 0; if (!s.SoundSet) u.soundSet = m.team === 'radiant' ? 'Tower.Water' : 'Tower.Fire'; } });
    }
  }

  async spawnCreep(team, kind, lane, route, lateral, back) {
    const side = team === 'radiant' ? 'goodguys' : 'badguys';
    const unit = kind === 'siege' ? `npc_dota_${side}_siege` : `npc_dota_creep_${side}_${kind}`;
    const actor = await this.deps.spawnActor(unit);
    if (!actor || this.disposed) { if (actor) this.deps.disposeActor(actor); return; }
    const u = { kind, team, lane, actor, route, wp: 1, lateral, state: 'walk', cooldown: Math.random() * 0.3, swing: -1, unitName: unit, buffs: [] };
    this.stats(u, actor.stats);
    // start in formation a little behind the first waypoint
    const [a, b] = route;
    const dir = Math.atan2(b[1] - a[1], b[0] - a[0]);
    u.pos = [a[0] - Math.cos(dir) * back - Math.sin(dir) * lateral, a[1] - Math.sin(dir) * back + Math.cos(dir) * lateral, 0];
    u.pos[2] = this.heightAt(u.pos[0], u.pos[1]);
    u.yaw = dir;
    actor.play(/ACT_DOTA_RUN/, /run/i, /walk/i);
    this.root.add(actor.group);
    this.units.push(u);
    const off = num(actor.stats.HealthBarOffset, -1);
    this.makeBar(u, off > 0 ? Math.min(off, 160) : kind === 'siege' ? 150 : 115);
  }

  spawnWave() {
    this.wave++;
    const alive = this.units.filter((u) => u.state !== 'dead' && u.kind !== 'tower').length;
    if (alive > MAX_UNITS) return;
    for (const lane of this.lanes) {
      for (const [team, key] of [['radiant', `${lane}_good`], ['dire', `${lane}_bad`]]) {
        const pts = this.world.lanes[key];
        if (!pts) continue;
        const route = pts.slice(1); // lanes start at the hero spawn; creeps start at the barracks waypoint
        if (route.length < 2) continue;
        const kinds = [['melee', -60, 0], ['melee', 0, 40], ['melee', 60, 0], ['ranged', 0, 160]];
        if (this.wave % 7 === 0) kinds.push(['siege', 0, 300]);
        for (const [kind, lat, back] of kinds) this.spawnCreep(team, kind, lane, route, lat, back);
      }
    }
    this.deps.onEvent?.(`wave ${this.wave}${this.wave % 7 === 0 ? ' — with siege creeps' : ''}`, 'wave');
  }

  // ------------------------------------------------------------ combat
  dist(a, b) { return Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]); }

  acquire(u) {
    let best = null, bd = Infinity, hero = null, heroD = Infinity;
    for (const e of this.units) {
      if (e.team === u.team || e.state === 'dead') continue;
      const d = this.dist(u, e) - RADIUS[e.kind];
      // Dota's aggro rules: creeps and towers fight creeps first and only turn on a hero when no enemy
      // creep is in range (hero-on-hero aggro doesn't arise here: there is only one hero); creeps prefer
      // creeps over buildings
      if (u.kind === 'hero' && e.kind === 'tower') continue; // idle heroes don't wander into towers; order it
      if (e.kind === 'hero' && u.kind !== 'hero') { if (d <= u.acq && d < heroD) { heroD = d; hero = e; } continue; }
      const score = d + (e.kind === 'tower' && u.kind !== 'tower' ? 200 : 0);
      if (d <= u.acq && score < bd) { bd = score; best = e; }
    }
    return best || hero;
  }

  damage(src, dst) {
    if (dst.state === 'dead') return;
    const atk = src.kind === 'hero' ? 'hero' : src.kind === 'ranged' ? 'pierce' : src.kind === 'melee' ? 'basic' : 'siege';
    const def = dst.kind === 'tower' ? 'structure' : dst.kind === 'siege' && src.kind === 'tower' ? 'siegecreep' : 'soft';
    let raw = src.dmg[0] + Math.random() * (src.dmg[1] - src.dmg[0]);
    if (src.kind === 'hero') raw = (raw + this.buffSum(src, 'damage')) * (1 + this.buffSum(src, 'damagePct') / 100);
    dst.hp -= raw * (CLASS_MULT[atk][def] ?? 1) * armorMult(this.armorOf(dst));
    if (src.kind === 'hero') this.heroPassives(src, 'onAttackLanded', dst, raw);
    if (dst.hp <= 0) { this.kill(dst, src); return; }
    if (dst.kind === 'hero') this.onHeroAttacked(dst, src);
  }

  buffSum(u, kind, key = 'amount') { return (u.buffs || []).reduce((s, b) => s + (b.kind === kind && b.until > this.time ? b[key] || 0 : 0), 0); }
  armorOf(u) { return u.armor + this.buffSum(u, 'armor'); }
  speedOf(u) { return u.speed * Math.max(0.2, 1 + (this.buffSum(u, 'slow', 'pct') + this.buffSum(u, 'haste', 'pct')) / 100); }
  stunned(u) { return (u.buffs || []).some((b) => b.kind === 'stun' && b.until > this.time); }
  stun(u, dur) {
    if (u.kind === 'tower' || u.state === 'dead' || dur <= 0) return;
    u.buffs.push({ kind: 'stun', until: this.time + dur });
    u.swing = -1;
    if (u.actor && u.moving) { u.actor.play(/ACT_DOTA_IDLE\b/, /idle/i); u.moving = false; }
    this.deps.floatText?.('✶', u.pos, 'stun');
  }
  // passives of the hero's abilities: onAttackLanded(target, damage), onCast(ability), onKill(victim)
  heroPassives(h, hook, ...args) {
    for (const a of h.ctl.abilities || []) {
      const spec = ABILITIES[a.name], L = h.ctl.abilityLevel(a);
      if (spec?.[hook] && L > 0) spec[hook].call(spec, this, h, a, L, ...args);
    }
  }
  after(seconds, fn) { this.timers.push({ at: this.time + seconds, fn }); }
  // a buff that is refreshed rather than stacked (auras, stacking counters)
  setBuff(u, key, buff) { u.buffs = u.buffs.filter((b) => b.key !== key); u.buffs.push({ ...buff, key }); }
  getBuff(u, key) { return u.buffs.find((b) => b.key === key && b.until > this.time); }

  // spell damage: physical is reduced by armor, magical by magic resistance (creeps have none; heroes 25 %),
  // pure is not reduced; buildings are immune to spells
  spellDamage(src, dst, amount, type = 'magical') {
    if (dst.state === 'dead' || dst.kind === 'tower') return;
    const mult = type === 'physical' ? armorMult(this.armorOf(dst)) : type === 'magical' && dst.kind === 'hero' ? 0.75 : 1;
    dst.hp -= amount * mult;
    if (dst.hp <= 0) this.kill(dst, src);
  }

  onHeroAttacked(h, src) {
    for (const a of h.ctl.abilities || []) {
      const spec = ABILITIES[a.name], L = h.ctl.abilityLevel(a);
      if (spec?.onAttacked && L > 0) spec.onAttacked.call(spec, this, h, a, L, src);
    }
  }

  kill(u, by) {
    u.hp = 0;
    u.state = 'dead';
    u.deadT = 0;
    if (u.kind === 'hero') { this.heroDied(u, by); return; }
    if (u.team !== by.team) this.kills[by.team]++;
    if (by.kind === 'hero' && u.team !== by.team) this.heroPassives(by, 'onKill', u);
    // Dota gives gold only for a hero's last hit; creeps killing creeps earn nobody anything
    if (by.kind === 'hero' && u.kind !== 'tower') {
      if (u.team !== by.team) {
        const g = Math.round(u.bountyMin + Math.random() * (u.bountyMax - u.bountyMin));
        by.lastHits++; by.gold += g;
        this.deps.floatText?.(`+${g}`, u.pos, 'gold');
      } else { by.denies++; this.deps.floatText?.('!', u.pos, 'deny'); }
    }
    if (u.kind === 'tower') {
      this.towersLost[u.team]++;
      this.hideTowerProp(u.pos);
      this.burst(u.pos, 0xffb070, 40, 260, 400);
      this.deps.playSound?.('Building_Generic.Destruction', u.pos, 1);
      this.deps.onEvent?.(`${u.label} destroyed`, 'tower');
    } else {
      u.actor.playOnce(/ACT_DOTA_DIE/, /death/i, /die/i);
      if (u.kind === 'siege') this.deps.playSound?.(`Creep_Siege_${u.team === 'radiant' ? 'Radiant' : 'Dire'}.Destruction`, u.pos, 0.8);
    }
    this.updateBar(u);
  }

  // the tower model is part of the map's instanced props: collapse its instance
  hideTowerProp(pos) {
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this.view.worldObj?.traverse((o) => {
      if (!o.isInstancedMesh || !/tower/.test(o.name)) return;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        p.setFromMatrixPosition(m);
        if (Math.hypot(p.x - pos[0], p.y - pos[1]) < 120) { o.setMatrixAt(i, zero); o.instanceMatrix.needsUpdate = true; }
      }
    });
  }

  fire(u, t) {
    const muzzle = [u.pos[0], u.pos[1], u.pos[2] + (u.kind === 'tower' ? 330 : u.kind === 'siege' ? 90 : u.kind === 'hero' ? 110 : 70)];
    if (u.kind === 'tower') this.deps.playSound?.(`${u.soundSet}.Attack`, u.pos, 0.9);
    if (u.kind === 'melee' || !u.projSpeed) { this.damage(u, t); return; }
    const color = u.kind === 'tower' ? (u.team === 'radiant' ? 0x8fd8ff : 0xff8a3a) : u.kind === 'hero' ? 0xfff0a0 : u.team === 'radiant' ? 0xb8ff7a : 0xff5a3a;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    s.scale.setScalar(u.kind === 'tower' ? 90 : u.kind === 'siege' ? 70 : 40);
    s.position.set(...muzzle);
    this.root.add(s);
    this.projectiles.push({ s, src: u, dst: t, speed: u.projSpeed });
  }

  burst(pos, color, count, speed, size) {
    const sprites = [];
    for (let i = 0; i < count; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
      s.position.set(pos[0], pos[1], pos[2] + 120);
      s.userData.v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() * 0.8).normalize().multiplyScalar(speed * (0.4 + Math.random()));
      s.scale.setScalar(size * (0.4 + Math.random() * 0.6));
      this.root.add(s);
      sprites.push(s);
    }
    this.fx.push({ sprites, age: 0, life: 1.4 });
  }

  // ------------------------------------------------------------ per frame
  update(dt) {
    if (this.disposed || dt <= 0) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    if (this.time >= this.nextWave) { this.nextWave = this.time + WAVE_INTERVAL; this.spawnWave(); }

    this.tickBuffs(dt);
    for (const t of this.timers.filter((q) => q.at <= this.time)) t.fn();
    this.timers = this.timers.filter((q) => q.at > this.time);
    if (this.hero) this.updateHero(this.hero, dt);
    for (const u of this.units) {
      if (u.kind === 'hero') continue;
      if (u.state === 'dead') {
        u.deadT += dt;
        if (u.actor) {
          if (u.deadT > 2) u.pos[2] -= 30 * dt; // sink into the ground like Dota corpses
          u.actor.group.position.set(...u.pos);
        }
        continue;
      }
      u.cooldown -= dt;
      if (this.stunned(u)) { u.swing = -1; continue; }
      const taunt = u.buffs.find((b) => b.kind === 'taunt' && b.until > this.time && b.by.state !== 'dead');
      if (taunt) u.target = taunt.by;
      // a hero is only a fallback target: look again for creeps every frame while attacking one
      else if (!u.target || u.target.state === 'dead' || u.target.kind === 'hero' || this.dist(u, u.target) > u.acq * 1.25) u.target = this.acquire(u);
      const t = u.target;
      if (u.swing >= 0) {
        // mid-swing: the hit lands at the attack point; a dead target cancels the swing
        u.swing += dt;
        if (!t || t.state === 'dead') u.swing = -1;
        else if (u.swing >= u.point) { u.swing = -1; this.fire(u, t); }
      } else if (t) {
        const reach = u.range + RADIUS[u.kind] + RADIUS[t.kind];
        if (this.dist(u, t) > reach) { if (u.speed) this.moveToward(u, t.pos, dt); }
        else {
          u.yaw = Math.atan2(t.pos[1] - u.pos[1], t.pos[0] - u.pos[0]);
          if (u.cooldown <= 0) {
            u.cooldown = u.rate;
            u.swing = 0;
            if (u.actor) { u.actor.playThen([/ACT_DOTA_ATTACK\b/, /attack/i], [/ACT_DOTA_IDLE\b/, /idle/i]); u.moving = false; }
          } else if (u.actor && u.moving) { u.actor.play(/ACT_DOTA_IDLE\b/, /idle/i); u.moving = false; }
        }
      } else if (u.speed && u.route) {
        // march down the lane
        const wp = u.route[u.wp];
        if (!wp) { if (u.moving) { u.actor.play(/ACT_DOTA_IDLE\b/, /idle/i); u.moving = false; } }
        else {
          const dir = Math.atan2(u.route[u.wp][1] - u.route[u.wp - 1][1], u.route[u.wp][0] - u.route[u.wp - 1][0]);
          const goal = [wp[0] - Math.sin(dir) * u.lateral, wp[1] + Math.cos(dir) * u.lateral];
          if (Math.hypot(goal[0] - u.pos[0], goal[1] - u.pos[1]) < 90) u.wp++;
          else this.moveToward(u, goal, dt);
        }
      }
    }
    this.separate(dt);
    if (this.hero && this.hero.state !== 'dead') this.hero.ctl.setPos(this.hero.pos, this.hero.yaw);
    for (const u of this.units) {
      if (u.state !== 'dead' && u.actor) {
        u.actor.group.position.set(...u.pos);
        // turn smoothly
        let d = u.yaw - (u.drawYaw ?? u.yaw); d = Math.atan2(Math.sin(d), Math.cos(d));
        u.drawYaw = (u.drawYaw ?? u.yaw) + d * Math.min(1, dt * 10);
        u.actor.group.rotation.set(0, 0, u.drawYaw);
      }
      this.updateBar(u);
    }

    // projectiles home in on their target
    for (const p of this.projectiles) {
      const tp = p.dst.pos, target = new THREE.Vector3(tp[0], tp[1], tp[2] + (p.dst.kind === 'tower' ? 200 : 60));
      const to = target.clone().sub(p.s.position), step = p.speed * dt;
      if (to.length() <= step) {
        p.done = true;
        this.damage(p.src, p.dst);
        if (p.src.kind !== 'tower') this.deps.playSound?.(`${p.src.soundSet}.ProjectileImpact`, tp, 0.6);
      } else p.s.position.addScaledVector(to.normalize(), step);
    }
    for (const p of this.projectiles.filter((q) => q.done)) { this.root.remove(p.s); p.s.material.dispose(); }
    this.projectiles = this.projectiles.filter((q) => !q.done);

    for (const f of this.fx) {
      f.age += dt;
      for (const s of f.sprites) { s.position.addScaledVector(s.userData.v, dt); s.material.opacity = Math.max(0, 1 - f.age / f.life); }
    }
    for (const f of this.fx.filter((q) => q.age >= q.life)) for (const s of f.sprites) { this.root.remove(s); s.material.dispose(); }
    this.fx = this.fx.filter((q) => q.age < q.life);

    // corpses that have sunk are removed for good
    for (const u of this.units.filter((q) => q.state === 'dead' && q.actor && q.deadT > 5)) this.removeUnit(u);
    for (const u of this.units) if (u.actor && u.state !== 'dead') u.actor.update(dt);
    for (const u of this.units) if (u.actor && u.state === 'dead') u.actor.update(dt);
  }

  // damage over time, auras (Blade Fury, Rot) and expiry of timed buffs
  tickBuffs(dt) {
    for (const u of [...this.units]) {
      if (u.state === 'dead' || !u.buffs?.length) continue;
      for (const b of u.buffs) {
        if (b.until <= this.time) continue;
        if (b.kind === 'dot') this.spellDamage(b.by, u, b.dps * dt, b.type);
        if (b.kind === 'aura') {
          for (const e of this.units.filter((x) => x.team !== u.team && x.state !== 'dead' && x.kind !== 'tower'
            && Math.hypot(x.pos[0] - u.pos[0], x.pos[1] - u.pos[1]) <= b.radius)) {
            this.spellDamage(u, e, b.dps * dt, b.type);
            if (b.slow) this.setBuff(e, 'aura-slow', { kind: 'slow', pct: b.slow, until: this.time + 0.3 });
          }
          if (b.selfDamage) this.spellDamage(u, u, b.dps * dt, b.type);
          if (b.spin && u.kind === 'hero') u.spinFx = (u.spinFx || 0) + dt;
        }
        if (u.state === 'dead') break;
      }
      u.buffs = u.buffs.filter((b) => b.until > this.time);
    }
  }

  moveToward(u, goal, dt) {
    const dx = goal[0] - u.pos[0], dy = goal[1] - u.pos[1], d = Math.hypot(dx, dy) || 1;
    const step = Math.min(d, this.speedOf(u) * dt);
    u.pos[0] += (dx / d) * step; u.pos[1] += (dy / d) * step;
    u.pos[2] = this.heightAt(u.pos[0], u.pos[1]);
    u.yaw = Math.atan2(dy, dx);
    if (u.actor && !u.moving && u.swing < 0) { u.actor.play(/ACT_DOTA_RUN/, /run/i, /walk/i); u.moving = true; }
  }

  // keep creeps from standing inside each other
  separate(dt) {
    const live = this.units.filter((u) => u.state !== 'dead');
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      const min = RADIUS[a.kind] + RADIUS[b.kind];
      const dx = b.pos[0] - a.pos[0], dy = b.pos[1] - a.pos[1], d = Math.hypot(dx, dy);
      if (d >= min || d === 0) continue;
      const push = (min - d) * Math.min(1, dt * 8) / d;
      const wa = a.kind === 'tower' ? 0 : b.kind === 'tower' ? 1 : 0.5, wb = 1 - wa;
      a.pos[0] -= dx * push * wa; a.pos[1] -= dy * push * wa;
      b.pos[0] += dx * push * wb; b.pos[1] += dy * push * wb;
    }
  }

  removeUnit(u) {
    this.units = this.units.filter((q) => q !== u);
    if (u.actor) { this.root.remove(u.actor.group); this.deps.disposeActor(u.actor); }
    if (u.bar) this.root.remove(u.bar.g);
    for (const o of this.units) if (o.target === u) o.target = null;
  }

  summary() {
    const live = (team) => this.units.filter((u) => u.team === team && u.state !== 'dead' && u.kind !== 'tower' && u.kind !== 'hero').length;
    return { wave: this.wave, next: Math.max(0, Math.ceil(this.nextWave - this.time)), time: this.time,
      radiant: live('radiant'), dire: live('dire'), kills: { ...this.kills }, towersLost: { ...this.towersLost },
      hero: this.hero && { team: this.hero.team, hp: this.hero.hp, maxHp: this.hero.maxHp, lastHits: this.hero.lastHits, denies: this.hero.denies,
        gold: this.hero.gold, dead: this.hero.state === 'dead', respawn: Math.max(0, Math.ceil(this.hero.respawnAt - this.time)),
        level: this.hero.level, stats: this.hero.combat, mana: this.hero.mana, maxMana: this.hero.maxMana } };
  }

  // ------------------------------------------------------------ the player's hero
  // ctl: { stats (npc_heroes entry), getLevel(), getPos() -> Source xyz, setPos(p, yaw), playRun(), playIdle(),
  //        playAttack(), playDeath(), home: { radiant: xyz, dire: xyz } }
  addHero(team, ctl) {
    this.removeHero();
    const u = { kind: 'hero', team, ctl, pos: ctl.getPos(), yaw: 0, state: 'idle', cooldown: 0, swing: -1, order: null,
      lastHits: 0, denies: 0, gold: 0, level: 0, respawnAt: 0, unitName: 'hero', soundSet: ctl.stats.SoundSet || '',
      buffs: [], cd: {}, mana: 0, maxMana: 0 };
    this.hero = u;
    this.restatHero(u, true);
    this.units.push(u);
    this.makeBar(u, 230);
    ctl.playIdle();
  }

  removeHero() {
    const u = this.hero;
    if (!u) return;
    this.hero = null;
    this.units = this.units.filter((q) => q !== u);
    if (u.bar) this.root.remove(u.bar.g);
    for (const o of this.units) if (o.target === u) o.target = null;
  }

  // stats follow the level slider; health keeps its fraction
  restatHero(u, full = false) {
    const L = u.ctl.getLevel(), c = heroCombatStats(u.ctl.stats, L), frac = full ? 1 : u.hp / u.maxHp;
    const mfrac = full || !u.maxMana ? 1 : u.mana / u.maxMana;
    u.maxMana = c.maxMana; u.mana = c.maxMana * mfrac;
    Object.assign(u, { combat: c, maxHp: c.maxHp, armor: c.armor, dmg: c.dmg, rate: c.rate, point: c.point, range: c.range,
      projSpeed: c.projSpeed, speed: c.speed, acq: HERO_ACQUIRE, level: L });
    u.hp = u.maxHp * frac;
  }

  // a right-click: on an enemy = attack, on an own creep below half health = deny, on the ground = move
  order(o) {
    const u = this.hero;
    if (!u || u.state === 'dead') return false;
    if (o.type === 'attack') {
      const t = o.target;
      if (t.state === 'dead' || t === u) return false;
      if (t.team === u.team && (t.kind === 'tower' || t.hp >= t.maxHp * 0.5)) {
        this.deps.onEvent?.(t.kind === 'tower' ? "can't attack your own tower" : 'can only deny creeps below 50% health', 'info');
        return false;
      }
    }
    u.order = o;
    u.guard = null; u.returning = false;
    u.target = o.type === 'attack' ? o.target : null;
    u.swing = -1;
    return true;
  }

  heroDied(u, by) {
    u.state = 'dead';
    u.order = null; u.target = null; u.swing = -1;
    // DotA / 2011 Dota 2 respawn time: 4 s per level
    u.respawnAt = this.time + 4 * u.level;
    u.anim = 'death';
    u.ctl.playDeath();
    this.heroPassives(u, 'onDeath');
    this.deps.onEvent?.(`your hero was killed by ${by === u ? 'its own Rot' : by.kind === 'tower' ? 'a tower' : 'a creep'} — respawn in ${4 * u.level} s at the fountain`, 'tower');
    this.updateBar(u);
  }

  updateHero(u, dt) {
    if (u.level !== u.ctl.getLevel()) this.restatHero(u);
    if (u.state === 'dead') {
      if (this.time >= u.respawnAt) {
        u.state = 'idle';
        u.hp = u.maxHp;
        u.pos = [...u.ctl.home[u.team]];
        u.ctl.setPos(u.pos, u.yaw);
        u.anim = null;
        this.heroIdle(u);
        this.deps.onEvent?.('respawned at the fountain', 'info');
      }
      return;
    }
    u.hp = Math.min(u.maxHp, u.hp + u.combat.regen * dt);
    u.mana = Math.min(u.maxMana, u.mana + u.combat.manaRegen * dt);
    for (const k in u.cd) u.cd[k] = Math.max(0, u.cd[k] - dt);
    u.cooldown -= dt;
    const o = u.order;
    this.heroPassives(u, 'onTick', dt);
    if (this.stunned(u)) return;
    if (o?.type === 'cast') { this.stepCast(u, o, dt); return; }
    const noAttack = u.buffs.some((b) => b.noAttack && b.until > this.time);
    if (o?.type === 'move') {
      if (Math.hypot(o.pos[0] - u.pos[0], o.pos[1] - u.pos[1]) < 12) { u.order = null; this.heroIdle(u); }
      else this.heroMove(u, o.pos, dt);
      return;
    }
    if (o?.type === 'attack' && o.target.state === 'dead') { u.order = null; u.target = null; }
    // idle heroes auto-attack enemies that come close (never their own creeps)
    if (!u.order && !u.returning && (!u.target || u.target.state === 'dead' || this.dist(u, u.target) > u.acq * 1.25)) {
      u.target = this.acquire(u);
      if (u.target && !u.guard) u.guard = [...u.pos];
    }
    // auto-attack has a leash: an idle hero won't chase more than ~350 units from where it stood
    if (!u.order && u.guard) {
      if (u.target && Math.hypot(u.pos[0] - u.guard[0], u.pos[1] - u.guard[1]) > 350) { u.target = null; u.returning = true; u.swing = -1; }
      if (!u.target) {
        if (Math.hypot(u.pos[0] - u.guard[0], u.pos[1] - u.guard[1]) > 20) { this.heroMove(u, u.guard, dt); return; }
        u.guard = null; u.returning = false;
      }
    }
    const t = u.target;
    if (u.swing >= 0) {
      u.swing += dt;
      if (!t || t.state === 'dead') { u.swing = -1; this.heroIdle(u); }
      else if (u.swing >= u.point) { u.swing = -1; this.fire(u, t); }
      return;
    }
    if (!t || noAttack) { if (noAttack && o?.type !== 'move') u.target = null; this.heroIdle(u); return; }
    const reach = u.range + RADIUS.hero + RADIUS[t.kind];
    if (this.dist(u, t) > reach) { this.heroMove(u, t.pos, dt); return; }
    u.yaw = Math.atan2(t.pos[1] - u.pos[1], t.pos[0] - u.pos[0]);
    if (u.cooldown <= 0) {
      // attack speed bonuses (Fiery Soul) add to agility's attack speed: BAT / (1 + (agi + bonus) / 100)
      const ias = this.buffSum(u, 'attackSpeed');
      u.cooldown = ias ? u.combat.bat / (u.combat.bat / u.rate + ias / 100) : u.rate;
      u.swing = 0; u.anim = 'attack'; u.ctl.playAttack();
    }
    else this.heroIdle(u);
  }

  spinning(u) { return u.buffs.some((b) => b.spin && b.until > this.time); }

  // ------------------------------------------------------------ abilities
  // what the HUD should show for an ability: simulated? learned? castable?
  abilityState(a) {
    const h = this.hero, spec = ABILITIES[a.name];
    if (!h) return null;
    const L = h.ctl.abilityLevel(a);
    return { sim: !!spec, level: L, cd: h.cd[a.name] || 0, mana: abilityValue(a, 'AbilityManaCost', Math.max(1, L), 0),
      active: !!h.buffs.find((b) => b.kind === 'aura' && (b.name === 'rot' ? a.name === 'pudge_rot' : spec?.cast && a.name === 'juggernaut_blade_fury') && b.until > this.time) };
  }

  // HUD key / click. Returns 'target' when the ability needs a target picked first.
  cast(a, target = null, point = null) {
    const h = this.hero;
    if (!h || h.state === 'dead') return false;
    const spec = ABILITIES[a.name], L = h.ctl.abilityLevel(a);
    const say = (t) => { this.deps.onEvent?.(t, 'info'); return false; };
    if (!spec) return say(`${a.title}: not simulated — what it does was server code that never shipped`);
    if (spec.passive) return say(`${a.title} is passive: it triggers by itself`);
    if (L < 1) return say(`${a.title} isn't learned yet${/ULTIMATE/.test(a.AbilityType || '') || a.slot === 4 ? ' (ultimates from level 6)' : ''}`);
    if ((h.cd[a.name] || 0) > 0) return say(`${a.title} is on cooldown (${Math.ceil(h.cd[a.name])}s)`);
    const mana = abilityValue(a, 'AbilityManaCost', L, 0);
    if (!spec.toggle && h.mana < mana) return say(`not enough mana for ${a.title} (${mana} needed)`);
    if (spec.heroesOnly) return say(`${a.title} only hits enemy heroes — there are none in a creep battle`);
    if (spec.target === 'unit') {
      if (!target) return 'target';
      if (target.team === h.team || target.kind === 'tower' || target.state === 'dead') return say(`${a.title} needs an enemy creep as its target`);
    }
    if (spec.target === 'point' && !point) return 'point';
    h.order = { type: 'cast', a, L, spec, target, point, wind: -1 };
    h.target = null; h.swing = -1; h.guard = null; h.returning = false;
    return true;
  }

  // walk into cast range, wind up for the cast point, then the effect lands
  stepCast(u, o, dt) {
    if (o.target && o.target.state === 'dead') { u.order = null; return; }
    if (o.wind < 0) {
      const goal = o.target ? o.target.pos : o.point;
      if (goal) {
        const range = abilityValue(o.a, 'AbilityCastRange', o.L, 150) + RADIUS.hero + (o.target ? RADIUS[o.target.kind] : 0);
        if (Math.hypot(goal[0] - u.pos[0], goal[1] - u.pos[1]) > range) { this.heroMove(u, goal, dt); return; }
        u.yaw = Math.atan2(goal[1] - u.pos[1], goal[0] - u.pos[0]);
      }
      o.wind = 0;
      u.anim = 'cast';
      u.ctl.playCast(o.a);
    }
    o.wind += dt;
    if (o.wind < abilityValue(o.a, 'AbilityCastPoint', o.L, 0.3)) return;
    const mana = abilityValue(o.a, 'AbilityManaCost', o.L, 0), cd = abilityValue(o.a, 'AbilityCooldown', o.L, 0);
    u.order = null;
    if (!o.spec.toggle) { u.mana -= mana; u.cd[o.a.name] = cd; }
    if (o.spec.sound) this.deps.playSound?.(o.spec.sound, u.pos, 1);
    const result = o.spec.cast(this, u, o.a, o.L, o.target, o.point);
    this.deps.onEvent?.(`${o.a.title} (level ${o.L}): ${result}`, 'cast');
    this.heroPassives(u, 'onCast', o.a);
    u.cooldown = Math.max(u.cooldown, 0.3);
    u.castEnd = this.time + 0.5;
  }

  heroMove(u, goal, dt) {
    const dx = goal[0] - u.pos[0], dy = goal[1] - u.pos[1], d = Math.hypot(dx, dy) || 1, step = Math.min(d, this.speedOf(u) * dt);
    u.pos[0] += (dx / d) * step; u.pos[1] += (dy / d) * step;
    u.pos[2] = this.heightAt(u.pos[0], u.pos[1]);
    u.yaw = Math.atan2(dy, dx);
    if (u.anim !== 'run' && !this.spinning(u)) { u.anim = 'run'; u.ctl.playRun(); }
  }

  heroIdle(u) {
    if (this.time < (u.castEnd || 0) || this.spinning(u)) return; // let a cast / Blade Fury animation play out
    // let an attack animation finish its backswing before idling
    if (u.anim === 'attack' && u.cooldown > u.rate - 0.45) return;
    if (u.anim !== 'idle') { u.anim = 'idle'; u.ctl.playIdle(); }
  }

  dispose() {
    this.disposed = true;
    this.removeHero();
    for (const u of [...this.units]) this.removeUnit(u);
    for (const p of this.projectiles) p.s.material.dispose();
    for (const f of this.fx) for (const s of f.sprites) s.material.dispose();
    this.view.scene.remove(this.root);
    this.barBg.dispose(); this.barMat.radiant.dispose(); this.barMat.dire.dispose();
    this.glow.dispose();
    // bring destroyed towers back for the next visit
    if (this.towersLost.radiant + this.towersLost.dire) this.view.restoreWorldProps?.();
  }
}
