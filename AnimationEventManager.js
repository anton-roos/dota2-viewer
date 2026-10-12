// AnimationEventManager — fires sound and particle cues in sync with the playing animation.
//
// Sources of events, merged per clip:
//   1. the model's own keyframe events from the MDL sequence (AE_CL_PLAYSOUND, AE_DOTA_PLAY_SOUND_ATTACK,
//      AE_CL_CREATE_PARTICLE_EFFECT "NAME follow_attachment attach_x" …), positioned as a cycle 0..1;
//   2. optional JSON manifests in viewer/events/<hero>.json (schema below), timed in seconds, which can
//      add events or replace the model's ones ("replace": true).
//
// Manifest schema (one object, or an array of them):
//   { "hero_id": "axe", "clip_name": "attack_main", "replace": false,
//     "events": [ { "time": 0.32, "type": "sound", "src": "Hero_Axe.Attack" },        // soundscript name,
//                 { "time": 0.50, "type": "particle", "preset": "trail", "socket": "attach_weapon" } ] }
//   "src" may also be a VPK path ("sound/weapons/…wav") or a URL ("/sounds/x.webm").
//
// The viewer drives its own skeletal animation (decoded from Valve's compressed tracks), so instead of
// polling a THREE.AnimationAction this class is fed the clip's normalised cycle each frame. Trigger
// windows are half-open (prev, now]; a loop wrap fires (prev, 1] then [0, now]; scrubbing never fires.

const manifestCache = new Map();

export class AnimationEventManager {
  /**
   * @param {object} handlers
   * @param {(e: object) => void} handlers.onSound     e: { sound | url | path, volume }
   * @param {(e: object) => void} handlers.onParticle  e: { preset, effect, socket, follow }
   * @param {(e: object) => void} [handlers.onFire]    every fired event (for UI ticks)
   */
  constructor({ onSound, onParticle, onFire } = {}) {
    this.onSound = onSound || (() => {});
    this.onParticle = onParticle || (() => {});
    this.onFire = onFire || (() => {});
    this.events = [];
    this.last = 0;
    this.clip = null;
  }

  static async loadManifest(heroShort) {
    if (!heroShort) return [];
    if (!manifestCache.has(heroShort)) {
      manifestCache.set(heroShort, fetch(`events/${heroShort}.json`).then((r) => (r.ok ? r.json() : []))
        .then((m) => (Array.isArray(m) ? m : [m])).catch(() => []));
    }
    return manifestCache.get(heroShort);
  }

  /**
   * Prepare triggers for a newly started clip.
   * @param {object} clip { name, activity, duration (s), events: MDL events [{cycle, name, options, sound}], hero }
   * @param {Array} manifests from loadManifest()
   * @param {(e) => string|null} resolveSound maps an MDL event to a soundscript name (unit SoundSet aware)
   */
  setClip(clip, manifests = [], resolveSound = () => null) {
    this.clip = clip;
    const list = [];
    const matches = manifests.filter((m) => m && (m.clip_name === clip.name || m.clip_name === clip.activity));
    const replace = matches.some((m) => m.replace);
    if (!replace) {
      for (const e of clip.events || []) {
        const sound = resolveSound(e);
        if (sound) list.push({ cycle: e.cycle, type: 'sound', sound, source: 'model', label: sound });
        if (/PARTICLE/.test(e.name || '')) {
          // options: "AXE_ATTACK_BLUR follow_attachment attach_helix" | "X start_at_origin" | "X start_at_attachment a"
          const parts = (e.options || '').trim().split(/\s+/);
          const effect = parts[0] || 'effect';
          const mode = parts[1] || 'start_at_origin';
          const socket = parts[2] || (mode.includes('origin') ? null : 'attach_hitloc');
          list.push({ cycle: e.cycle, type: 'particle', effect, socket, follow: mode.startsWith('follow'), source: 'model', label: effect });
        }
      }
    }
    for (const m of matches) {
      for (const e of m.events || []) {
        const cycle = clip.duration > 0 ? Math.min(1, Math.max(0, (e.time || 0) / clip.duration)) : 0;
        if (e.type === 'sound') {
          const src = e.src || e.sound || '';
          list.push({ cycle, type: 'sound', source: 'manifest', label: src,
            ...(src.startsWith('/') || /^https?:/.test(src) ? { url: src } : src.includes('/') ? { path: src } : { sound: src }), volume: e.volume });
        } else if (e.type === 'particle') {
          list.push({ cycle, type: 'particle', source: 'manifest', effect: e.preset, preset: e.preset, socket: e.socket || null,
            follow: e.follow !== false, label: e.preset });
        }
      }
    }
    this.events = list.sort((a, b) => a.cycle - b.cycle);
    this.reset();
    return this.events;
  }

  /** Forget the trigger window (clip restart, scrub, version switch) so nothing double-fires. */
  reset(cycle = -1e-6) { this.last = cycle; }

  /**
   * Call once per frame with the clip's current cycle (0..1).
   * @param {number} cycle
   * @param {{playing?: boolean, scrubbing?: boolean, enabled?: boolean}} state
   */
  update(cycle, { playing = true, scrubbing = false, enabled = true } = {}) {
    if (!this.events.length || !playing || scrubbing || !enabled) { this.last = cycle; return; }
    const prev = this.last;
    if (cycle === prev) return;
    const wrapped = cycle < prev;
    for (const e of this.events) {
      const hit = wrapped ? (e.cycle > prev || e.cycle <= cycle) : (e.cycle > prev && e.cycle <= cycle);
      if (!hit) continue;
      if (e.type === 'sound') this.onSound(e); else this.onParticle(e);
      this.onFire(e);
    }
    this.last = cycle;
  }

  dispose() { this.events = []; this.clip = null; }
}
