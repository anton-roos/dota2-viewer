# Integration guide — Panorama HUD, keyframe-synced FX/audio, version-safe state

This phase adds three pieces to the viewer without replacing any existing loading, cosmetics or world
code. Everything below is already wired in `index.html`; this guide documents where, so it can be
maintained or reused.

| File | What it is |
|---|---|
| `hud.html` | HUD markup fragment (`data-bind` fields), fetched and inserted by `hud.js` |
| `hud.css` | Panorama-style styling: stone/slate, bronze trims `#c29c53 → #483920`, beveled portrait, 250-HP tick bar |
| `hud.js` | `Hud` controller: binds to a view, renders stats/abilities for that view's build, hotkeys, UI sounds |
| `AnimationEventManager.js` | Fires sound/particle cues once per trigger window from the playing clip |
| `particles.js` | `ParticleSystem`: additive sprite bursts, rings and weapon-trail ribbons mounted on sockets |
| `events/<hero>.json` | Optional per-hero event manifests (example: `events/axe.json`) |

## How this differs from the original spec (and why)

- **No `THREE.AnimationMixer`.** The viewer decodes Valve's compressed animation tracks itself
  (`source.js → decodeSequence`) and poses bones every frame (`View.applyPose`). The event manager is
  therefore fed the clip's normalised **cycle** (0..1) instead of polling `AnimationAction.time`. The
  semantics are the same: half-open trigger windows, loop-wrap handling, fire once per window.
- **The models already carry keyframe events.** Valve's MDL sequences contain `AE_CL_PLAYSOUND`,
  `AE_DOTA_PLAY_SOUND_ATTACK` and `AE_CL_CREATE_PARTICLE_EFFECT` (with socket names such as
  `attach_helix`, `blade_attachment`). These are the default event source; JSON manifests add to them,
  or replace them per clip with `"replace": true`.
- **Icons are read live from each build** (Flash-era PNGs, VTF textures, or VMT sub-rectangles of a sheet)
  rather than pre-extracted `.webp` files, so every patch shows its own art.
- **Particles use camera-facing sprites and ribbons** (no `three.quarks` dependency), as the spec allows.

## Hook points in `index.html`

### 1. Imports and boot
- `import { AnimationEventManager } from './AnimationEventManager.js'`, `ParticleSystem / presetForEffect`
  from `./particles.js`, `Hud` from `./hud.js`; `<link rel="stylesheet" href="hud.css">` in `<head>`.
- `const hud = new Hud(document.getElementById('views'), { uiImage, playUi, getLevel })` — created next to
  the other audio helpers; `await hud.mount()` right before `layout()` at boot.
- Toolbar checkbox `#optHud` toggles it; the level slider calls `hud.refresh()`.

### 2. Per-view setup — `View` constructor
- `this.particles = new ParticleSystem(this.scene)`
- `this.events = new AnimationEventManager({ onSound, onParticle, onFire })` → `View.onEventSound`,
  `View.onEventParticle`, `View.onEventFire` (timeline tick flash).
- A capturing `pointerdown` on the view binds the HUD to it (the HUD follows the last view you touched).

### 3. Sockets — `View.load`, right after the skeleton is created
- Each MDL attachment (`source.js` now parses `mstudioattachment_t`: name, bone, 3×4 local matrix)
  becomes an `Object3D` child of its bone with `matrixAutoUpdate = false`. Because it is parented to the
  animated bone, anything mounted on it follows the animation for free.
- `View.resolveSocket(name)` looks up the socket; falls back through aliases (`attach_weapon` ↔
  `attach_attack1` ↔ `attach_helix` ↔ `blade_attachment`…) and then to a weapon-like bone. This matters
  for early builds: January 2011 Axe's events name `attach_helix`, which that model does not have yet.
- Cosmetics are untouched: wearables keep bone-merging onto the hero's bones.

### 4. Clip start — `View.playSequence`
- `this.events.setClip({ name, activity, duration, events }, manifests, resolveSound)` replaces the old
  inline event list; `AnimationEventManager.loadManifest(heroShort)` loads `events/<hero>.json` once
  and re-applies the clip when it arrives.
- `View.renderTimeline()` draws the merged events (blue = sound, orange = particle); clicking a tick
  previews that event.

### 5. Per frame — `View.update`
- After `applyPose`: `this.events.update(anim.cycle, { playing })` and
  `this.particles.update(dt * speed)`.
- One-shot casts started from the HUD set `returnTo`; when they end, the view returns to the loop that
  was playing before (synced views too).
- Scrubbing calls `this.events.reset(cycle)` so dragging the timeline never fires events.

### 6. Abilities — `View.castAbility(slot, ability)`
- Called by the HUD (click or hotkey Q/W/E/(D/F)/R). Picks `ACT_DOTA_CAST_ABILITY_<n>`, else a sequence
  whose name contains the ability's name, plays it, and syncs other views.

## Memory safety on version switches

| Resource | Where it is released |
|---|---|
| Particle sprites, ribbons, their materials/geometry | `ParticleSystem.clear()` on clip start and in `View.clear()`; `dispose()` frees the shared sprite texture |
| Event triggers | `AnimationEventManager.dispose()` in `View.clear()`; `reset()` on clip start / scrub / sound toggle |
| Model geometry, materials **and skeleton bone textures** | `disposeTree()` in `View.clear()` and for world actors (`clearActors`). Skeletons were previously not disposed — each model switch leaked one GPU texture |
| Textures of the previous build | `View.disposeOtherBuildTextures()`, called in `load()` **after** the old model is removed (disposing earlier makes the renderer re-upload them) |
| World maps | `trimWorlds()` keeps the 3 most recent unused maps and frees older ones (geometry, materials, terrain layer textures) |

Measured after the fix: stepping one view through 16 builds keeps `renderer.info.memory` flat at 2–3
geometries and 2 textures (before: +1 texture per switch).

## Event manifest schema

```json
[
  { "hero_id": "axe", "clip_name": "attack_main", "replace": false,
    "events": [
      { "time": 0.36, "type": "particle", "preset": "sparks", "socket": "attach_weapon" },
      { "time": 0.36, "type": "sound", "src": "Hero_Axe.Attack" }
    ] }
]
```
- `clip_name` matches a sequence name (`attack_main`) or activity (`ACT_DOTA_ATTACK`).
- `time` is in seconds from the start of the clip; it is converted to a cycle using the clip's length.
- `src`: soundscript name (`Hero_Axe.Attack`), VPK path (`sound/weapons/…`), or URL (`/sounds/x.webm`).
- `preset`: `trail`, `crit`, `sparks`, `flash`, `dust`, `blood`, `spin`, `magic` (Valve effect names are
  mapped automatically by `presetForEffect`).
- `follow`: `false` spawns at the socket's position instead of following it.

## Later additions

### Whole-map mode — `mapview.js`
`MapMode(view, world, { onWalk, onBattle })` is created by `View.setWorld('map')` and freed by `leave()`
(DOM, lane lines, RTS mouse buttons, camera near/far restored). Landmarks come from `world.markers`
(towers, barracks, Ancients, fountains, shops, runes, camps, Roshan, spawns), the minimap from an
orthographic top-down render cached on `world.minimap`.

### Lane battles — `battle.js`
`Battle(view, world, lanes, deps)`: creep waves every 30 s (3 melee + 1 ranged, siege every 7th wave)
from each lane's barracks waypoint, towers as stationary attackers, real unit stats per build,
attack points, homing projectiles, armor and approximate damage classes, death and corpse sink,
health-bar sprites, destroyed towers collapse their map instance. Started by `View.startBattle(lanes)`
(world mode "⚔ Creep battle at mid", or "⚔ waves" in map mode for all lanes), stopped by `stopBattle()`
on any world change. Creeps are `Actor`s sharing one model per build+unit (`actorTemplate()`); each copy
owns only its skeleton (`Actor.dispose()`); templates of builds no view shows are freed by
`trimActorTemplates()`.

### The hero in a battle — `Battle.addHero()` / `View.joinBattle()`
The view's hero joins as a unit (team picker in the battle scoreboard; default Radiant). Combat numbers
come from `heroCombatStats(npc_heroes entry, level)` — the same attribute formulas as the stats panel and
HUD. Right-click (pointerdown button 2, camera rotation moves to the middle button while fighting):
enemy = attack, own creep below 50 % = deny, ground = move; `S` stops. Only the hero's last hits pay gold
(creep-on-creep kills pay nobody, as in Dota). Aggro follows Dota's rule that creeps and towers attack a
hero only when no enemy creep is in range; idle auto-attack has a ~350-unit leash and ignores towers.
Respawn after 4 s × level at the team's fountain. Abilities are not simulated (their effects were
server code); the scoreboard says "approximate simulation" and its tooltip lists where each number came from.

### Abilities in battles — `abilities.js`
`ABILITIES[name]` holds hand-written effects (Axe's Berserker's Call, Battle Hunger, Counter Helix,
Culling Blade; Juggernaut's Blade Fury; Pudge's Rot). Every number comes from the build's ability data at
the hero's ability level via `abilityValue(a, key, L)` (top-level KV fields or specials), including
`AbilityCastPoint`, now passed through by `/api/hero`. `Battle.cast(a, target)` checks learned / cooldown /
mana / target, then a `cast` order walks into `AbilityCastRange`, winds up for the cast point and applies
the effect. Units carry `buffs` (taunt, armor, slow, dot, aura). The HUD shows live mana, cooldown
counters, toggles, unlearned and "not simulated" slots (`Hud.liveHp`). Unit-target spells use a targeting
mode (key, then left-click; right-click or Esc cancels).
Now also Sven, Lina, Zeus and Shadow Fiend. Engine hooks in `battle.js`: stuns (`stun()`), keyed buffs that
refresh instead of stacking (`setBuff()`), delayed effects (`after()`), point-target casts (`cast(a, null,
point)`), and hero passives via `heroPassives(hook)` — `onAttackLanded` (Great Cleave), `onCast` (Static Field,
Fiery Soul), `onKill` / `onDeath` (Necromastery), `onTick` (Presence aura). `heroesOnly` abilities
(Thundergod's Wrath) explain why they do nothing in a creep battle.

### Glow cards fade edge-on — `world.js angleFade()`
GlobalLitSimple materials with `$ALPHA_ANGLE_POWER` get `alpha *= |N·V|^power` via onBeforeCompile.
