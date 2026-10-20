// One line of text per item: what `ilucanvas ls` and `window.ilucanvas.list()`
// print, so an agent reads a board the same way in a terminal and in a browser.

import { childrenOf, groupsOf, contentBounds } from './model.js';
import { plainText } from './markdown.js';

const r0 = (v) => Math.round(v);
const box = (it) => `x=${r0(it.x)} y=${r0(it.y)} w=${r0(it.w)} h=${r0(it.h)}`;
const firstLine = (text) => plainText(text || '').split('\n').find((l) => l.trim()) || '';
const end = (e) => (e.id ? `${e.id}${e.side ? `.${e.side}` : ''}` : `(${r0(e.x)},${r0(e.y)})`);

/** `canvas "Title" c3k2… · 42 images · 3 groups · 2 notes · updated … by …` */
export function headerLine(doc) {
  const count = (type, word) => {
    const n = doc.items.filter((i) => i.type === type).length;
    return n ? ` · ${n} ${word}` : '';
  };
  return `canvas "${doc.title}" ${doc.id} · ${doc.items.filter((i) => i.type === 'image').length} images · ${groupsOf(doc).length} groups${count('note', 'notes')}${count('shape', 'shapes')}${count('connector', 'connectors')}${count('stroke', 'strokes')} · updated ${doc.updated || '?'} by ${doc.updated_by || '?'}`;
}

export function itemLine(doc, it) {
  switch (it.type) {
    case 'group':
      return `${it.id}  group  "${it.name}"  ${it.color}  ${box(it)}  (${childrenOf(doc, it.id).length} items)`;
    case 'image': {
      const a = doc.assets[it.asset] || {};
      const extra = [it.rot ? `rot=${r0(it.rot)}` : '', it.flipX ? 'flipX' : '', it.flipY ? 'flipY' : '', it.crop ? 'cropped' : '', it.locked ? 'locked' : ''].filter(Boolean).join(' ');
      return `${it.id}  image  "${a.name || a.file || it.asset}"  ${a.w || '?'}×${a.h || '?'}px  ${box(it)}${extra ? `  ${extra}` : ''}${it.note ? `  note="${it.note}"` : ''}`;
    }
    case 'note': {
      const more = (it.text || '').split('\n').length - 1;
      return `${it.id}  note  "${firstLine(it.text).slice(0, 60)}"${more ? ` (+${more} lines)` : ''}  ${it.color}${it.fit ? ' sticky' : ''}  ${box(it)}`;
    }
    case 'shape':
      return `${it.id}  shape  ${it.kind}  "${firstLine(it.text).slice(0, 60)}"  fill=${it.fill}${it.stroke ? ` stroke=${it.stroke}` : ''}  ${box(it)}`;
    case 'connector':
      return `${it.id}  connector  ${end(it.from)} → ${end(it.to)}${it.label ? `  "${it.label}"` : ''}  ${it.route || 'straight'}${it.start ? ` start=${it.start}` : ''} end=${it.end}  ${it.color}`;
    case 'stroke':
      return `${it.id}  stroke  ${it.tool}${it.nib ? ` ${it.nib}` : ''}  ${it.color}  width=${Math.round(it.width * 10) / 10}  ${(it.pts?.length || 0) / 3} points  ${box(it)}`;
    default:
      return `${it.id}  ${it.type}  ${box(it)}`;
  }
}

/** The whole board (or one group), groups first, children indented under their group. */
export function listText(doc, { group = null } = {}) {
  const lines = [headerLine(doc)];
  const walk = (parent, ind) => {
    for (const g of doc.items) if (g.type === 'group' && (g.parent || null) === parent) { lines.push(ind + itemLine(doc, g)); walk(g.id, `${ind}  `); }
    for (const it of doc.items) if (it.type !== 'group' && (it.parent || null) === parent) lines.push(ind + itemLine(doc, it));
  };
  if (group) {
    const g = doc.items.find((it) => it.id === group);
    lines.push(itemLine(doc, g));
    walk(group, '  ');
    return lines.join('\n');
  }
  walk(null, '');
  const b = contentBounds(doc);
  if (b) lines.push(`bounds ${box(b)}`);
  return lines.join('\n');
}
