# Using IluCanvas as an AI agent

IluCanvas is an infinite reference board. A board is one `.ilucanvas` file — a
ZIP with `canvas.json` (the scene) and the original images. You can work with it
two ways:

1. **Files** (no browser): a single-file Node CLI creates boards, adds images
   from disk or the web, groups and arranges them, edits fields, extracts the
   originals. If the human has the board open in the app, the app notices the
   change within ~2 seconds and shows it (merging with their unsaved edits).
2. **The open page** (you drive a browser): `window.ilucanvas` in the page's
   console does the same operations on the board that is open, live.

If all you have is the site URL (https://ilumetric.github.io/IluCanvas/), start here.

## Get the CLI

One file, no dependencies, Node 20+:

```bash
curl -O https://ilumetric.github.io/IluCanvas/ilucanvas.mjs
node ilucanvas.mjs --version
node ilucanvas.mjs --help          # the source of truth for commands and options
```

`ilucanvas.mjs` is generated from `tools/ilucanvas.mjs` and `src/core/*`
(inside a clone of the repo, `node tools/ilucanvas.mjs …` is the same thing).

## Commands

```bash
# read
node ilucanvas.mjs ls refs.ilucanvas                  # groups and images, one line each
node ilucanvas.mjs ls refs.ilucanvas --group g4k2x9q  # one group
node ilucanvas.mjs ls refs.ilucanvas --json           # assets + items as JSON
node ilucanvas.mjs info refs.ilucanvas                # counts, size, dead space, warnings
node ilucanvas.mjs json refs.ilucanvas                # canvas.json as stored
node ilucanvas.mjs validate refs.ilucanvas            # exit 1 on errors
node ilucanvas.mjs extract refs.ilucanvas --out refs/ [ids…]   # original images

# write — each command re-reads the file, changes it, validates, writes; nothing is written on error
node ilucanvas.mjs new refs.ilucanvas --title "Character refs"
node ilucanvas.mjs add refs.ilucanvas photos/ a.jpg https://example.com/b.png --new-group "Lighting"
node ilucanvas.mjs add refs.ilucanvas c.jpg --group g4k2x9q          # bottom of that group
node ilucanvas.mjs add refs.ilucanvas d.jpg --at 4000,0 --max 800    # top-left at a point, longest side 800
node ilucanvas.mjs set refs.ilucanvas i8k2m1q note="rim light" rot=90 flipX=true
node ilucanvas.mjs set refs.ilucanvas canvas title="Character refs v2"
node ilucanvas.mjs move refs.ilucanvas i8k2m1q i3x9a0b --by 200,0     # or --to X,Y
node ilucanvas.mjs group refs.ilucanvas i8k2m1q i3x9a0b --name "Poses" --color blue
node ilucanvas.mjs ungroup refs.ilucanvas g4k2x9q                     # images move up to its parent
node ilucanvas.mjs arrange refs.ilucanvas g4k2x9q                     # justified rows, aspect kept
node ilucanvas.mjs note refs.ilucanvas '# Lighting\n- [ ] rim\n- [x] key' --color paper   # a document ("\n" = new line)
node ilucanvas.mjs note refs.ilucanvas 'Warm vs cool' --group g4k2x9q                  # a sticky in a group
node ilucanvas.mjs shape refs.ilucanvas diamond 'Approved?' --fill yellow --at 320,0   # a shape with text
node ilucanvas.mjs connect refs.ilucanvas s1a2b3c s7f2k1q --label yes --route elbow    # an arrow between two items
node ilucanvas.mjs connect refs.ilucanvas s7f2k1q 900,300 --end dot --dash             # to a free point
node ilucanvas.mjs rm refs.ilucanvas i8k2m1q [--keep-children]
node ilucanvas.mjs front|back refs.ilucanvas i8k2m1q
node ilucanvas.mjs apply refs.ilucanvas ops.json                      # many changes, one write (below)
node ilucanvas.mjs compact refs.ilucanvas                             # drop dead space
node ilucanvas.mjs from-pur board.pur [out.ilucanvas]                 # convert a PureRef board
```

`--json` gives machine output for `ls`, `info`, `add`, `apply` and the other
write commands (`{ created: [ids], log: [...] }`). Unknown commands, unknown
fields and unknown ids exit with code 2 and write nothing.

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

Items not in a group are not indented; children are indented under their group.

## Batch operations (`apply`)

One JSON array; `"as"` names an id made in the batch, later ops refer to it as
`"$name"`. The same vocabulary works in the browser (`ilucanvas.apply`).

```json
[
  { "op": "newgroup", "name": "Lighting", "color": "violet", "as": "$light" },
  { "op": "note", "text": "# Lighting\nCool rim, **warm key**\n- [ ] night refs", "color": "paper", "group": "$light" },
  { "op": "note", "text": "too dark?", "color": "pink", "x": 900, "y": 40 },
  { "op": "shape", "kind": "rounded", "text": "Sketch", "fill": "blue", "x": 0, "y": 2000, "as": "$a" },
  { "op": "shape", "kind": "diamond", "text": "Approved?", "fill": "yellow", "x": 320, "y": 1960, "as": "$b" },
  { "op": "connect", "from": "$a", "to": "$b", "label": "send", "route": "elbow" },
  { "op": "connect", "from": "$b", "fromSide": "right", "to": { "x": 900, "y": 2060 }, "dash": true },
  { "op": "add", "paths": ["refs/rim.jpg", "refs/night/"], "group": "$light" },
  { "op": "add", "urls": ["https://example.com/sky.jpg"], "x": 4000, "y": 0, "max": 800 },
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
| `note` | `text` (Markdown), `color` (`yellow`… sticky, `paper` document, `none` text), `x`, `y`, `w`, `h`, `size`, `scale`, `align`, `ratio`, `fit`, `group`, `as` — sizes default sensibly; documents grow to fit their text |
| `shape` | `kind` (`rect rounded ellipse diamond triangle parallelogram hexagon star`), `text` (Markdown), `fill`, `stroke`, `x`, `y`, `w`, `h` (default 200×120, 200×200 for round kinds), `size`, `scale`, `align`, `group`, `as` |
| `connect` | `from`, `to` — an id, `"$name"` or `{ "x", "y" }`; `fromSide` / `toSide` (`top right bottom left`, pins the end to that side), `route` (`straight elbow curve`), `start` / `end` heads (`none arrow dot`, default end `arrow`), `color`, `width`, `dash`, `label`, `as` |
| `newgroup` | `name`, `color`, `x`, `y`, `w`, `h` (default: right of everything, 1600×1000), `as` |
| `group` | `ids`, `name`, `color`, `as` — a frame around them; made inside a group, it nests there |
| `set` | `id` (or `"canvas"` with `title`) and fields: `x y w h rot name color note flipX flipY locked parent opacity crop`, for notes also `text fit size scale align ratio`, shapes `kind text fill stroke size scale align`, connectors `from to route start end color width dash label` (`null` removes a field) |
| `move` | `ids` and `dx`/`dy`, or `x`/`y` for the top-left of their bounds; items dropped inside a group join it |
| `arrange` | `id` of a group (its images) or `ids`; `width`, `gap` |
| `fit` | `id` of a group: the frame hugs its items |
| `front`, `back` | `ids` |
| `ungroup` | `id` |
| `rm` | `ids`, `keepChildren` |

Group colours: `violet blue orange green pink yellow red amber grey`. Note colours:
`yellow orange pink green blue violet grey paper none`. Note text is Markdown —
headings, lists, `- [ ]` checklists, quotes, bold / italic / strike / `<u>`,
`==highlight==`, `[text]{.red}` colours, links ([FORMAT.md](FORMAT.md#note-text-markdown-subset)).
Shape fills, outlines and connector colours: `white grey black red orange yellow green blue violet pink`
(shape `fill` also `none`).
Coordinates are board units (1 unit = 1 CSS pixel at 100% zoom), y down.
Moving a group moves everything inside it (nested groups too).
Connectors follow the items at their ends; deleting an item turns the ends on it
into free points. Their `x y w h` are bounds the tools keep up to date — move
the items, not the connector.

## In the browser: `window.ilucanvas`

When you control a browser with the app open (the human's board or one you
opened), use the page's JavaScript console:

```js
ilucanvas.help()                       // this list
ilucanvas.state()                      // { open, title, file, readOnly, dirty, images, groups, selection, view }
ilucanvas.list()                       // the same text as `ls`
ilucanvas.json()                       // canvas.json of the open board
await ilucanvas.apply([...ops])        // same ops as above; add takes "urls"; one undo step for the human
await ilucanvas.addUrls(['https://…/a.jpg'], { group: 'g4k2x9q' })
ilucanvas.select(['i8k2m1q']); ilucanvas.zoomTo(['i8k2m1q']); ilucanvas.zoomTo('all')
await ilucanvas.save(); ilucanvas.undo(); ilucanvas.redo()
ilucanvas.perf({ draw: true })         // renderer numbers: decoded images, memory, frame time
```

Changes go through the app: the human sees them at once, can undo them
(Ctrl+Z), and they are saved like the human's own edits. Web images load only
from sites that allow cross-origin downloads (CORS); otherwise download the
file and use the CLI.

## Rules

- Reference items by id (`i8k2m1q`, `g4k2x9q`). Ids are random, unique and never change.
- Re-read the board right before editing (`ls`), never write back a copy from an earlier turn. Prefer the CLI / ops over editing `canvas.json` by hand; if you do edit it inside the ZIP, keep the format in [FORMAT.md](FORMAT.md) and run `validate`.
- The CLI writes `"updated_by": "agent"`; the app writes `"human"`. Read `updated` / `updated_by` to see who touched the board last.
- Images are stored once per content (SHA-256): adding the same file twice makes two items that share one image.
- A `.pur` (PureRef) file is read only; convert it with `from-pur` to edit.
- Do not delete what you did not create unless asked: the human's references are the point of the board.

## How saving works (why the human never loses a reference)

- The `.ilucanvas` ZIP keeps every original image byte for byte under its own name (`images/…`), so the human can always rename the file to `.zip` and take the pictures out.
- Saves write only what changed: new images are appended, `canvas.json` is rewritten at the end of the file. The app writes through the browser's swap file (atomic); the CLI writes small files to a temp file and renames it, and appends to big ones without touching existing bytes.
- If a write is cut off, the reader rebuilds the directory from the records in the file and finds the last complete `canvas.json`.

More: [FORMAT.md](FORMAT.md) (every field), [SHARING.md](SHARING.md) (Google Drive links), [PUREREF.md](PUREREF.md) (PureRef files), [schema](../schema/canvas.schema.json).
