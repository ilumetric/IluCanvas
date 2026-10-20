# Roadmap — the whole canvas

Agreed with the owner on 2026-10-20. One architecture for every object type, so
new features are new item types, not new subsystems.

## Principles

- **Everything is an item** in `canvas.json` `items`: today `image`, `group`,
  `note`, `shape`, `connector`, `stroke`, `video`, `table`. Every type gets the same
  selection, move, resize, groups, undo, autosave, minimap, agent ops.
- **Drawn on the canvas**, like images (fast with thousands of items; correct
  stacking — a note can lie under a picture). Real DOM appears only while
  working: the text editor while editing a note / shape, the player while a
  video plays. They float on top during that time.
- **Fixed colours** for ink, shapes and text marks (they do not change with
  the Fun / Calm / Oli style). The UI chrome keeps following the style.
- **No dependencies**: perfect-freehand (MIT) is vendored as one file in
  `src/app/vendor/` (only drawing needs it).
- Unknown item types keep round-tripping (already true), so older app versions
  do not destroy new content. Format stays `version: 1`; types are additive.

## 1. UI scale

Settings → *Interface scale*, 80–150 % (step 10). Scales panels, toolbar, menus,
dialogs, toasts and group name tags; the board itself does not change. CSS
`zoom` on the UI layers + a `uiScale` factor for labels drawn on the canvas.

## 2. Notes — sticky to document (`note`)

One type covers all three uses; they differ by colour and size only:

| use | look |
|---|---|
| sticky | small, coloured paper, text **fits** the card (font shrinks, FigJam style) |
| document | large, `paper` colour, A4 or free ratio, grows downwards (or scrolls) |
| plain text | `none` colour: text straight on the board |

```json
{"id":"n3k…","type":"note","x":0,"y":0,"w":240,"h":240,"color":"yellow","fit":true,"text":"# Title\nBody **bold** ==marked=="}
```

- `color`: `yellow orange pink green blue violet grey paper none`; `fit`
  (sticky behaviour) on by default for new stickies; `ratio`: `free square a4 wide`;
  `align`: `left center right` (whole note).
- **`text` is Markdown**, a small subset: `#`–`###` headings, `**bold**`,
  `*italic*`, `<u>underline</u>`, `~~strike~~`, `- ` / `1. ` lists,
  `- [ ] ` / `- [x] ` checklists, `> ` quotes, `[link](url)`. Plus two
  extensions:
  - highlight: `==text==` (yellow) or `[text]{.hl-green}`
  - text colour: `[text]{.red}`
  Colours: `red orange yellow green blue violet pink grey`.
  Not planned (keep it simple): tables, code, images inside notes.
- Editing: Enter (or the menu) → a contentEditable editor over the note with a small
  formatting bar (H1–H3, B, I, U, S, lists, checklist, quote, link, colour,
  highlight, align); Markdown shortcuts while typing (`# `, `- `, `[ ] `, `**`).
- Checklist boxes toggle with a click on the board, without editing.
- Rendering: our own text layout on the canvas (Markdown → blocks → lines,
  word wrap by `measureText`), cached per item; tiny on screen → grey lines.

## 3. Connectors (`connector`)

```json
{"id":"c7…","type":"connector","from":{"id":"s1","side":"right"},"to":{"id":"s2"},"route":"elbow","start":"none","end":"arrow","color":"grey","width":2,"dash":false,"label":"yes"}
```

- Ends attach to items (`id` + optional `side` `top right bottom left`, or
  auto: the nearest side) or are free points (`{"x":…, "y":…}`); attached
  ends follow their items.
- `route`: `straight elbow curve dubins` (dubins by default); heads: `none arrow dot`; colour, width,
  dash, a label in the middle.
- A toolbar tool, and in select mode hovering an item shows four dots to drag
  a connector from (FigJam). Deleting an item turns its connector ends into
  free points.
- `x y w h` are kept up to date as the bounds (for culling, groups, minimap).

## 4. Shapes with text (`shape`)

```json
{"id":"s1","type":"shape","kind":"diamond","x":0,"y":0,"w":200,"h":120,"fill":"blue","stroke":"none","text":"Approved?"}
```

- `kind`: `rect rounded ellipse diamond triangle parallelogram hexagon star`.
- `fill`, `stroke`: the fixed colours or `none`; text centred, same Markdown
  subset and editor as notes.
- With connectors: flowcharts. A toolbar tool with a shape picker.

## 5. Ink (`stroke`) — pen, highlighter, tape, eraser

Behaviour from GuitarCanvas (`E:\Git\GuitarCanvas\src\core\ink.ts`), storage our own:

- **Pen**: round or italic (fountain) nib; pressure → thickness only; stylus
  twist turns the italic nib; perfect-freehand smoothing.
- **Highlighter**: 40 % opacity, chisel ends.
- **Tape**: washi tape, serrated torn ends, 55 % opacity — its own toolbar button.
- **Eraser**: removes whole strokes it touches (object eraser); the stylus
  back end erases too.
- Palette: the ten fixed colours shared with shapes and connectors (Apple
  dark-mode shades) plus a custom colour picker (HSV wheel, hex, eyedropper,
  recent colours; stored as `#rrggbb`); 5 width
  presets per tool, as sizes on screen (drawn zoomed out, ink is wider); every
  tool remembers its own colour / width / nib (browser preference).
- Input: coalesced pointer events, touch ignored while a pen is down (palm
  rejection), mouse = constant pressure.

```json
{"id":"k9…","type":"stroke","tool":"pen","color":"blue","width":3.5,"x":10,"y":20,"w":180,"h":64,"vw":180,"vh":64,"pts":[0.5,12.25,0.5, 3,11,0.62]}
```

`pts` is a flat array `x, y, pressure` (2 decimals) measured in a `vw × vh`
box, drawn stretched into `x y w h` — resizing does not rewrite the points;
`tw` holds the stylus twist per sample. The outline (a Path2D) is computed
once per `pts` array and cached. Details: [FORMAT.md](FORMAT.md).

## 6. Video by link (`video`)

```json
{"id":"v2…","type":"video","provider":"youtube","videoId":"dQw4w9WgXcQ","url":"https://youtu.be/…","title":"…","poster":"images/video-dQw4w9WgXcQ.jpg","x":0,"y":0,"w":640,"h":360,"rate":0.5,"loop":{"a":12.4,"b":15.1},"marks":[{"t":83.5,"label":"contact"},{"t":91,"end":94.2,"label":"jump"}]}
```

- YouTube only for now (official embed / IFrame API). Paste a link (or drop it)
  → a card with the poster; the player starts only when clicked (50 videos on a
  board cost nothing).
- **Poster saved in the file** as an asset, so the board shows it offline.
- **Reference study**: speed 0.25–2 (5 % steps), A–B loop, frame step
  (±1/30 s), and **timecodes**: a list of labelled marks (`t`, optional `end`
  for a range, `label`); click to jump, add the current time with a label;
  `?t=` from the link becomes the start.

## 7. Tables (`table`)

```json
{"id":"t4…","type":"table","x":0,"y":0,"w":400,"h":112,"fill":"white","cols":[200,200],"rows":[56,56],"cells":[["Name","Link"],[{"text":"**Rim**","fill":"yellow"},"https://…"]]}
```

- FigJam style: + bars at the right / bottom add a column / row; pills above
  the columns and left of the rows select a whole one; dots between them
  insert one there; borders drag to resize. Rows grow to show their text.
- A cell is Markdown (the notes' layout and editor: a cell is laid out as a
  small note). A click selects a cell and copies it (Shift: a range, copied
  as TSV + an HTML table); `clickCopy: false` turns copying off per table. A
  double click, Enter or typing edits; Tab moves on, past the last cell a new
  row. Arrows move the selection, Delete clears it.
- The bar: fill (the selected cells or the table), text size, bold / strike /
  bullets over whole cells, alignment, copy on click, rows and columns.
- Agents: ops `table` (cells or rows × cols), `cell`, `row`, `col`; CLI
  `table --csv`, `cell`; `ls` prints the rows.

## Toolbar

Select (V), Hand (H) · Note (N), Shape (S ▸ picker), Connector (X), Table (Shift+T) · Pen (P),
Highlighter (Shift+P), Tape (T), Eraser (E) · Image (I), Video (Y). A tool's options slide out next to the toolbar (like GuitarCanvas'
brush bar).

## Agent ops (CLI `apply` and `window.ilucanvas`)

New ops: `note` (Markdown `text`), `shape`, `connect` (`from`, `to`, `label`,
`route`, heads), `stroke` (`pts`), `video` (`url`, `marks`), and `set` for all
new fields. `ls` prints notes / shapes with the first line of their text and
connectors as `s1 → s2 "yes"`.

## Order of work

1. UI scale; the text engine (Markdown subset → layout → canvas, editor). Notes. *(done)*
2. Shapes and connectors. *(done)*
3. Ink: pen, highlighter, tape, eraser. *(done)*
4. Video. *(done)*
5. PureRef on our rails: a `.pur` opens as ordinary IluCanvas items — its
   groups become our groups, its text notes our notes, its drawings our strokes.
   No PureRef-specific widgets. *(done: groups, notes, drawings — shapes, lines, ink)*
6. Tables. *(done)*
