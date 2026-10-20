// The video player: a YouTube iframe floated over a video's card while it
// plays, and under it the reference-study bar — play, frame steps, speed
// 0.25–2, an A–B loop, labelled timecodes. One player at a time; the board
// draws the card again when it closes. Speed, loop and timecodes are saved in
// the item (undoable edits); the duration is noted silently once known.

import { byId } from '../core/model.js';
import { formatTime, cleanMarks, watchUrl, RATE_MIN, RATE_MAX } from '../core/video.js';
import { h, icon, promptDialog } from './ui.js';
import { t } from './i18n.js';

const FRAME = 1 / 30;
let api = null;

/** The YouTube IFrame API (loaded once, on the first play). */
function loadApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  api ||= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => { api = null; reject(new Error('YouTube is not reachable')); };
    document.head.append(s);
  });
  return api;
}

export class VideoPlayer {
  /** app: { board, doc, edit, silent, readOnly, toast } */
  constructor(app, layer) {
    this.app = app;
    this.layer = layer;
    this.id = null;
    this.player = null;
    this.raf = 0;
    addEventListener('keydown', (e) => this.#key(e), true);
  }

  get open() { return !!this.id; }

  item() { const d = this.app.doc(); return d && this.id ? byId(d).get(this.id) : null; }

  async play(id) {
    if (this.id === id) return;
    this.close();
    const it = byId(this.app.doc()).get(id);
    if (!it || it.type !== 'video') return;
    // the id comes from a file (maybe someone else's): only a real YouTube id reaches the player
    if (!watchUrl(it.videoId)) { this.app.toast(t('video.badLink'), { kind: 'warn' }); return; }
    this.id = id;
    this.app.board.activeVideo = id;
    this.app.board.invalidate();
    this.host = h('div.vplayer-host');
    this.box = h('div.vplayer', {}, this.host);
    this.bar = h('div.vbar.float');
    this.layer.append(this.box, this.bar);
    this.#render();
    this.place();
    let YT;
    try { YT = await loadApi(); } catch (e) {
      this.app.toast(t('video.offline'), { kind: 'warn', timeout: 7000 });
      this.close();
      return;
    }
    if (this.id !== id) return;
    this.player = new YT.Player(this.host, {
      videoId: it.videoId,
      host: 'https://www.youtube-nocookie.com',
      width: '100%',
      height: '100%',
      playerVars: { autoplay: 1, playsinline: 1, rel: 0, modestbranding: 1, start: Math.floor(it.start || 0), origin: location.origin },
      events: {
        onReady: () => {
          if (this.id !== id) return;
          if (it.rate) this.player.setPlaybackRate(it.rate);
          if (it.start) this.player.seekTo(it.start, true);
          this.player.playVideo();
          const dur = this.player.getDuration?.();
          if (dur > 0 && Math.abs((it.duration || 0) - dur) > 0.5) this.app.silent((d) => this.#patch(d, { duration: Math.round(dur * 10) / 10 }));
          this.#tick();
        },
        onStateChange: () => this.#render(),
      },
    });
  }

  close() {
    if (!this.id) return;
    cancelAnimationFrame(this.raf);
    try { this.player?.destroy(); } catch { /* gone */ }
    this.player = null;
    this.box?.remove();
    this.bar?.remove();
    this.box = this.bar = null;
    this.id = null;
    this.app.board.activeVideo = null;
    this.app.board.invalidate();
  }

  /** Follow the card on screen (the board moved, zoomed, or the card did). */
  place() {
    const it = this.item();
    if (!it) { if (this.id) this.close(); return; }
    const b = this.app.board;
    const st = b.stage.getBoundingClientRect();
    const a = b.toScreen(it.x, it.y);
    const w = it.w * b.view.z;
    const hh = it.h * b.view.z;
    Object.assign(this.box.style, { left: `${st.left + a.x}px`, top: `${st.top + a.y}px`, width: `${w}px`, height: `${hh}px` });
    const ui = b.ui;
    const r = this.bar.getBoundingClientRect();
    let x = st.left + a.x + w / 2 - r.width / 2;
    let y = st.top + a.y + hh + 10;
    if (y + r.height > innerHeight - 8) y = Math.max(8, st.top + a.y + hh - r.height - 10);
    x = Math.max(8, Math.min(x, innerWidth - r.width - 8));
    this.bar.style.left = `${x / ui}px`;
    this.bar.style.top = `${y / ui}px`;
  }

  // ---- controls ------------------------------------------------------------------------------------

  #now() { try { return this.player?.getCurrentTime?.() || 0; } catch { return 0; } }
  #playing() { try { return this.player?.getPlayerState?.() === 1; } catch { return false; } }

  #patch(d, p) {
    const it = byId(d).get(this.id);
    if (!it) return;
    const n = { ...it, ...p };
    for (const [k, v] of Object.entries(p)) if (v === undefined) delete n[k];
    d.items = d.items.map((x) => (x.id === it.id ? n : x));
  }

  #set(label, p) {
    if (this.app.readOnly()) return;
    this.app.edit(label, (d) => this.#patch(d, p));
    this.#render();
  }

  #toggle() { if (this.#playing()) this.player?.pauseVideo(); else this.player?.playVideo(); }

  #step(dir) {
    this.player?.pauseVideo();
    this.player?.seekTo(Math.max(0, this.#now() + dir * FRAME), true);
  }

  #setRate(v, save) {
    const r = Math.round(Math.min(RATE_MAX, Math.max(RATE_MIN, v)) * 100) / 100;
    this.player?.setPlaybackRate(r);
    if (save) this.#set('speed', { rate: r === 1 ? undefined : r });
    else if (this.rateLabel) this.rateLabel.textContent = `${r.toFixed(2)}×`;
  }

  #setLoop(which) {
    const it = this.item();
    const now = Math.round(this.#now() * 100) / 100;
    const cur = this.pendingLoop || it?.loop || {};
    const next = { ...cur, [which]: now };
    if (next.a !== undefined && next.b !== undefined && next.b > next.a) {
      this.pendingLoop = null;
      this.#set('loop', { loop: { a: next.a, b: next.b } });
    } else {
      // half a loop: kept here until the other end is set
      this.pendingLoop = { [which]: now };
      this.#render();
    }
  }

  async #addMark() {
    const it = this.item();
    const at = Math.round(this.#now() * 10) / 10;
    const label = await promptDialog({ title: t('video.markAdd', { time: formatTime(at) }), placeholder: t('video.markLabel') });
    if (label === null) return;
    this.#set('mark', { marks: cleanMarks([...(it.marks || []), { t: at, label: label.trim() }]) });
  }

  #removeMark(m) {
    const it = this.item();
    const list = (it.marks || []).filter((x) => !(x.t === m.t && x.label === m.label));
    this.#set('mark', { marks: list.length ? list : undefined });
  }

  #tick() {
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (!this.id) return;
      const it = this.item();
      const now = this.#now();
      // the A–B loop
      if (it?.loop && this.#playing() && now >= it.loop.b - 0.03 && now < it.loop.b + 1) this.player.seekTo(it.loop.a, true);
      if (this.timeLabel) {
        let dur = 0;
        try { dur = this.player.getDuration?.() || it?.duration || 0; } catch { /* not ready */ }
        this.timeLabel.textContent = `${formatTime(now, { digits: 2 })}${dur ? ` / ${formatTime(dur)}` : ''}`;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  #key(e) {
    if (!this.id || e.target?.closest?.('input, textarea, [contenteditable="true"]')) return;
    const k = e.key;
    if (k === 'Escape') { e.stopPropagation(); e.preventDefault(); this.close(); return; }
    if (k === ' ' || k === 'k') { e.stopPropagation(); e.preventDefault(); this.#toggle(); return; }
    if (k === ',' || k === '.') { e.stopPropagation(); e.preventDefault(); this.#step(k === ',' ? -1 : 1); }
  }

  #render() {
    if (!this.bar) return;
    const it = this.item();
    if (!it) return;
    const btn = (ic, title, onclick, on = false, text = null) => h(`button.icon-btn${on ? '.on' : ''}${text ? '.sb-text' : ''}`, { type: 'button', title, 'aria-label': title, onclick }, ic ? icon(ic, 17) : null, text);
    const playing = this.#playing();
    this.timeLabel = h('span.vtime', {}, '0:00.0');
    const rate = it.rate || 1;
    this.rateLabel = h('span.vrate', {}, `${rate.toFixed(2)}×`);
    const slider = h('input.vrate-range', { type: 'range', min: RATE_MIN, max: RATE_MAX, step: 0.05, value: rate, title: t('video.speed'), 'aria-label': t('video.speed') });
    slider.addEventListener('input', () => this.#setRate(Number(slider.value), false));
    slider.addEventListener('change', () => this.#setRate(Number(slider.value), true));
    const loop = it.loop;
    const pend = this.pendingLoop;
    const ro = this.app.readOnly();
    const row1 = h('div.vrow', {},
      btn(playing ? 'pause' : 'play', `${playing ? t('video.pause') : t('video.play')} (Space)`, () => this.#toggle()),
      btn('frameBack', `${t('video.frameBack')} (,)`, () => this.#step(-1)),
      btn('frameFwd', `${t('video.frameFwd')} (.)`, () => this.#step(1)),
      this.timeLabel,
      h('span.sb-sep'),
      h('span.vrate-box', { title: t('video.speed') }, icon('gauge', 16), slider, this.rateLabel),
      h('span.sb-sep'),
      btn(null, t('video.loopA'), () => this.#setLoop('a'), !!(loop || pend?.a !== undefined), loop ? `A ${formatTime(loop.a)}` : pend?.a !== undefined ? `A ${formatTime(pend.a)}` : 'A'),
      btn(null, t('video.loopB'), () => this.#setLoop('b'), !!(loop || pend?.b !== undefined), loop ? `B ${formatTime(loop.b)}` : pend?.b !== undefined ? `B ${formatTime(pend.b)}` : 'B'),
      loop || pend ? btn('x', t('video.loopClear'), () => { this.pendingLoop = null; if (loop) this.#set('loop', { loop: undefined }); else this.#render(); }) : null,
      h('span.sb-sep'),
      // from the id, not the item's `url` (which may hold anything)
      btn('external', t('video.openYoutube'), () => window.open(watchUrl(it.videoId, this.#now()), '_blank', 'noopener')),
      btn('x', `${t('video.close')} (Esc)`, () => this.close()));
    const marks = h('div.vmarks', {},
      ...(it.marks || []).map((m) => h('span.vmark', {},
        h('button.vmark-go', { type: 'button', title: t('video.markGo'), onclick: () => { this.player?.seekTo(m.t, true); } }, h('b', {}, formatTime(m.t)), m.label ? ` ${m.label}` : ''),
        ro ? null : h('button.vmark-x', { type: 'button', title: t('video.markRemove'), 'aria-label': t('video.markRemove'), onclick: () => this.#removeMark(m) }, icon('x', 12)))),
      ro ? null : h('button.vmark-add', { type: 'button', onclick: () => this.#addMark() }, icon('flag', 14), t('video.mark')));
    this.bar.replaceChildren(row1, marks);
    this.place();
  }
}
