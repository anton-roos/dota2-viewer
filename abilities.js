// Hand-written ability effects for lane battles.
// What a spell *does* was server code that never shipped with the 2011 builds, so each effect below is
// written by hand from Dota's documented behaviour. Every number it uses (damage, radius, duration,
// kill threshold, proc chance, cooldown, mana cost, cast point, cast range) is read from the build's own
// npc_abilities data at the hero's current ability level, so January 2011 Axe and 6.84 Axe differ the way
// the files say they do. Abilities not listed here are reported as "not simulated".

// a value of ability `a` at level L: a top-level KV field (AbilityDamage…) or a special (kill_threshold…)
export function abilityValue(a, key, L, fallback = 0) {
  const raw = a[key] ?? a.specials?.find((s) => s.key === key)?.value;
  if (raw === undefined || raw === '') return fallback;
  const vals = String(raw).trim().split(/\s+/).map(Number);
  const v = vals[Math.max(0, Math.min(vals.length - 1, L - 1))];
  return Number.isFinite(v) ? v : fallback;
}

// the ability's damage type; 2011 files don't name one, so the Dota default for that spell is passed in
const damageType = (a, fallback = 'magical') => (/PHYSICAL/.test(a.AbilityUnitDamageType || '') ? 'physical'
  : /MAGICAL/.test(a.AbilityUnitDamageType || '') ? 'magical' : /PURE/.test(a.AbilityUnitDamageType || '') ? 'pure' : fallback);

// enemies of `h` within `radius` that spells can affect (buildings are immune to spells in Dota)
function enemiesNear(b, h, radius) { return enemiesAround(b, h.team, h.pos, radius); }
function enemiesAround(b, team, pos, radius) {
  return b.units.filter((u) => u.team !== team && u.state !== 'dead' && u.kind !== 'tower'
    && Math.hypot(u.pos[0] - pos[0], u.pos[1] - pos[1]) <= radius);
}
// enemies inside a line from `from` toward `to`, `length` long, widening from w0 to w1
function enemiesInLine(b, team, from, to, length, w0, w1) {
  const dx = to[0] - from[0], dy = to[1] - from[1], d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
  return b.units.filter((u) => {
    if (u.team === team || u.state === 'dead' || u.kind === 'tower') return false;
    const rx = u.pos[0] - from[0], ry = u.pos[1] - from[1], t = rx * ux + ry * uy;
    if (t < 0 || t > length) return false;
    return Math.abs(rx * uy - ry * ux) <= (w0 + (w1 - w0) * (t / length)) / 2;
  });
}

export const ABILITIES = {
  // Taunt: nearby enemies are forced to attack Axe for the duration; Axe gains bonus armor.
  axe_berserkers_call: {
    target: 'none',
    sound: 'Hero_Axe.Berserkers_Call',
    cast(b, h, a, L) {
      const radius = abilityValue(a, 'radius', L, 300), dur = abilityValue(a, 'duration', L, 2);
      const hit = enemiesNear(b, h, radius);
      for (const u of hit) u.buffs.push({ kind: 'taunt', by: h, until: b.time + dur });
      h.buffs.push({ kind: 'armor', amount: abilityValue(a, 'bonus_armor', L, 0), until: b.time + dur });
      b.deps.fx?.('spin', h.pos, 0xff5a20);
      return `${hit.length} taunted for ${dur}s, +${abilityValue(a, 'bonus_armor', L, 0)} armor`;
    },
  },
  // Damage over time and a slow on one enemy.
  axe_battle_hunger: {
    target: 'unit',
    sound: 'Hero_Axe.Battle_Hunger',
    cast(b, h, a, L, t) {
      const dur = abilityValue(a, 'duration', L, 10), dps = abilityValue(a, 'AbilityDamage', L, 15);
      t.buffs.push({ kind: 'dot', dps, type: damageType(a), by: h, until: b.time + dur, name: 'battle_hunger' });
      t.buffs.push({ kind: 'slow', pct: abilityValue(a, 'slow', L, -10), until: b.time + dur });
      return `${dps} damage/s for ${dur}s`;
    },
  },
  // Passive: when Axe is attacked, a chance to spin and hit every enemy around him.
  axe_counter_helix: {
    passive: true,
    sound: 'Hero_Axe.CounterHelix',
    onAttacked(b, h, a, L) {
      if ((h.cd.axe_counter_helix || 0) > 0) return;
      if (Math.random() * 100 >= abilityValue(a, 'trigger_chance', L, 17)) return;
      h.cd.axe_counter_helix = abilityValue(a, 'cooldown', L, abilityValue(a, 'AbilityCooldown', L, 0.5));
      const dmg = abilityValue(a, 'AbilityDamage', L, 100), radius = abilityValue(a, 'radius', L, 275);
      for (const u of enemiesNear(b, h, radius)) b.spellDamage(h, u, dmg, damageType(a, 'pure'));
      h.ctl.playNamed?.(/counter_helix|helix/i);
      b.deps.fx?.('spin', h.pos, 0xff3a10);
      b.deps.playSound?.(this.sound, h.pos, 0.9);
    },
  },
  // Execute: an enemy below the kill threshold dies outright, otherwise it takes the damage.
  axe_culling_blade: {
    target: 'unit',
    cast(b, h, a, L, t) {
      const threshold = abilityValue(a, 'kill_threshold', L, 300);
      const dmg = abilityValue(a, 'damage', L, abilityValue(a, 'AbilityDamage', L, 150));
      if (t.hp <= threshold) {
        const hp = Math.ceil(t.hp);
        b.deps.playSound?.('Hero_Axe.Culling_Blade_Success', t.pos, 1);
        b.deps.floatText?.('CULLED', t.pos, 'cull');
        b.spellDamage(h, t, t.hp + 1, 'pure');
        return `executed (${hp} ≤ ${threshold} HP threshold)`;
      }
      b.deps.playSound?.('Hero_Axe.Culling_Blade_Fail', t.pos, 1);
      const before = t.hp;
      b.spellDamage(h, t, dmg, damageType(a));
      return `above the ${threshold} HP threshold: ${Math.round(before - Math.max(0, t.hp))} damage`;
    },
  },
  // Spin for the duration, damaging enemies around; Juggernaut can still move but not attack.
  juggernaut_blade_fury: {
    target: 'none',
    sound: 'Hero_Juggernaut.BladeFuryStart',
    cast(b, h, a, L) {
      const dur = abilityValue(a, 'AbilityDuration', L, 5);
      h.buffs.push({ kind: 'aura', dps: abilityValue(a, 'AbilityDamage', L, 80), radius: abilityValue(a, 'blade_fury_radius', L, 250),
        type: damageType(a), until: b.time + dur, noAttack: true, spin: true });
      return `${abilityValue(a, 'AbilityDamage', L, 80)} damage/s in ${abilityValue(a, 'blade_fury_radius', L, 250)} radius for ${dur}s`;
    },
  },
  // Toggle: damages and slows enemies around Pudge — and Pudge himself.
  pudge_rot: {
    toggle: true,
    sound: 'Hero_Pudge.Rot',
    cast(b, h, a, L) {
      const on = h.buffs.find((x) => x.kind === 'aura' && x.name === 'rot');
      if (on) { h.buffs = h.buffs.filter((x) => x !== on); return 'off'; }
      h.buffs.push({ kind: 'aura', name: 'rot', dps: abilityValue(a, 'AbilityDamage', L, 25), radius: abilityValue(a, 'rot_radius', L, 250),
        type: damageType(a), until: Infinity, selfDamage: true, slow: abilityValue(a, 'rot_slow', L, -20) });
      return `on — ${abilityValue(a, 'AbilityDamage', L, 25)} damage/s around Pudge, including Pudge`;
    },
  },

  // ---- Sven
  // A hammer flies to the target; on impact everything around it is damaged and stunned.
  sven_storm_bolt: {
    target: 'unit',
    sound: 'Hero_Sven.StormBolt',
    cast(b, h, a, L, t) {
      const dmg = abilityValue(a, 'AbilityDamage', L, 100), aoe = abilityValue(a, 'bolt_aoe', L, 255), stun = abilityValue(a, 'bolt_stun_duration', L, 2);
      const travel = b.dist(h, t) / abilityValue(a, 'bolt_speed', L, 1000);
      b.after(travel, () => {
        b.deps.fx?.('flash', t.pos);
        b.deps.playSound?.('Hero_Sven.StormBoltImpact', t.pos, 1);
        for (const u of enemiesAround(b, h.team, t.pos, aoe)) { b.spellDamage(h, u, dmg, damageType(a)); b.stun(u, stun); }
      });
      return `${dmg} damage and a ${stun}s stun in ${aoe} radius`;
    },
  },
  // Passive: each attack also hits enemies around the target for a share of its damage.
  sven_great_cleave: {
    passive: true,
    onAttackLanded(b, h, a, L, target, raw) {
      if (h.combat.ranged) return;
      const pct = abilityValue(a, 'great_cleave_damage', L, 20), r = abilityValue(a, 'great_cleave_radius', L, 200);
      for (const u of enemiesAround(b, h.team, target.pos, r)) if (u !== target) b.spellDamage(h, u, raw * pct / 100, 'pure');
    },
  },
  // Sven and nearby allies gain armor and move speed.
  sven_warcry: {
    target: 'none',
    sound: 'Hero_Sven.WarCry',
    cast(b, h, a, L) {
      const dur = abilityValue(a, 'AbilityDuration', L, abilityValue(a, 'duration', L, 6)), r = abilityValue(a, 'warcry_radius', L, 700);
      const armor = abilityValue(a, 'warcry_armor', L, 3), ms = abilityValue(a, 'warcry_movespeed', L, 12);
      const allies = b.units.filter((u) => u.team === h.team && u.state !== 'dead' && u.kind !== 'tower' && Math.hypot(u.pos[0] - h.pos[0], u.pos[1] - h.pos[1]) <= r);
      for (const u of allies) { b.setBuff(u, 'warcry', { kind: 'armor', amount: armor, until: b.time + dur }); b.setBuff(u, 'warcry-ms', { kind: 'haste', pct: ms, until: b.time + dur }); }
      b.deps.fx?.('spin', h.pos);
      return `+${armor} armor and +${ms}% move speed for ${allies.length} allies, ${dur}s`;
    },
  },
  // Bonus damage for the duration.
  sven_gods_strength: {
    target: 'none',
    sound: 'Hero_Sven.GodsStrength',
    cast(b, h, a, L) {
      const dur = abilityValue(a, 'AbilityDuration', L, 25), pct = abilityValue(a, 'gods_strength_damage', L, 100);
      b.setBuff(h, 'gods_strength', { kind: 'damagePct', amount: pct, until: b.time + dur });
      b.deps.fx?.('magic', h.pos);
      return `+${pct}% damage for ${dur}s`;
    },
  },

  // ---- Lina
  // A wave of fire along a line toward the target point.
  lina_dragon_slave: {
    target: 'point',
    sound: 'Hero_Lina.DragonSlave',
    cast(b, h, a, L, t, p) {
      const len = abilityValue(a, 'dragon_slave_distance', L, 975), speed = abilityValue(a, 'dragon_slave_speed', L, 1200);
      const w0 = abilityValue(a, 'dragon_slave_width_initial', L, abilityValue(a, 'dragon_slave_width', L, 275));
      const w1 = abilityValue(a, 'dragon_slave_width_end', L, w0), dmg = abilityValue(a, 'AbilityDamage', L, 100);
      const from = [...h.pos], hit = enemiesInLine(b, h.team, from, p, len, w0, w1);
      for (const u of hit) b.after(Math.hypot(u.pos[0] - from[0], u.pos[1] - from[1]) / speed, () => b.spellDamage(h, u, dmg, damageType(a)));
      const d = Math.hypot(p[0] - from[0], p[1] - from[1]) || 1;
      for (let k = 1; k <= 5; k++) {
        const q = [from[0] + (p[0] - from[0]) / d * len * k / 5, from[1] + (p[1] - from[1]) / d * len * k / 5, from[2]];
        b.after(len * k / 5 / speed, () => b.deps.fx?.('flash', q));
      }
      return `${dmg} damage to ${hit.length} in a ${len}-unit line`;
    },
  },
  // After a short delay, a pillar of fire damages and stuns everything in the area.
  lina_light_strike_array: {
    target: 'point',
    sound: 'Ability.PreLightStrikeArray',
    cast(b, h, a, L, t, p) {
      const aoe = abilityValue(a, 'light_strike_array_aoe', L, 225), delay = abilityValue(a, 'light_strike_array_delay_time', L, 0.5);
      const stun = abilityValue(a, 'light_strike_array_stun_duration', L, 1.6), dmg = abilityValue(a, 'AbilityDamage', L, 90);
      b.after(delay, () => {
        b.deps.fx?.('flash', p);
        b.deps.playSound?.('Ability.LightStrikeArray', p, 1);
        for (const u of enemiesAround(b, h.team, p, aoe)) { b.spellDamage(h, u, dmg, damageType(a)); b.stun(u, stun); }
      });
      return `${dmg} damage and a ${stun}s stun in ${aoe} radius after ${delay}s`;
    },
  },
  // Passive: each spell cast adds a stack of attack and move speed (up to the maximum).
  lina_fiery_soul: {
    passive: true,
    onCast(b, h, a, L) {
      const prev = b.getBuff(h, 'fiery_soul'), stacks = Math.min(abilityValue(a, 'fiery_soul_max_stacks', L, 3), (prev?.stacks || 0) + 1);
      const until = b.time + abilityValue(a, 'AbilityDuration', L, abilityValue(a, 'fiery_soul_stack_duration', L, 7));
      b.setBuff(h, 'fiery_soul', { kind: 'attackSpeed', amount: stacks * abilityValue(a, 'fiery_soul_attack_speed_bonus', L, 30), stacks, until });
      b.setBuff(h, 'fiery_soul_ms', { kind: 'haste', pct: stacks * abilityValue(a, 'fiery_soul_move_speed_bonus', L, 2), until });
      b.deps.floatText?.(`Fiery Soul ×${stacks}`, h.pos, 'order');
    },
  },
  // A bolt of lightning: big single-target damage.
  lina_laguna_blade: {
    target: 'unit',
    sound: 'Ability.LagunaBlade',
    cast(b, h, a, L, t) {
      const dmg = abilityValue(a, 'AbilityDamage', L, 450);
      b.after(0.25, () => { b.deps.fx?.('flash', t.pos); b.spellDamage(h, t, dmg, damageType(a)); });
      return `${dmg} damage`;
    },
  },

  // ---- Zeus
  // Lightning that jumps from the target to nearby enemies, one after another.
  zuus_arc_lightning: {
    target: 'unit',
    sound: 'Hero_Zuus.ArcLightning.Cast',
    cast(b, h, a, L, t) {
      const dmg = abilityValue(a, 'AbilityDamage', L, 85), r = abilityValue(a, 'radius', L, 500);
      const jumps = abilityValue(a, 'jump_count', L, 5), delay = abilityValue(a, 'jump_delay', L, 0.25);
      const hit = new Set();
      const strike = (u, n) => {
        if (!u || u.state === 'dead') return;
        hit.add(u);
        b.deps.fx?.('magic', u.pos);
        b.spellDamage(h, u, dmg, damageType(a));
        if (n >= jumps) return;
        const next = enemiesAround(b, h.team, u.pos, r).filter((e) => !hit.has(e)).sort((x, y) => b.dist(x, u) - b.dist(y, u))[0];
        if (next) b.after(delay, () => strike(next, n + 1));
      };
      strike(t, 1);
      return `${dmg} damage, up to ${jumps} targets`;
    },
  },
  // A bolt from the sky on one target. (Dota's mini-stun isn't in the 2011 data, so it isn't applied.)
  zuus_lightning_bolt: {
    target: 'unit',
    sound: 'Hero_Zuus.LightningBolt',
    cast(b, h, a, L, t) {
      const dmg = abilityValue(a, 'AbilityDamage', L, 100);
      b.deps.fx?.('flash', t.pos);
      b.spellDamage(h, t, dmg, damageType(a));
      return `${dmg} damage`;
    },
  },
  // Passive: every spell Zeus casts also takes a share of the current health of enemies around him.
  zuus_static_field: {
    passive: true,
    onCast(b, h, a, L) {
      const pct = abilityValue(a, 'damage_health_pct', L, 5), r = abilityValue(a, 'radius', L, 1000);
      for (const u of enemiesNear(b, h, r)) b.spellDamage(h, u, u.hp * pct / 100, damageType(a));
    },
  },
  // Hits every enemy hero on the map — there are none in a creep battle.
  zuus_thundergods_wrath: { target: 'none', heroesOnly: true },

  // ---- Shadow Fiend
  ...Object.fromEntries([1, 2, 3].map((k) => [`nevermore_shadowraze${k}`, {
    // A blast at a fixed distance in front of Shadow Fiend.
    target: 'none',
    sound: 'Hero_Nevermore.Shadowraze',
    cast(b, h, a, L) {
      const range = abilityValue(a, 'shadowraze_range', L, 200 + (k - 1) * 250), r = abilityValue(a, 'shadowraze_radius', L, 250);
      const dmg = abilityValue(a, 'AbilityDamage', L, 75), c = [h.pos[0] + Math.cos(h.yaw) * range, h.pos[1] + Math.sin(h.yaw) * range, h.pos[2]];
      const hit = enemiesAround(b, h.team, c, r);
      for (const u of hit) b.spellDamage(h, u, dmg, damageType(a));
      b.deps.fx?.('dust', c);
      return `${dmg} damage to ${hit.length} at ${range} units`;
    },
  }])),
  // Passive: each kill captures a soul (+damage), up to the maximum; half are lost on death.
  nevermore_necromastery: {
    passive: true,
    onKill(b, h, a, L) {
      const souls = Math.min(abilityValue(a, 'necromastery_max_souls', L, 8), (b.getBuff(h, 'souls')?.souls || 0) + 1);
      b.setBuff(h, 'souls', { kind: 'damage', amount: souls * abilityValue(a, 'necromastery_damage_per_soul', L, 2), souls, until: Infinity });
    },
    onDeath(b, h, a, L) {
      const s0 = b.getBuff(h, 'souls')?.souls || 0, souls = Math.floor(s0 * (1 - abilityValue(a, 'necromastery_soul_release', L, 0.5)));
      b.setBuff(h, 'souls', { kind: 'damage', amount: souls * abilityValue(a, 'necromastery_damage_per_soul', L, 2), souls, until: Infinity });
    },
  },
  // Aura: enemies near Shadow Fiend lose armor.
  nevermore_dark_lord: {
    passive: true,
    onTick(b, h, a, L) {
      const red = abilityValue(a, 'presence_armor_reduction', L, -2), r = abilityValue(a, 'presence_radius', L, 900);
      for (const u of enemiesNear(b, h, r)) b.setBuff(u, 'presence', { kind: 'armor', amount: red, until: b.time + 0.25 });
    },
  },
  // Releases lines of souls outward (souls / soul_conversion lines); each line damages what it passes.
  nevermore_requiem: {
    target: 'none',
    sound: 'Hero_Nevermore.RequiemOfSouls',
    cast(b, h, a, L) {
      const souls = b.getBuff(h, 'souls')?.souls || 0, lines = Math.floor(souls / Math.max(1, abilityValue(a, 'requiem_soul_conversion', L, 2)));
      const r = abilityValue(a, 'requiem_radius', L, 900), dmg = abilityValue(a, 'AbilityDamage', L, 80);
      const w0 = abilityValue(a, 'requiem_line_width_start', L, 70), w1 = abilityValue(a, 'requiem_line_width_end', L, 475);
      const speed = abilityValue(a, 'requiem_line_speed', L, 600);
      let total = 0;
      for (let i = 0; i < lines; i++) {
        const ang = (i / lines) * Math.PI * 2, to = [h.pos[0] + Math.cos(ang) * r, h.pos[1] + Math.sin(ang) * r];
        for (const u of enemiesInLine(b, h.team, h.pos, to, r, w0, w1)) {
          total++;
          b.after(b.dist(h, u) / speed, () => b.spellDamage(h, u, dmg, damageType(a)));
        }
        b.after(r / speed / 2, () => b.deps.fx?.('dust', [h.pos[0] + Math.cos(ang) * r / 2, h.pos[1] + Math.sin(ang) * r / 2, h.pos[2]]));
      }
      return lines ? `${lines} soul lines (from ${souls} souls), ${total} hits of ${dmg}` : 'no souls to release — get kills first (Necromastery)';
    },
  },
};
