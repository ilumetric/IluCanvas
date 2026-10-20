#!/usr/bin/env node
// IluCanvas local server — optional. Serves the web app and a folder of
// canvases with a small file API, so the app can open and save .ilucanvas
// files in any browser (also embedded ones, e.g. the Claude app's, where the
// File System Access API is missing). GitHub Pages works without it.
//
//   node tools/serve.mjs [folder] [--port 8790] [--open path/in/folder.ilucanvas]
//
//   GET  /__ilucanvas/info            { app, version, folder }
//   GET  /__ilucanvas/list            { files: [.ilucanvas and .pur paths] }
//   GET  /__ilucanvas/stat?path=p     { mtime, size }
//   GET  /__ilucanvas/file?path=p     the file
//   POST /__ilucanvas/write?path=p&at=N[&size=S&mtime=M]   keep the first N bytes, write the body after them
//        (with size / mtime: only if the file is still that one, else 409 — it changed meanwhile)
//
// Safety: 127.0.0.1 only; the Host header must be this server; writes need the
// X-IluCanvas header (no page on another site can send it without a CORS
// preflight, which is never answered); paths stay inside the folder, dot
// folders are off limits, only *.ilucanvas is written, writes go to a temp
// file renamed over the old one.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
const API = '/__ilucanvas/';
const SKIP_DIRS = new Set(['node_modules', '.git', 'Library', 'Intermediate', 'Saved', 'DerivedDataCache', 'Binaries', '__pycache__']);
const BOARD_RE = /\.(ilucanvas|pur)$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.webmanifest': 'application/manifest+json', '.ilucanvas': 'application/zip', '.pur': 'application/octet-stream',
};

function parseArgs(argv) {
  const out = { folder: process.cwd(), port: 8790, open: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--open') out.open = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-')) out.folder = path.resolve(a);
  }
  return out;
}

/** A path inside `root`, or null when it would leave it or enter a dot folder. `rel` is decoded already. */
function inside(root, rel) {
  const p = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (p.split('/').some((seg) => seg === '..' || (seg.startsWith('.') && seg !== '.'))) return null;
  const abs = path.resolve(root, p);
  const r = path.resolve(root);
  if (abs !== r && !abs.startsWith(r + path.sep)) return null;
  return abs;
}

const toPosix = (p) => p.split(path.sep).join('/');

async function listBoards(root) {
  const files = [];
  let seen = 0;
  async function visit(dir, depth) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > 20000 || files.length >= 500) return;
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 5 && !SKIP_DIRS.has(e.name)) await visit(abs, depth + 1); continue; }
      if (BOARD_RE.test(e.name)) files.push(toPosix(path.relative(root, abs)));
    }
  }
  await visit(root, 0);
  return files.sort();
}

function send(res, status, body, headers = {}) {
  const json = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(json ? JSON.stringify(body) : body);
}

async function api(req, res, url, folder) {
  const name = url.pathname.slice(API.length);
  if (name === 'info' && req.method === 'GET') return send(res, 200, { app: 'ilucanvas', version: VERSION, folder: path.basename(folder) });
  if (name === 'list' && req.method === 'GET') return send(res, 200, { files: await listBoards(folder) });
  const rel = url.searchParams.get('path') || '';
  const abs = inside(folder, rel);
  if (!rel || !abs) return send(res, 400, { error: 'bad path' });
  if (name === 'stat' && req.method === 'GET') {
    try { const s = await fsp.stat(abs); return send(res, 200, { mtime: s.mtimeMs, size: s.size }); } catch { return send(res, 404, { error: 'not found' }); }
  }
  if (name === 'file' && req.method === 'GET') {
    let fh;
    try { fh = await fsp.open(abs, 'r'); } catch { return send(res, 404, { error: 'not found' }); }
    // size and time of the very file sent (it may be replaced meanwhile by a save)
    const s = await fh.stat();
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': s.size, 'Cache-Control': 'no-store', 'X-Mtime': String(s.mtimeMs) });
    const stream = fh.createReadStream({ end: Math.max(0, s.size - 1) });
    stream.on('error', () => res.destroy());
    return stream.pipe(res);
  }
  if (name === 'write' && req.method === 'POST') {
    if (req.headers['x-ilucanvas'] !== '1') return send(res, 403, { error: 'missing X-IluCanvas header' });
    if (!/\.ilucanvas$/i.test(abs)) return send(res, 403, { error: 'only .ilucanvas files can be written' });
    const at = Math.max(0, Number(url.searchParams.get('at')) || 0);
    const size = url.searchParams.get('size');
    const mtime = url.searchParams.get('mtime');
    if (size !== null) {
      // the save was planned on this file: not if an agent (the CLI) wrote it meanwhile
      const s = await fsp.stat(abs).catch(() => null);
      if (!s || s.size !== Number(size) || (mtime !== null && Math.abs(s.mtimeMs - Number(mtime)) > 1)) return send(res, 409, { error: 'the file changed on disk' });
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      if (at > 0) {
        // keep the first `at` bytes of the current file
        const src = await fsp.open(abs, 'r');
        const dst = await fsp.open(tmp, 'w');
        try {
          const buf = Buffer.alloc(8 * 1024 * 1024);
          for (let o = 0; o < at;) {
            const { bytesRead } = await src.read(buf, 0, Math.min(buf.length, at - o), o);
            if (!bytesRead) throw new Error('the file is shorter than expected');
            await dst.write(buf, 0, bytesRead);
            o += bytesRead;
          }
        } finally { await src.close(); await dst.close(); }
      }
      await pipeline(req, fs.createWriteStream(tmp, { flags: at > 0 ? 'a' : 'w' }));
      await fsp.rename(tmp, abs);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    const s = await fsp.stat(abs);
    console.log(`  saved ${toPosix(path.relative(folder, abs))} (${(s.size / 1048576).toFixed(1)} MB, kept ${(at / 1048576).toFixed(1)} MB)`);
    return send(res, 200, { mtime: s.mtimeMs, size: s.size });
  }
  return send(res, 405, { error: 'method not allowed' });
}

/** The app's own files first, then the folder. */
async function serveStatic(req, res, url, folder) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'bad path'); }
  if (rel.endsWith('/')) rel += 'index.html';
  for (const root of folder === APP_ROOT ? [APP_ROOT] : [APP_ROOT, folder]) {
    const abs = inside(root, rel);
    if (!abs) continue;
    try {
      const s = await fsp.stat(abs);
      if (s.isDirectory()) { res.writeHead(301, { Location: `${url.pathname}/` }); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': s.size });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(abs).pipe(res);
    } catch { /* next root */ }
  }
  return send(res, 404, 'not found');
}

export function createServer({ folder = process.cwd(), port = 8790 } = {}) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  return http.createServer(async (req, res) => {
    try {
      if (!hosts.has(String(req.headers.host || '').toLowerCase())) return send(res, 403, 'forbidden host');
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname.startsWith(API)) return await api(req, res, url, folder);
      return await serveStatic(req, res, url, folder);
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
      else res.end();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node tools/serve.mjs [folder] [--port 8790] [--open path/to/canvas.ilucanvas]');
    process.exit(0);
  }
  const server = createServer(args);
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${args.port} is busy — try --port ${args.port + 1}` : e.message);
    process.exit(1);
  });
  server.listen(args.port, '127.0.0.1', () => {
    const q = args.open ? `?file=${encodeURIComponent(args.open)}` : '';
    console.log(`IluCanvas ${VERSION} — http://localhost:${args.port}/${q}`);
    console.log(`  folder: ${args.folder}`);
  });
}
