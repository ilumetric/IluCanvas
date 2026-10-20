// Shared links: someone puts a .ilucanvas / .pur file on Google Drive (or
// Dropbox, or any server that allows cross-origin downloads), shares a link,
// and others open it here. The file is downloaded into the browser's private
// storage (OPFS) or into a folder the user picked in Settings, and opened from
// there, read only. "Sync" checks whether the file behind the link changed and
// downloads the new version.
//
// Google Drive does not let web pages download files directly; its API does,
// for files shared "Anyone with the link", with an API key (Settings).

import { opfsDir as opfsFolder, opfsStream } from './opfs.js';

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

const opfsDir = () => opfsFolder('links');

// where a downloaded copy lives ("place"): { opfsName } in the browser's storage,
// or { dir, fileName } in a folder the user picked (dir: a directory handle)

const safeName = (name) => String(name || 'canvas.ilucanvas').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120) || 'canvas.ilucanvas';

async function exists(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch { return false; }
}

/** A file name in dir that is not taken yet: "Refs.ilucanvas", "Refs (2).ilucanvas", … */
async function freeName(dir, name) {
  if (!(await exists(dir, name))) return name;
  const m = name.match(/^(.*?)(\.[^.]*)?$/);
  for (let i = 2; i < 1000; i++) {
    const n = `${m[1]} (${i})${m[2] || ''}`;
    if (!(await exists(dir, n))) return n;
  }
  return `${m[1]}-${Date.now()}${m[2] || ''}`;
}

/**
 * Download the file behind a link. Returns { file: File, place, meta }.
 * to: { dir, fileName? } writes into that folder (fileName: overwrite this file —
 * the next version of the same link; a new name otherwise); without it, into OPFS.
 * onProgress(received, total).
 */
export async function downloadLink(l, apiKey, { onProgress, signal, key, to = null } = {}) {
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
  let dir;
  let name;
  let place;
  if (to?.dir) {
    dir = to.dir;
    name = to.fileName || (await freeName(dir, safeName(meta?.name)));
    place = { dir, fileName: name };
  } else {
    try { await navigator.storage.persist?.(); } catch { /* best effort */ }
    dir = await opfsDir();
    name = `${(key || linkKey(l)).replace(/[^\w.-]+/g, '_').slice(0, 80)}-${Date.now()}`;
    place = { opfsName: name };
  }
  const isNew = !(await exists(dir, name));
  let got = 0;
  const counter = new TransformStream({
    transform(chunk, ctl) { got += chunk.byteLength; onProgress?.(got, total); ctl.enqueue(chunk); },
  });
  const body = r.body.pipeThrough(counter);
  let file;
  try {
    if (to?.dir) {
      // the writable goes to a swap file and replaces the file on close: an interrupted
      // sync leaves the previous version in place
      const fh = await dir.getFileHandle(name, { create: true });
      await body.pipeTo(await fh.createWritable(), { signal });
      file = await fh.getFile();
    } else file = await opfsStream(['links'], name, body, { signal }); // works in Safari too
  } catch (e) {
    if (isNew) await dir.removeEntry(name).catch(() => {});
    throw e;
  }
  return { file, place, meta: { ...meta, size: got } };
}

/** The downloaded copy at a place (throws NotFoundError when it is gone). */
export async function openStored(place) {
  if (place.dir) return (await place.dir.getFileHandle(place.fileName)).getFile();
  return (await (await opfsDir()).getFileHandle(place.opfsName)).getFile();
}

/** Delete a copy in the browser's storage. Files in the user's folder stay: they are the user's. */
export async function removeStored(place) {
  if (!place?.opfsName) return;
  try { await (await opfsDir()).removeEntry(place.opfsName); } catch { /* gone */ }
}

/** Is this place in that folder (so a sync overwrites the same file)? */
export async function sameFolder(place, dir) {
  if (!place?.dir || !dir) return false;
  try { return await place.dir.isSameEntry(dir); } catch { return false; }
}

/** Browser storage used / available, for the settings dialog. */
export async function storageInfo() {
  try {
    const e = await navigator.storage.estimate();
    return { used: e.usage || 0, quota: e.quota || 0, persisted: await navigator.storage.persisted?.() };
  } catch { return null; }
}

export { LinkError };
