# IluCanvas — everything an AI agent needs

**This one file is enough to work with IluCanvas.** Read it top to bottom once;
the other docs ([FORMAT.md](FORMAT.md), [PUREREF.md](PUREREF.md),
[SHARING.md](SHARING.md)) only go deeper.

IluCanvas (https://ilumetric.github.io/IluCanvas/) is an infinite reference
board for artists, like PureRef or FigJam: pictures, groups, sticky notes and
documents, shapes and arrows for diagrams, tables, freehand ink and YouTube
videos on one zoomable canvas. It is a static web page — no server, no accounts. Every
board is **one local file, `name.ilucanvas`**: a ZIP with `canvas.json` (the
scene) and the original images, byte for byte.

## Contents

1. [How you can work with a board](#1-how-you-can-work-with-a-board)
2. [The CLI](#2-the-cli)
3. [Batch operations (`apply`)](#3-batch-operations-apply)
4. [What is on a board (canvas.json)](#4-what-is-on-a-board-canvasjson)
5. [In the browser: `window.ilucanvas`](#5-in-the-browser-windowilucanvas)
6. [The app, as the human uses it](#6-the-app-as-the-human-uses-it)
7. [Rules](#7-rules)
8. [Recipes](#8-recipes)
9. [How saving works, troubleshooting](#9-how-saving-works-troubleshooting)

---

## 1. How you can work with a board

| you have | use |
|---|---|
| a shell with Node 20+ | **the CLI** (section 2): one file, no dependencies, works on `.ilucanvas` files directly. The best way. |
| control of a browser with the app open | **`window.ilucanvas`** (section 5) in the page's console: the same operations on the open board, live, undoable by the human |
| only file access, no Node | unzip the file, edit `canvas.json` by the format in section 4, zip it back (keep `mimetype` first and stored) — last resort |

If the human has the board open in the app while you change the file with the
CLI, the app notices within ~2 seconds, shows the change and merges it with
their unsaved edits. You do not need to ask them to reload.

A PureRef board (`.pur`) is read only: convert it first
(`node ilucanvas.mjs from-pur board.pur`).

## 2. The CLI

```bash
curl -O https://ilumetric.github.io/IluCanvas/ilucanvas.mjs
node ilucanvas.mjs --version
node ilucanvas.mjs --help          # the source of truth for commands and options
```

(Inside a clone of the repo, `node tools/ilucanvas.mjs …` is the same thing.)

```bash
# read
node ilucanvas.mjs ls refs.ilucanvas                  # every item, one line each, with ids
node ilucanvas.mjs ls refs.ilucanvas --group g4k2x9q  # one group
node ilucanvas.mjs ls refs.ilucanvas --json           # assets + items as JSON
node ilucanvas.mjs info refs.ilucanvas                # counts, size, dead space, warnings
node ilucanvas.mjs json refs.ilucanvas                # canvas.json as stored
node ilucanvas.mjs validate refs.ilucanvas            # exit 1 on errors
node ilucanvas.mjs extract refs.ilucanvas --out refs/ [ids…]   # original images (of these items / groups)

# write — each command re-reads the file, changes it, validates, writes; nothing is written on error
node ilucanvas.mjs new refs.ilucanvas --title "Character refs"
node ilucanvas.mjs add refs.ilucanvas photos/ a.jpg https://example.com/b.png --new-group "Lighting"
node ilucanvas.mjs add refs.ilucanvas c.jpg --group g4k2x9q          # at the bottom of that group
node ilucanvas.mjs add refs.ilucanvas d.jpg --at 4000,0 --max 800    # top-left at a point, longest side 800
node ilucanvas.mjs set refs.ilucanvas i8k2m1q note="rim light" rot=90 flipX=true
node ilucanvas.mjs set refs.ilucanvas canvas title="Character refs v2"
node ilucanvas.mjs move refs.ilucanvas i8k2m1q i3x9a0b --by 200,0     # or --to X,Y
node ilucanvas.mjs group refs.ilucanvas i8k2m1q i3x9a0b --name "Poses" --color blue
node ilucanvas.mjs ungroup refs.ilucanvas g4k2x9q                     # its items move up to its parent
node ilucanvas.mjs arrange refs.ilucanvas g4k2x9q                     # justified rows, aspect kept
node ilucanvas.mjs note refs.ilucanvas '# Lighting\n- [ ] rim\n- [x] key' --color paper   # a document ("\n" = new line)
node ilucanvas.mjs note refs.ilucanvas 'Warm vs cool' --group g4k2x9q                  # a sticky in a group
node ilucanvas.mjs shape refs.ilucanvas diamond 'Approved?' --fill yellow --at 320,0   # a shape with text
node ilucanvas.mjs shape refs.ilucanvas rect --fill none --stroke red --stroke-width 6 --dash   # a dashed frame
node ilucanvas.mjs connect refs.ilucanvas s1a2b3c s7f2k1q --label yes --route elbow    # an arrow between two items
node ilucanvas.mjs connect refs.ilucanvas s7f2k1q 900,300 --end dot --dash             # to a free point
node ilucanvas.mjs stroke refs.ilucanvas "0,0 60,40,0.9 120,10" --color red --width 6   # ink (X,Y or X,Y,PRESSURE)
node ilucanvas.mjs stroke refs.ilucanvas "0,0 200,0 260,60" --arrow --dash             # a dashed hand-drawn arrow
node ilucanvas.mjs stroke refs.ilucanvas "0,300 400,300" --tool highlighter --color yellow
node ilucanvas.mjs video refs.ilucanvas "https://youtu.be/dQw4w9WgXcQ?t=43" --at 0,2400   # poster + title fetched
node ilucanvas.mjs table refs.ilucanvas --csv data.csv --at 0,3000              # a table from CSV / TSV (a file or -)
node ilucanvas.mjs table refs.ilucanvas 'Name\tLink\nRim\thttps://…'         # … or from text ("\t", "\n")
node ilucanvas.mjs table refs.ilucanvas --rows 4 --cols 3 --no-copy             # empty; clicks do not copy cells
node ilucanvas.mjs cell refs.ilucanvas t4k2m1q 1 0 '**Rim** light' --fill yellow # one cell (0-based, -1 = last)
node ilucanvas.mjs rm refs.ilucanvas i8k2m1q [--keep-children]
node ilucanvas.mjs front|back refs.ilucanvas i8k2m1q
node ilucanvas.mjs apply refs.ilucanvas ops.json                      # many changes, one write (section 3)
node ilucanvas.mjs compact refs.ilucanvas                             # drop dead space
node ilucanvas.mjs from-pur board.pur [out.ilucanvas]                 # convert a PureRef board
```

`--json` gives machine output for `ls`, `info`, `add`, `apply` and the other
write commands (`{ created: [ids], log: [...] }`). Unknown commands, unknown
fields and unknown ids exit with code 2 and write nothing. `--by human`
records the change as the human's (default `agent`).

`ls` prints:

```
canvas "Character refs" c3k2… · 42 images · 3 groups · 2 shapes · 1 connectors · updated 2026-10-20T12:01:24Z by human
g4k2x9q  group  "Lighting"  violet  x=0 y=0 w=2400 h=1600  (12 items)
  g7h1z0c  group  "Night"  blue  x=1100 y=40 w=800 h=600  (3 items)
    …
  i8k2m1q  image  "rim.jpg"  1920×1080px  x=40 y=40 w=960 h=540  note="rim light"
i3x9a0b  image  "pose 2.png"  1200×1600px  x=2600 y=0 w=600 h=800
s1a2b3c  shape  rounded  "Sketch"  fill=blue  x=0 y=2000 w=200 h=120
s7f2k1q  shape  diamond  "Approved?"  fill=yellow  x=320 y=1960 w=200 h=200
c4n8w2p  connector  s1a2b3c → s7f2k1q.left  "send"  elbow end=arrow  grey
bounds x=0 y=0 w=3200 h=2200
```

Children are indented under their group; notes and shapes show the first line
of their text.

## 3. Batch operations (`apply`)

One JSON array of ops, applied in order, written once (`node ilucanvas.mjs
apply refs.ilucanvas ops.json`, or `-` for stdin). The same vocabulary works in
the browser (`await ilucanvas.apply([...])`). `"as": "$name"` names an id made
in the batch; later ops refer to it as `"$name"`.

```json
[
  { "op": "newgroup", "name": "Lighting", "color": "violet", "as": "$light" },
  { "op": "note", "text": "# Lighting\nCool rim, **warm key**\n- [ ] night refs", "color": "paper", "group": "$light" },
  { "op": "note", "text": "too dark?", "color": "pink", "x": 900, "y": 40 },
  { "op": "shape", "kind": "rounded", "text": "Sketch", "fill": "blue", "x": 0, "y": 2000, "as": "$a" },
  { "op": "shape", "kind": "diamond", "text": "Approved?", "fill": "yellow", "x": 320, "y": 1960, "as": "$b" },
  { "op": "connect", "from": "$a", "to": "$b", "label": "send", "route": "elbow" },
  { "op": "connect", "from": "$b", "fromSide": "right", "to": { "x": 900, "y": 2060 }, "dash": true },
  { "op": "stroke", "points": [[40, 40], [300, 90, 0.8], [560, 40]], "tool": "highlighter", "color": "green", "group": "$light" },
  { "op": "stroke", "points": [[0, 0], [200, 0], [260, 60]], "color": "red", "end": "arrow" },
  { "op": "add", "paths": ["refs/rim.jpg", "refs/night/"], "group": "$light" },
  { "op": "add", "urls": ["https://example.com/sky.jpg"], "x": 4000, "y": 0, "max": 800 },
  { "op": "video", "url": "https://youtu.be/dQw4w9WgXcQ", "rate": 0.5, "marks": [{ "t": 43, "label": "jump" }] },
  { "op": "table", "cells": [["Shot", "Ref", "Status"], ["01", "rim light", "- [ ] find"]], "x": 0, "y": 3000, "as": "$tb" },
  { "op": "cell", "id": "$tb", "row": 1, "col": 2, "text": "- [x] found", "fill": "green" },
  { "op": "row", "id": "$tb", "cells": ["02", "pose", ""] },
  { "op": "col", "id": "$tb", "at": 1, "width": 120, "cells": ["Lens", "35mm", "85mm"] },
  { "op": "row", "id": "$tb", "at": 0, "remove": true },
  { "op": "group", "ids": ["i8k2m1q", "i3x9a0b"], "name": "Poses", "as": "$poses" },
  { "op": "set", "id": "i8k2m1q", "note": "rim light", "rot": 90, "flipX": true },
  { "op": "set", "id": "canvas", "title": "Character refs v2" },
  { "op": "move", "ids": ["$poses"], "dx": 0, "dy": 1200 },
  { "op": "move", "ids": ["i3x9a0b"], "x": 500, "y": 500 },
  { "op": "arrange", "id": "$light", "gap": 24 },
  { "op": "fit", "id": "$poses" },
  { "op": "front", "ids": ["i8k2m1q"] },
  { "op": "ungroup", "id": "g7h1z0c" },
  { "op": "rm", "ids": ["i0000aa"], "keepChildren": false }
]
```

| op | fields |
|---|---|
| `add` | `paths` (CLI: files, folders, http(s) URLs) or `urls` (browser), `group`, `x`/`y` (top-left), `max` (longest side, default 1200), `as` |
| `note` | `text` (Markdown), `color` (`yellow`… sticky, `paper` document, `none` plain text), `x`, `y`, `w`, `h`, `size`, `scale`, `align`, `ratio`, `fit`, `group`, `as` — sizes default sensibly; documents grow to fit their text |
| `shape` | `kind`, `text` (Markdown), `fill`, `stroke`, `strokeWidth`, `dash`, `x`, `y`, `w`, `h` (default 200×120, 200×200 for round kinds), `size`, `scale`, `align`, `group`, `as` |
| `connect` | `from`, `to` — an id, `"$name"` or `{ "x", "y" }`; `fromSide` / `toSide` (`top right bottom left`), `route` (`dubins` default, `curve straight elbow`), `start` / `end` heads (`none arrow dot`; default end `arrow`), `color`, `width`, `dash`, `label`, `as` |
| `stroke` | `points` — `[[x, y], [x, y, pressure], …]` in board units; `tool` (`pen highlighter tape`), `color`, `width` (default 3.5 / 18 / 30), `nib` (`italic`, pen only), `dash`, `end` (`arrow`), `group`, `as` |
| `video` | `url` (YouTube: watch, youtu.be, shorts, embed, live), `title`, `start` (seconds or `1:23`), `rate` (0.25…2), `loop` (`{ a, b }`), `marks` (`[{ t, label, end? }]`), `x`, `y`, `w`, `h` (default 640×360; shorts 360×640), `group`, `as` |
| `table` | `cells` (rows of cells: text, or `{ text, fill, align }`) or `rows` × `cols` empty ones (numbers; default 3 × 3; or lists of heights / widths), `width` / `height` of each column / row (default 200 / 56), `fill`, `size`, `scale`, `align`, `clickCopy` (`false`: clicks do not copy), `x`, `y`, `group`, `as` |
| `cell` | `id` (a table), `row`, `col` (0-based; negative counts from the end), and `text` (Markdown), `fill`, `align` (`null` removes the cell's own fill / align) |
| `row`, `col` | `id` (a table), `at` (where the new one goes, default the end), `cells` (its cells), `height` / `width`; or `remove: true` with `at` (and `to` for a range) |
| `newgroup` | `name`, `color`, `x`, `y`, `w`, `h` (default: right of everything, 1600×1000), `as` |
| `group` | `ids`, `name`, `color`, `as` — a frame around them; made inside a group, it nests there |
| `set` | `id` (or `"canvas"` with `title`) and any editable field of that item (section 4); `null` removes a field |
| `move` | `ids` and `dx`/`dy`, or `x`/`y` for the top-left of their bounds; items dropped inside a group join it |
| `arrange` | `id` of a group (its images) or `ids`; `width`, `gap` |
| `fit` | `id` of a group: the frame hugs its items |
| `front`, `back` | `ids` |
| `ungroup` | `id` |
| `rm` | `ids`, `keepChildren` |

`set` takes: all items `x y w h rot parent locked note`; images `name flipX
flipY opacity crop`; groups `name color`; notes `text color fit size scale
align ratio`; shapes `kind text fill stroke strokeWidth dash size scale align`;
connectors `from to route start end color width dash label`; strokes `tool
nib color width dash end`; videos `title start rate loop marks`; tables `cells cols rows fill size scale
align clickCopy` (`cells` replaces them all — prefer `cell`, `row`, `col`).

## 4. What is on a board (canvas.json)

```
name.ilucanvas (ZIP)
  mimetype              application/x-ilucanvas+zip   (first entry, stored)
  canvas.json           the scene
  preview.webp          a small cover (optional)
  images/<name>.<ext>   the original images, byte for byte
  thumbs/<asset>.webp   previews ≤ 512 px (optional; regenerated when missing)
```

```json
{
  "format": "ilucanvas", "version": 1, "id": "cfr2vzglunm7", "title": "Character refs",
  "created": "2026-10-20T12:01:24Z", "updated": "2026-10-20T12:10:52Z", "updated_by": "human",
  "assets": {
    "7e995d4466f2b1d4": {"file":"images/rim light.jpg","type":"image/jpeg","w":6425,"h":3022,"bytes":4209013,"sha256":"7e995d…","thumb":"thumbs/7e995d4466f2b1d4.webp","color":"#6b5a52","name":"rim light.jpg"}
  },
  "items": [
    {"id":"gc0u1rnu","type":"group","name":"Lighting","color":"violet","x":-12,"y":-12,"w":1624,"h":399},
    {"id":"i3ezoq56","type":"image","asset":"7e995d4466f2b1d4","x":48,"y":48,"w":594,"h":279,"parent":"gc0u1rnu"}
  ]
}
```

- **Coordinates**: board units (1 unit = 1 CSS pixel at 100 % zoom), y down.
  `x y w h` is an item's box before rotation; `rot` turns it clockwise (degrees)
  around the box centre.
- **`items` is the stacking order** (later = on top). Groups are drawn below
  everything else.
- **Assets** are image files by id (the first 16 hex digits of the file's
  SHA-256): the same picture added twice is stored once.
- `updated_by`: `"human"` (the app) or `"agent"` (CLI, `window.ilucanvas`).

### Item types

Every item: `id`, `type`, `x`, `y`, `w`, `h`; optional `rot`, `parent` (a group
id), `locked` (`true`: the mouse does not move it), `note` (free text).
Unknown types and fields are kept as they are.

| type | what it is | its fields |
|---|---|---|
| `image` | a picture | `asset`; `flipX`, `flipY`, `crop` (`{x,y,w,h}` in the image's pixels), `opacity` (0…1) |
| `group` | a named frame; items inside have `parent` = its id; groups nest | `name`, `color` |
| `note` | a sticky, a document or plain text — they differ by colour | `text` (Markdown), `color`, `fit` (`true`: text fills the card, stickies), `size` (`s m l xl` = 14 / 18 / 28 / 44 units), `scale`, `align` (`left center right`), `ratio` (`free square a4 wide`) |
| `shape` | a figure with text, for diagrams | `kind` (`rect rounded ellipse diamond triangle parallelogram hexagon star`), `fill` (or `none`), `stroke`, `strokeWidth`, `dash`, `text`, `size`, `scale`, `align` |
| `connector` | a line / arrow; ends follow their items | `from`, `to` (`{"id"}`, `{"id","side"}` or `{"x","y"}`), `route` (`straight elbow curve dubins`), `start`, `end` (`none arrow dot`), `color`, `width` (default 2), `dash`, `label` — its `x y w h` are computed: never edit them, move its items |
| `stroke` | freehand ink | `tool` (`pen highlighter tape`), `nib` (`italic`), `color`, `width`, `dash`, `end` (`arrow`), `pts` (flat `x, y, pressure, …` in a `vw × vh` box), `vw`, `vh`, `tw` (stylus twist) — make strokes with the `stroke` op, not by hand |
| `video` | a YouTube card; plays in the app | `provider` (`youtube`), `videoId`, `url`, `title`, `asset` (the poster), `start`, `rate`, `loop` (`{a,b}`), `marks` (`[{t,label,end?}]`), `duration` |
| `table` | a grid of cells (FigJam style) | `cols` (widths), `rows` (least heights — a row grows to show its text), `cells` (rows × cols; Markdown text, or `{text, fill?, align?}`), `fill`, `size`, `scale`, `align`, `clickCopy` (`false`: a click does not copy the cell) — `w` = Σ cols, `h` = the rows as drawn; tables do not turn |

**Colours** (fixed, they do not change with the app's theme):

- groups: `violet blue orange green pink yellow red amber grey`
- notes: `yellow orange pink green blue violet grey` (stickies), `paper` (a document), `none` (plain text on the board)
- shapes, connectors, ink: `white grey black red orange yellow green blue violet pink`, or any `#rrggbb`; a shape's `fill` also `none`

**Note, shape and table-cell text is Markdown** (a subset), every line one paragraph:

| | |
|---|---|
| `# ` `## ` `### ` | headings |
| `- item` · `1. item` | lists (2 spaces of indent per level) |
| `- [ ] task` · `- [x] done` | checklist (the human ticks it on the board) |
| `> text` | quote |
| `**bold**` `*italic*` `~~strike~~` `<u>underline</u>` | marks |
| `==text==` | yellow highlight |
| `[text]{.red}` · `[text]{.hl-green}` | text colour / highlight: `red orange yellow green blue violet pink grey` |
| `[text](https://…)` | link |
| `\*` | a literal character |

Full field-by-field reference: [FORMAT.md](FORMAT.md); JSON Schema:
[schema/canvas.schema.json](../schema/canvas.schema.json).

## 5. In the browser: `window.ilucanvas`

When you drive a browser with the app open, use the page's console:

```js
ilucanvas.help()                       // this list
ilucanvas.state()                      // { open, title, file, readOnly, dirty, images, groups, selection, view }
ilucanvas.list()                       // the same text as `ls`
ilucanvas.json()                       // canvas.json of the open board (a string)
await ilucanvas.apply([...ops])        // section 3; add takes "urls"; one undo step for the human
await ilucanvas.addUrls(['https://…/a.jpg'], { group: 'g4k2x9q' })
ilucanvas.select(['i8k2m1q']); ilucanvas.selection()
ilucanvas.zoomTo(['i8k2m1q']); ilucanvas.zoomTo('all')
await ilucanvas.save(); ilucanvas.undo(); ilucanvas.redo()
await ilucanvas.newCanvas()            // a new empty board
ilucanvas.perf({ draw: true })         // renderer numbers: decoded images, memory, frame time
```

Changes go through the app: the human sees them at once, can undo them
(Ctrl+Z), and they are autosaved like the human's own edits. Web images load
only from sites that allow cross-origin downloads (CORS); otherwise download
the file and use the CLI. A PureRef board opened in the app is read only
(`state().readOnly`).

## 6. The app, as the human uses it

Useful when you explain things to the human or click through the page.

- **Where boards live.** Chrome / Edge: *Open folder* picks a folder of
  `.ilucanvas` files on disk (listed in the left sidebar, which also has the
  human's own groups of boards); *Open file*; *New canvas*. Safari / Firefox
  (no file access): boards live in the browser's storage and download as
  `.ilucanvas` files. *Open link*: a Google Drive or web link to a file, read
  only, with a Sync button. A `.pur` (PureRef) file opens read only, with
  *Save as .ilucanvas*.
- **Links**: `?link=<url of a .ilucanvas>` opens a shared board; `?demo=30`
  makes a demo board.
- **Toolbar** (keys): Select V · Hand H · Note N · Shape S (picker: 8 shapes,
  a line, an arrow) · Connector X · Table Shift+T · Pen P · Highlighter
  Shift+P · Tape T · Eraser E · Image I · Video Y.
- **Tables**: a click on a cell selects it and copies its text (Shift+click: a
  range, copied tab-separated — it pastes into spreadsheets); a double click,
  Enter or just typing edits the cell (Tab: the next one; past the last cell a
  new row). The selected table has + bars (a column at the right, a row at the
  bottom), pills above the columns / left of the rows (select the whole one),
  dots between them (insert one there); dragging a border resizes a column /
  row. Its bar: fill, text size, bold / strike / bullets, alignment, "copy on
  click", rows and columns. Arrows move the selected cell, Delete clears it.
- **Mouse**: wheel = zoom to the cursor (Shift + wheel scrolls sideways);
  right button drag = move the board (a right click without moving opens the
  context menu); middle button drag = zoom; Space + drag = move the board.
  Double click = zoom onto the item under the cursor, or centre that point.
  Trackpad: pinch zooms, two fingers zoom or scroll (a setting).
- **Editing**: select an item → a floating bar with its options (colours,
  widths, dash, arrow…). Enter edits the text of a note / shape / connector
  label; F2 renames a group. Snapping to items and to the grid (toggles next
  to the minimap; Ctrl while dragging skips it).
- **Keys**: Shift+1 fit all · Shift+2 fit selection · Shift+0 100 % · Ctrl+G /
  Ctrl+Shift+G group / ungroup · Shift+A arrange · Shift+H / Shift+V flip ·
  Shift+R rotate · `]` / `[` front / back · Ctrl+C / V / D · Alt+drag copies ·
  Shift+drag one axis · Del · Ctrl+Z / Ctrl+Shift+Z · Ctrl+S · Ctrl+B sidebar ·
  M minimap.
- **iPad / Apple Pencil**: the Pencil draws with pressure, fingers pan and
  pinch, a long press opens the menu, a double tap = double click.

## 7. Rules

- **Reference items by id** (`i8k2m1q` images, `g4k2x9q` groups, `s…`
  shapes, `c…` connectors, `k…` strokes, `n…` notes, `v…` videos, `t…` tables). Ids are
  random, unique and never change.
- **Re-read the board right before editing** (`ls`); never write back a copy
  from an earlier turn — the human may have changed it since.
- **Prefer CLI commands / `apply`** over editing `canvas.json` by hand; after a
  hand edit run `validate`.
- **Many changes → one `apply`** (one write, one undo step in the app).
- **Do not delete what you did not create** unless asked: the human's
  references are the point of the board. `rm` of a group deletes its contents
  unless `keepChildren`.
- `.pur` files are read only; `from-pur` makes an editable copy (images,
  groups, text notes, drawings as shapes / lines / ink).
- Move connectors by moving their items; their bounds are computed.
- Place new things where they do not cover existing ones: the default place
  (right of everything, or the bottom of `--group`) already does that.

## 8. Recipes

**A mood board from a folder, sorted into groups:**

```bash
node ilucanvas.mjs new refs.ilucanvas --title "Forest mood"
node ilucanvas.mjs add refs.ilucanvas refs/light/ --new-group "Light"
node ilucanvas.mjs add refs.ilucanvas refs/props/ --new-group "Props"
node ilucanvas.mjs ls refs.ilucanvas            # get the group ids
node ilucanvas.mjs arrange refs.ilucanvas <light-group-id> --gap 24
```

**A flowchart:** `shape` per step (`rounded` for actions, `diamond` for
decisions), `connect` them with `--route elbow` and `--label yes/no`, all in one
`apply` using `"as"` names.

**Annotate a reference:** find its box with `ls`, then a `note` next to it
(`x = image.x + image.w + 40`), a dashed `shape` `rect` with `fill: "none"`
over the detail, and a `connect` from the note to that rectangle.

**A table from data:** `table --csv shots.csv` (or `"op": "table"` with `cells`);
then `cell` for single changes and `row` / `col` to add or remove — never
rewrite `cells` whole when the human may be editing other cells. `ls` prints
a table's rows under it (`| a | b |`), so you can read it back.

**Study a video:** `video` with `rate: 0.5`, `loop: {a, b}` around the moment
and `marks` for the key frames.

**Take the pictures out:** `extract refs.ilucanvas --out dir/` (or rename the
file to `.zip`).

## 9. How saving works, troubleshooting

- The ZIP keeps every original image byte for byte under its own name
  (`images/…`), so the pictures can always be taken out.
- Saves write only what changed: new images are appended, `canvas.json` is
  rewritten at the end of the file. The app writes through the browser's swap
  file (atomic); the CLI writes small files to a temp file and renames it, and
  appends to big ones without touching existing bytes.
- If a write is cut off, the reader rebuilds the directory from the records in
  the file and finds the last complete `canvas.json`.
- Deleting images leaves dead space; `compact` (or the app, past 35 %) drops it.

| problem | what to do |
|---|---|
| exit code 2 | an unknown command / field / id — read the message, `ls` again |
| `add` of a web image fails in the browser | the site blocks CORS: download it and `add` the file with the CLI |
| the human does not see your change | they may have a different file open; `ilucanvas.state().file` in the page, or ask |
| a Google Drive link does not open | the site needs an API key — see [SHARING.md](SHARING.md) |
| a `.pur` cannot be edited | `from-pur` it |
