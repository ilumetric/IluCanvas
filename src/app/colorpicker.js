// A custom colour: an HSV wheel (hue around, saturation outwards), a
// brightness slider, a hex field, the eyedropper (Chromium) and the last
// custom colours. After GuitarCanvas's ink colour picker. One open at a time.

import { h, icon } from './ui.js';
import { t } from './i18n.js';

export const isHex = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

export function hexToHsv(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let hh = 0;
  if (d > 0) {
    if (max === r) hh = 60 * (((g - b) / d) % 6);
    else if (max === g) hh = 60 * ((b - r) / d + 2);
    else hh = 60 * ((r - g) / d + 4);
  }
  return { h: (hh + 360) % 360, s: max ? d / max : 0, v: max };
}

export function hsvToHex({ h: hh, s, v }) {
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  const hx = (u) => Math.round((u + m) * 255).toString(16).padStart(2, '0');
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

/** HSV ↔ HSL (h in degrees, the rest 0…1). */
export function hsvToHsl({ h: hh, s, v }) {
  const l = v * (1 - s / 2);
  return { h: hh, s: l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l), l };
}

export function hslToHsv({ h: hh, s, l }) {
  const v = l + s * Math.min(l, 1 - l);
  return { h: hh % 360, s: v === 0 ? 0 : 2 * (1 - l / v), v };
}

// ---- the last custom colours (this browser) ----

const RECENT = 'ilucanvas.recentColors';
function recent() {
  try { return (JSON.parse(localStorage.getItem(RECENT)) || []).filter(isHex).slice(0, 8); } catch { return []; }
}
function remember(hex) {
  try { localStorage.setItem(RECENT, JSON.stringify([hex, ...recent().filter((c) => c !== hex)].slice(0, 8))); } catch { /* storage off */ }
}

const WHEEL = 150;
let current = null;

export function closeColorPicker() {
  current?.close();
}

/**
 * Open the picker beside `anchor` at `color` (#rrggbb). `onChange(hex, done)`:
 * done = false while dragging, true once a colour is chosen (release, Enter,
 * eyedropper, a recent colour). Opening it again with the same `key` closes it.
 * `beside`: the element to stand next to (default: the anchor); `place`: side | below;
 * `onClose()`: it closed, however (a drag cut short leaves no colour chosen).
 */
export function openColorPicker(anchor, color, onChange, { key = '', beside = anchor, place = 'side', onClose = null } = {}) {
  if (current) {
    const same = current.key === key;
    current.close();
    if (same && key) return;
  }
  // the wheel works in HSV, the sliders in HSL; each keeps its own values so
  // neither jumps where the other is undefined (saturation of black / white)
  let hsv;
  let hsl;
  const setHsv = (v) => { hsv = v; hsl = hsvToHsl(v); };
  const setHsl = (l) => { hsl = l; hsv = hslToHsv(l); };
  setHsv(hexToHsv(isHex(color) ? color.toLowerCase() : '#ffffff'));
  const hex = () => hsvToHex(hsv);
  const marker = h('span.cp-marker');
  const dim = h('span.cp-dim');
  const wheel = h('div.cp-wheel', { role: 'slider', 'aria-label': t('color.wheel') }, dim, marker);
  const thumb = h('span.cp-thumb');
  const slider = h('div.cp-value', { role: 'slider', 'aria-label': t('color.brightness') }, thumb);
  const field = h('input.cp-hex', { type: 'text', maxLength: 7, spellcheck: false, 'aria-label': 'HEX' });
  const preview = h('span.cp-preview');
  const recents = h('div.cp-recent');
  const emit = (done) => {
    paint();
    onChange(hex(), done);
    if (done) { remember(hex()); renderRecent(); }
  };
  function paint() {
    const a = ((hsv.h - 90) * Math.PI) / 180;
    const r = (WHEEL / 2 - 7) * hsv.s;
    marker.style.left = `${WHEEL / 2 + Math.cos(a) * r}px`;
    marker.style.top = `${WHEEL / 2 + Math.sin(a) * r}px`;
    marker.style.background = hex();
    dim.style.opacity = String(1 - hsv.v);
    slider.style.background = `linear-gradient(to bottom, ${hsvToHex({ ...hsv, v: 1 })}, #000)`;
    thumb.style.top = `${(1 - hsv.v) * 100}%`;
    thumb.style.background = hex();
    preview.style.background = hex();
    if (document.activeElement !== field) field.value = hex();
    // HSL sliders: each track shows what moving it would give
    const H = Math.round(hsl.h);
    const S = Math.round(hsl.s * 100);
    const L = Math.round(hsl.l * 100);
    const grad = {
      h: `linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 360].map((x) => `hsl(${x} ${S}% ${L}%)`).join(', ')})`,
      s: `linear-gradient(to right, hsl(${H} 0% ${L}%), hsl(${H} 100% ${L}%))`,
      l: `linear-gradient(to right, hsl(${H} ${S}% 0%), hsl(${H} ${S}% 50%), hsl(${H} ${S}% 100%))`,
    };
    for (const sl of sliders) {
      const u = sl.k === 'h' ? hsl.h / 360 : hsl[sl.k];
      sl.track.style.background = grad[sl.k];
      sl.thumb.style.left = `${u * 100}%`;
      sl.thumb.style.background = hex();
      if (document.activeElement !== sl.num) sl.num.value = String(sl.k === 'h' ? H : sl.k === 's' ? S : L);
    }
  }
  function renderRecent() {
    recents.replaceChildren(...recent().map((c) => h('button.cp-swatch', {
      type: 'button', title: c, 'aria-label': c, style: { background: c },
      onclick: () => { setHsv(hexToHsv(c)); emit(true); },
    })));
  }
  // drag on the wheel / the slider: live while moving, chosen on release
  const drag = (el, pick) => {
    let on = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      on = e.pointerId;
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      pick(e);
      emit(false);
    });
    el.addEventListener('pointermove', (e) => { if (on === e.pointerId) { pick(e); emit(false); } });
    const end = (e) => { if (on === e.pointerId) { on = null; emit(true); } };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
  drag(wheel, (e) => {
    const r = wheel.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    // picking a hue on a black wheel: show it
    setHsv({ h: ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360, s: Math.min(1, Math.hypot(dx, dy) / (r.width / 2)), v: hsv.v < 0.05 ? 1 : hsv.v });
  });
  drag(slider, (e) => {
    const r = slider.getBoundingClientRect();
    setHsv({ ...hsv, v: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)) });
  });
  // H 0…360, S and L 0…100: drag the track or type a number
  const sliders = ['h', 's', 'l'].map((k) => {
    const max = k === 'h' ? 360 : 100;
    const thumb = h('span.cp-sthumb');
    const track = h('div.cp-track', { role: 'slider', 'aria-label': t(`color.${k}`) }, thumb);
    const num = h('input.cp-num', { type: 'text', inputMode: 'numeric', maxLength: 3, 'aria-label': t(`color.${k}`) });
    drag(track, (e) => {
      const r = track.getBoundingClientRect();
      const u = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      setHsl({ ...hsl, [k]: k === 'h' ? u * 360 : u });
    });
    const commit = () => {
      const n = Number(num.value);
      const cur = k === 'h' ? Math.round(hsl.h) : Math.round(hsl[k] * 100);
      if (!num.value.trim() || !Number.isFinite(n) || Math.round(n) === cur || !el.isConnected) { num.value = String(cur); return; }
      const v = Math.min(max, Math.max(0, n));
      setHsl({ ...hsl, [k]: k === 'h' ? v : v / 100 });
      emit(true);
    };
    num.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        num.value = String(Math.min(max, Math.max(0, (Number(num.value) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1))));
        commit();
      }
    });
    num.addEventListener('blur', commit);
    return { k, thumb, track, num, row: h('div.cp-row', {}, h('span.cp-lbl', {}, k.toUpperCase()), track, num) };
  });
  const commitHex = () => {
    const m = field.value.trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
    if (!m) { field.value = hex(); return; }
    const raw = (m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]).toLowerCase();
    if (`#${raw}` === hex() || !el.isConnected) return; // nothing new (or closing)
    setHsv(hexToHsv(`#${raw}`));
    emit(true);
  };
  field.addEventListener('keydown', (e) => {
    e.stopPropagation(); // not the board's shortcuts
    if (e.key === 'Enter') { e.preventDefault(); commitHex(); }
    if (e.key === 'Escape') close();
  });
  field.addEventListener('blur', commitHex);
  const footer = h('div.cp-footer');
  if ('EyeDropper' in window) {
    footer.append(h('button.icon-btn.cp-eye', {
      type: 'button', title: t('color.eyedropper'), 'aria-label': t('color.eyedropper'),
      onclick: async () => {
        try {
          const { sRGBHex } = await new window.EyeDropper().open();
          if (isHex(sRGBHex)) { setHsv(hexToHsv(sRGBHex.toLowerCase())); emit(true); }
        } catch { /* Escape */ }
      },
    }, icon('pipette', 16)));
  }
  footer.append(field, preview);
  const el = h('div.cpick', { role: 'dialog', 'aria-label': t('color.custom') }, h('div.cp-main', {}, wheel, slider), h('div.cp-sliders', {}, sliders.map((x) => x.row)), footer, recents);
  document.body.append(el);
  paint();
  renderRecent();
  // beside (or below) the anchor, inside the window (the picker is zoomed with the interface scale)
  const ui = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui')) || 1;
  const ar = beside.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  let x;
  let y;
  if (place === 'below') {
    x = Math.max(8, Math.min(innerWidth - r.width - 8, ar.left + ar.width / 2 - r.width / 2));
    y = ar.bottom + 8;
    if (y + r.height > innerHeight - 8) y = Math.max(8, ar.top - r.height - 8);
  } else {
    x = ar.right + 10;
    if (x + r.width > innerWidth - 8) x = Math.max(8, ar.left - r.width - 10);
    y = Math.max(8, Math.min(innerHeight - r.height - 8, ar.top + ar.height / 2 - r.height / 2));
  }
  el.style.left = `${x / ui}px`;
  el.style.top = `${y / ui}px`;
  // the anchor may be drawn again while picking (it carries data-cp = key): clicking it toggles
  const outside = (e) => {
    if (el.contains(e.target) || anchor.contains(e.target) || (key && e.target.closest?.(`[data-cp="${key}"]`))) return;
    close();
  };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  setTimeout(() => { addEventListener('pointerdown', outside, true); addEventListener('keydown', esc); });
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    removeEventListener('pointerdown', outside, true);
    removeEventListener('keydown', esc);
    el.remove();
    if (current?.el === el) current = null;
    onClose?.();
  }
  current = { el, key, close };
  return current;
}
