// Shared links: someone puts a .ilucanvas / .pur file on Google Drive (or
// Dropbox, or any server that allows cross-origin downloads), shares a link,
// and others open it here. The file is downloaded into the browser's private
// storage (OPFS) and opened from there, read only. "Sync" checks whether the
// file behind the link changed and downloads the new version.
//
// Google Drive does not let web pages download files directly; its API does,
// for files shared "Anyone with the link", with an API key (Settings).

const DRIVE = 'https://www.googleapis.com/drive/v3/files/';

/** { kind: 'gdrive', id, resourceKey } | { kind: 'url', url } | null */
export function parseLink(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  const host = url.hostname.replace(/^www\./, '');
  if (/(^|\.)(drive|docs)\.google\.com$/.test(host) || host === 'drive.usercontent.google.com') {
    const m = url.pathname.match(/\/(?:file|uc)\/d\/([\w-]{10,})/) || url.pathname.match(/\/d\/([\w-]{10,})/);
    const id = m?.[1] || url.searchParams.get('id');
    if (!id) return null;
    return { kind: 'gdrive', id, resourceKey: url.searchParams.get('resourcekey') || null };
  }
  if (host === 'dropbox.com' || host === 'dl.dropbox.com' || host === 'dl.dropboxusercontent.com') {
    url.hostname = 'dl.dropboxusercontent.com';
    url.searchParams.delete('dl');
    return { kind: 'url', url: url.href };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return { kind: 'url', url: url.href };
}

export const linkKey = (l) => (l.kind === 'gdrive' ? `gdrive:${l.id}` : `url:${l.url}`);

class LinkError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function driveHeaders(l) {
  return l.resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${l.id}/${l.resourceKey}` } : {};
}

async function driveError(r) {
  let msg = `HTTP ${r.status}`;
  let reason = '';
  try { const j = await r.json(); msg = j.error?.message || msg; reason = j.error?.errors?.[0]?.reason || j.error?.status || ''; } catch { /* not json */ }
  if (r.status === 404) return new LinkError('notfound', msg);
  if (r.status === 400 && /api key/i.test(msg)) return new LinkError('badkey', msg);
  if (r.status === 403 && /(has not been used|disabled|accessNotConfigured)/i.test(msg + reason)) return new LinkError('apidisabled', msg);
  if (r.status === 403 && /referer|referrer/i.test(msg + reason)) return new LinkError('referer', msg);
  if (r.status === 403 || r.status === 401) return new LinkError('private', msg);
  if (r.status === 429) return new LinkError('quota', msg);
  return new LinkError('http', msg);
}

/** What the file behind a link is now: { name, size, modified, version } (for "is there an update?"). */
export async function remoteMeta(l, apiKey) {
  if (l.kind === 'gdrive') {
    if (!apiKey) throw new LinkError('nokey', 'no Google API key');
    const r = await fetch(`${DRIVE}${l.id}?fields=name,size,modifiedTime,md5Checksum,version,mimeType&supportsAllDrives=true&key=${encodeURIComponent(apiKey)}`, { headers: driveHeaders(l), cache: 'no-store' });
    if (!r.ok) throw await driveError(r);
    const j = await r.json();
    return { name: j.name, size: Number(j.size) || 0, modified: j.modifiedTime, version: j.md5Checksum || j.version || j.modifiedTime };
  }
  const r = await fetch(l.url, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
  if (!r || !r.ok) return null; // HEAD not allowed: we cannot tell, the user syncs by hand
  const name = decodeURIComponent(new URL(r.url).pathname.split('/').pop() || 'canvas');
  const version = r.headers.get('etag') || r.headers.get('last-modified') || r.headers.get('content-length');
  return version ? { name, size: Number(r.headers.get('content-length')) || 0, modified: r.headers.get('last-modified'), version } : null;
}

async function opfsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('links', { create: true });
}

/**
 * Download the file behind a link into OPFS. Returns { file: File, name, opfsName, meta }.
 * onProgress(received, total).
 */
export async function downloadLink(l, apiKey, { onProgress, signal, key } = {}) {
  let r;
  let meta = null;
  if (l.kind === 'gdrive') {
    meta = await remoteMeta(l, apiKey);
    r = await fetch(`${DRIVE}${l.id}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(apiKey)}`, { headers: driveHeaders(l), signal, cache: 'no-store' });
    if (!r.ok) throw await driveError(r);
  } else {
    try { r = await fetch(l.url, { signal, cache: 'no-store' }); } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new LinkError('cors', 'the server does not allow downloads from other sites (CORS)');
    }
    if (!r.ok) throw new LinkError(r.status === 404 ? 'notfound' : 'http', `HTTP ${r.status}`);
    meta = { name: decodeURIComponent(new URL(r.url).pathname.split('/').pop() || 'canvas'), size: Number(r.headers.get('content-length')) || 0, version: r.headers.get('etag') || r.headers.get('last-modified') || null, modified: r.headers.get('last-modified') };
  }
  const total = Number(r.headers.get('content-length')) || meta?.size || 0;
  try { await navigator.storage.persist?.(); } catch { /* best effort */ }
  const dir = await opfsDir();
  const opfsName = `${(key || linkKey(l)).replace(/[^\w.-]+/g, '_').slice(0, 80)}-${Date.now()}`;
  const fh = await dir.getFileHandle(opfsName, { create: true });
  const w = await fh.createWritable();
  let got = 0;
  const counter = new TransformStream({
    transform(chunk, ctl) { got += chunk.byteLength; onProgress?.(got, total); ctl.enqueue(chunk); },
  });
  try {
    await r.body.pipeThrough(counter).pipeTo(w, { signal });
  } catch (e) {
    await dir.removeEntry(opfsName).catch(() => {});
    throw e;
  }
  return { file: await fh.getFile(), opfsName, meta: { ...meta, size: got } };
}

export async function openCached(opfsName) {
  const dir = await opfsDir();
  return (await dir.getFileHandle(opfsName)).getFile();
}

export async function removeCached(opfsName) {
  if (!opfsName) return;
  try { await (await opfsDir()).removeEntry(opfsName); } catch { /* gone */ }
}

/** Browser storage used / available, for the settings dialog. */
export async function storageInfo() {
  try {
    const e = await navigator.storage.estimate();
    return { used: e.usage || 0, quota: e.quota || 0, persisted: await navigator.storage.persisted?.() };
  } catch { return null; }
}

export { LinkError };
