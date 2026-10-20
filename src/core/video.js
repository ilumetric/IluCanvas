// Video by link: YouTube only for now. Parsing links and times, shared by the
// app and the CLI (no DOM). A video item keeps the link, its poster as an
// ordinary image asset (so the board shows it offline), and what a reference
// study needs: speed, an A–B loop, labelled timecodes.

export const PROVIDERS = ['youtube'];
export const RATE_MIN = 0.25;
export const RATE_MAX = 2;

const YT_ID = /^[\w-]{11}$/;

/** "90", "90s", "1m30s", "1h2m3s", "1:30", "01:02:03" → seconds (null when it is not a time). */
export function parseTime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?s?$/.test(s)) return parseFloat(s);
  const hms = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (hms && (hms[1] || hms[2] || hms[3])) return (Number(hms[1]) || 0) * 3600 + (Number(hms[2]) || 0) * 60 + (Number(hms[3]) || 0);
  const colon = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (colon) return (Number(colon[1]) || 0) * 3600 + Number(colon[2]) * 60 + Number(colon[3]);
  return null;
}

/** 83.5 → "1:23", 3725 → "1:02:05" (with `digits` 1 or 2: "1:23.5", "1:23.50"). */
export function formatTime(t, { tenths = false, digits = tenths ? 1 : 0 } = {}) {
  const v = Math.max(0, Number(t) || 0);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = v % 60;
  const ss = digits ? s.toFixed(digits).padStart(3 + digits, '0') : String(Math.floor(s)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * A YouTube link → { provider: 'youtube', videoId, url, start?, short? } or null.
 * watch?v=, youtu.be/, shorts/, embed/, live/, m. and music. hosts; t= / start= become start.
 */
export function parseVideoUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (m) id = m[1];
    }
  }
  if (!id || !YT_ID.test(id)) return null;
  const out = { provider: 'youtube', videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
  if (u.pathname.startsWith('/shorts/')) out.short = true; // vertical
  const start = parseTime(u.searchParams.get('t') ?? u.searchParams.get('start') ?? (u.hash.match(/t=([^&]+)/)?.[1] || null));
  if (start) out.start = start;
  return out;
}

/** Poster images, best first (maxres is missing for some videos). */
export const posterUrls = (videoId) => [`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`];

/** The video page's title and author (oEmbed; allowed from other sites). */
export const oembedUrl = (url) => `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;

/** A clean list of timecodes: [{ t, end?, label }] sorted by t. */
export function cleanMarks(marks) {
  if (!Array.isArray(marks)) return [];
  const out = [];
  for (const m of marks) {
    const t = parseTime(m?.t);
    if (t === null) continue;
    const n = { t: Math.round(t * 100) / 100, label: typeof m.label === 'string' ? m.label : '' };
    const end = parseTime(m.end);
    if (end !== null && end > t) n.end = Math.round(end * 100) / 100;
    out.push(n);
  }
  return out.sort((a, b) => a.t - b.t);
}
