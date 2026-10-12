// Panorama-style hero HUD bound to one view (the one you last interacted with).
// Reads the bound view's hero data (npc_heroes + npc_abilities of that build) and the global hero level,
// so switching patches updates stats, ability slots and icons together. Clicking an ability (or pressing
// its hotkey) plays that ability's cast animation, which fires the model's synced sound/particle events.

const HOTKEYS = { 4: ['Q', 'W', 'E', 'R'], 5: ['Q', 'W', 'E', 'D', 'R'], 6: ['Q', 'W', 'E', 'D', 'F', 'R'] };

export class Hud {
  /**
   * @param {HTMLElement} host   element the HUD is positioned in (the views container)
   * @param {object} deps        { uiImage(build, candidates) -> Promise<url>, playUi(build, kind), getLevel() }
   */
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
    this.view = null;
    this.el = null;
    this.token = 0;
  }

  async mount() {
    const html = await fetch('hud.html').then((r) => r.text());
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    this.el = wrap.querySelector('.dhud');
    this.host.append(this.el);
    this.q = (name) => this.el.querySelector(`[data-bind="${name}"]`);
    addEventListener('keydown', (e) => {
      if (!this.view || /input|select|textarea/i.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
      const slot = this.el.querySelector(`.dhud-ab[data-key="${e.key.toUpperCase()}"]`);
      if (slot) { e.preventDefault(); slot.click(); }
    });
  }

  bind(view) {
    this.view = view;
    this.refresh();
  }

  setVisible(on) { if (this.el) this.el.hidden = !on || !this.view?.hero?.isHero; }

  // ability level a hero of this level would have: basics max at 4 by level 7, ultimate at 6 / 11 / 16
  abilityLevel(a, heroLevel) {
    const ult = /ULTIMATE/.test(a.AbilityType || '') || a.slot === 4;
    if (ult) return heroLevel >= 16 ? 3 : heroLevel >= 11 ? 2 : heroLevel >= 6 ? 1 : 0;
    return Math.max(1, Math.min(4, Math.ceil(heroLevel / 2)));
  }

  pick(values, level) {
    const v = String(values || '').trim().split(/\s+/).filter(Boolean);
    if (!v.length) return '';
    return v[Math.max(0, Math.min(v.length - 1, level - 1))].replace(/\.0+$/, '');
  }

  // health while the hero fights in a battle (View.liveHp = { hp, max })
  liveHp(view) {
    if (!this.el || this.view !== view || !view.liveHp) return;
    const { hp, max } = view.liveHp;
    this.q('hp').textContent = `${Math.ceil(hp)} / ${Math.round(max)}`;
    this.el.querySelector('.res.hp .fill').style.width = `${Math.max(0, Math.min(100, (hp / max) * 100)).toFixed(1)}%`;
    const { mana, maxMana, abilities } = view.liveHp;
    if (maxMana) {
      this.q('mana').textContent = `${Math.floor(mana)} / ${Math.round(maxMana)}`;
      this.el.querySelector('.res.mp .fill').style.width = `${Math.max(0, Math.min(100, (mana / maxMana) * 100)).toFixed(1)}%`;
    }
    // cooldown counters, not-enough-mana tint, toggles that are on, and abilities the battle can't simulate
    for (const slot of this.q('abilities').children) {
      const st = abilities?.[slot.dataset.name];
      if (!st) continue;
      let c = slot.querySelector('.cdleft');
      if (!c) { c = document.createElement('span'); c.className = 'cdleft'; slot.append(c); }
      c.textContent = st.cd > 0 ? Math.ceil(st.cd) : '';
      slot.classList.toggle('oncd', st.cd > 0);
      slot.classList.toggle('nomana', st.sim && st.cd <= 0 && st.mana > mana);
      slot.classList.toggle('active', st.active);
      slot.classList.toggle('nosim', !st.sim && !slot.classList.contains('passive'));
      slot.classList.toggle('unlearned', st.level < 1);
    }
  }

  // leaving a battle: back to the static HUD
  clearLive() {
    for (const slot of this.q('abilities')?.children || []) {
      slot.classList.remove('oncd', 'nomana', 'active', 'nosim', 'unlearned');
      slot.querySelector('.cdleft')?.remove();
    }
    this.el.querySelector('.res.mp .fill').style.width = '';
  }

  refresh() {
    const v = this.view, h = v?.hero;
    if (!this.el) return;
    if (!h || !h.isHero || !document.getElementById('optHud')?.checked) { this.el.hidden = true; this.host.classList.remove('has-hud'); return; }
    this.el.hidden = false;
    this.host.classList.add('has-hud'); // lets the page lift its own bottom panels above the HUD
    const token = ++this.token;
    const s = h.stats, n = (k, d = 0) => (s[k] !== undefined && s[k] !== '' ? parseFloat(s[k]) : d);
    const L = this.deps.getLevel();
    const lv = (b, g) => n(b) + n(g) * (L - 1);
    const str = lv('AttributeBaseStrength', 'AttributeStrengthGain'), agi = lv('AttributeBaseAgility', 'AttributeAgilityGain'),
      int = lv('AttributeBaseIntelligence', 'AttributeIntelligenceGain');
    const prim = (s.AttributePrimary || '').replace('DOTA_ATTRIBUTE_', '');
    const primVal = { STRENGTH: str, AGILITY: agi, INTELLECT: int }[prim] || 0;
    const hp = Math.round(n('StatusHealth', 150) + str * 19), mana = Math.round(n('StatusMana') + int * 13);
    this.q('build').textContent = v.sel.selectedOptions[0]?.text || v.build;
    this.q('name').textContent = h.name;
    this.q('level').textContent = L;
    this.q('str').textContent = Math.floor(str);
    this.q('agi').textContent = Math.floor(agi);
    this.q('int').textContent = Math.floor(int);
    for (const [cls, p] of [['str', 'STRENGTH'], ['agi', 'AGILITY'], ['int', 'INTELLECT']]) this.el.querySelector(`.attr.${cls}`).classList.toggle('primary', prim === p);
    this.q('dmg').textContent = `${Math.round(n('AttackDamageMin') + primVal)}–${Math.round(n('AttackDamageMax') + primVal)}`;
    this.q('armor').textContent = (n('ArmorPhysical') + agi / 7).toFixed(1);
    this.q('ms').textContent = n('MovementSpeed');
    this.q('hp').textContent = `${hp} / ${hp}`;
    this.el.querySelector('.res.hp .fill').style.width = '';
    this.el.querySelector('.res.mp .fill').style.width = '';
    if (v.liveHp) this.liveHp(v);
    this.q('mana').textContent = `${mana} / ${mana}`;
    this.q('hpregen').textContent = `+${(n('StatusHealthRegen') + str * 0.03).toFixed(1)}`;
    this.q('manaregen').textContent = `+${(n('StatusManaRegen') + int * 0.04).toFixed(1)}`;
    this.el.querySelector('.res.hp').style.setProperty('--tick', `${(250 / Math.max(hp, 250)) * 100}%`);

    const portrait = this.q('portrait');
    this.deps.uiImage(v.build, [`resource/flash3/images/heroes/${h.short}.png`, `materials/vgui/hud/heroportraits/portrait_${h.short}.vmt`,
      `materials/vgui/hud/heroportraits/portrait_${h.short}.vtf`]).then((url) => { if (token === this.token) portrait.src = url || ''; });

    // ability slots, hotkeys Q W E (D F) R, mana cost chip, cooldown, level pips
    const abs = h.abilities.slice(0, 6);
    const keys = HOTKEYS[abs.length] || ['Q', 'W', 'E', 'D', 'F', 'R'].slice(0, abs.length);
    const host = this.q('abilities');
    host.innerHTML = '';
    abs.forEach((a, i) => {
      const lvl = this.abilityLevel(a, L), maxLvl = /ULTIMATE/.test(a.AbilityType || '') || i === abs.length - 1 ? 3 : 4;
      const passive = /PASSIVE/.test(a.AbilityBehavior || '');
      const slot = document.createElement('div');
      slot.className = `dhud-ab${i === abs.length - 1 ? ' ult' : ''}${passive ? ' passive' : ''}`;
      slot.dataset.key = keys[i];
      slot.dataset.name = a.name;
      const mana = this.pick(a.AbilityManaCost, Math.max(1, lvl));
      const cd = this.pick(a.AbilityCooldown, Math.max(1, lvl));
      slot.innerHTML = `<img alt=""><span class="key">${keys[i]}</span>`
        + (mana && mana !== '0' ? `<span class="mana">${mana}</span>` : '')
        + (cd && cd !== '0' ? `<span class="cd">${cd}s</span>` : '')
        + `<div class="pips">${Array.from({ length: maxLvl }, (_, k) => `<i class="${k < lvl ? 'on' : ''}"></i>`).join('')}</div>`
        + `<div class="tip"><b></b><span></span></div>`;
      slot.querySelector('.tip b').textContent = `${a.title}${passive ? ' (passive)' : ''}`;
      slot.querySelector('.tip span').textContent = a.description || '';
      const img = slot.querySelector('img');
      this.deps.uiImage(v.build, [`resource/flash3/images/spellicons/${a.icon}.png`, `materials/vgui/hud/spellicons/${a.icon}.vtf`,
        `materials/vgui/hud/spellicons/${a.icon}.vmt`]).then((url) => { if (token === this.token && url) img.src = url; });
      slot.onmouseenter = () => this.deps.playUi(v.build, 'hover');
      slot.onclick = () => {
        this.deps.playUi(v.build, 'click');
        slot.classList.add('pressed'); setTimeout(() => slot.classList.remove('pressed'), 140);
        if (!passive) this.view?.castAbility(i, a);
      };
      host.append(slot);
    });
  }
}
