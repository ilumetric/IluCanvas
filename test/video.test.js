import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVideoUrl, parseTime, formatTime, cleanMarks } from '../src/core/video.js';
import { emptyCanvas, normalize, serialize, validate, usedAssets, pruneAssets } from '../src/core/model.js';
import { applyOps } from '../src/core/ops.js';
import { listText } from '../src/core/describe.js';

test('YouTube links: every form, start times, shorts', () => {
  const id = 'dQw4w9WgXcQ';
  for (const u of [`https://www.youtube.com/watch?v=${id}`, `https://youtu.be/${id}`, `https://m.youtube.com/watch?v=${id}&list=x`, `https://www.youtube.com/embed/${id}`, `https://www.youtube.com/live/${id}?si=1`, `https://music.youtube.com/watch?v=${id}`, `https://www.youtube-nocookie.com/embed/${id}`]) {
    assert.equal(parseVideoUrl(u)?.videoId, id, u);
  }
  assert.equal(parseVideoUrl(`https://youtu.be/${id}?t=1m30s`).start, 90);
  assert.equal(parseVideoUrl(`https://www.youtube.com/watch?v=${id}&t=43`).start, 43);
  assert.equal(parseVideoUrl(`https://www.youtube.com/shorts/${id}`).short, true);
  assert.equal(parseVideoUrl('https://vimeo.com/123'), null);
  assert.equal(parseVideoUrl('https://www.youtube.com/watch?v=short'), null);
  assert.equal(parseVideoUrl('not a link'), null);
});

test('times: parse and format', () => {
  assert.equal(parseTime('90'), 90);
  assert.equal(parseTime('1:30'), 90);
  assert.equal(parseTime('01:02:03'), 3723);
  assert.equal(parseTime('1h2m3s'), 3723);
  assert.equal(parseTime('2.5s'), 2.5);
  assert.equal(parseTime('soon'), null);
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTime(83.456, { digits: 2 }), '1:23.46');
  assert.deepEqual(cleanMarks([{ t: '1:00', label: 'b' }, { t: 5, end: 3, label: 'a' }, { t: 'x' }]), [{ t: 5, label: 'a' }, { t: 60, label: 'b' }]);
});

test('video items: op, set, poster asset, normalize, validate, list', async () => {
  const d = emptyCanvas();
  d.assets.p1 = { file: 'images/youtube-x.jpg', type: 'image/jpeg', w: 1280, h: 720 };
  const r = await applyOps(d, [
    { op: 'video', url: 'https://youtu.be/dQw4w9WgXcQ?t=20', marks: [{ t: '0:43', label: 'chorus' }], as: '$v' },
    { op: 'set', id: '$v', rate: 0.5, loop: { a: '1:00', b: 65 }, start: '0:10', title: 'Rick' },
  ], { videoMeta: async () => ({ asset: 'p1', title: 'from oEmbed' }) });
  const v = d.items.find((i) => i.id === r.created[0]);
  assert.equal(v.asset, 'p1');
  assert.equal(v.title, 'Rick');
  assert.equal(v.start, 10);
  assert.deepEqual(v.loop, { a: 60, b: 65 });
  assert.equal(v.w / v.h, 16 / 9);
  assert.ok(usedAssets(d).has('p1'), 'the poster counts as used');
  assert.deepEqual(pruneAssets(d), []);
  assert.ok(validate(d).ok, JSON.stringify(validate(d).errors));
  assert.deepEqual(normalize(serialize(d)).items, normalize(JSON.parse(serialize(d))).items);
  assert.match(listText(d), /video {2}youtube dQw4w9WgXcQ {2}"Rick" {2}start=0:10 rate=0.5 loop=1:00-1:05 1 marks/);
  await assert.rejects(() => applyOps(d, [{ op: 'video', url: 'https://example.com' }]), /YouTube link/);
  await assert.rejects(() => applyOps(d, [{ op: 'set', id: v.id, rate: 4 }]), /rate must be/);
  await assert.rejects(() => applyOps(d, [{ op: 'set', id: v.id, loop: { a: 5, b: 2 } }]), /loop must be/);
  // without a poster
  const r2 = await applyOps(d, [{ op: 'video', url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' }]);
  assert.equal(d.items.find((i) => i.id === r2.created[0]).asset, undefined);
  // a bad id or a missing poster is reported
  const bad = normalize({ format: 'ilucanvas', assets: {}, items: [{ id: 'v', type: 'video', videoId: 'nope', asset: 'gone', x: 0, y: 0, w: 1, h: 1 }] });
  const msgs = validate(bad).errors.map((e) => e.msg).join(' | ');
  assert.match(msgs, /YouTube video id/);
  assert.match(msgs, /unknown asset "gone"/);
});
