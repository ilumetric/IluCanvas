# .ilucanvas — format reference (version 1)

A `.ilucanvas` file is a **ZIP archive**. Rename a copy to `.zip` (or open it with
7-Zip) to see what is inside:

```
mimetype              application/x-ilucanvas+zip   (first entry, stored)
canvas.json           the scene (below)
preview.webp          a small cover of the board, for file lists (optional; Safari keeps the old one)
images/<name>.<ext>   the original image files, byte for byte, under their own names
thumbs/<asset>.webp   previews, longest side ≤ 512 px (optional; the app regenerates missing ones;
                      .jpg / .png when written by a browser that cannot encode WebP — Safari)
```

* Images are **stored** (no compression: they are compressed already), so the
  app reads any image straight out of the file without loading the rest.
  `canvas.json` is deflated.
* Names are UTF-8 (flag 11 set), so Cyrillic and other names show correctly in
  Windows Explorer, 7-Zip and others.
* ZIP64 is used when the file grows over 4 GB or 65,535 entries.
* Files other than these are kept as they are (room for future versions);
  `images/` and `thumbs/` entries that no asset refers to are dropped on save.

## How a save is written

The last records of the file are always `preview.webp` and `canvas.json`. A
save keeps everything before them where it is, then writes new images and
previews, a new `preview.webp`, a new `canvas.json` and the ZIP directory
(`tail` mode). Deleting images leaves dead space; when dead space passes 35% of
the file (and 16 MB), the next save rewrites the whole file (`full` mode, also
`ilucanvas compact`). Writers that cannot replace a file atomically append
after the current end instead (`append` mode); a reader that finds no valid
directory at the end rebuilds it from the local records, last copy of a name
winning.

## canvas.json

```json
{
  "format": "ilucanvas",
  "version": 1,
  "id": "cfr2vzglunm7",
  "title": "Character refs",
  "created": "2026-10-20T12:01:24Z",
  "updated": "2026-10-20T12:10:52Z",
  "updated_by": "human",
  "assets": {
    "7e995d4466f2b1d4": {"file":"images/rim light.jpg","type":"image/jpeg","w":6425,"h":3022,"bytes":4209013,"sha256":"7e995d4466f2b1d4…","thumb":"thumbs/7e995d4466f2b1d4.webp","color":"#6b5a52","name":"rim light.jpg","added":"2026-10-20T12:01:24Z"}
  },
  "items": [
    {"id":"gc0u1rnu","type":"group","name":"Lighting","color":"violet","x":-12,"y":-12,"w":1624,"h":399},
    {"id":"i3ezoq56","type":"image","asset":"7e995d4466f2b1d4","x":48,"y":48,"w":594,"h":279,"parent":"gc0u1rnu"}
  ]
}
```

Written with one line per asset and per item; key order fixed; numbers rounded
to 0.01; fields with default values left out.

### Top level

| field | |
|---|---|
| `format` | always `"ilucanvas"` |
| `version` | `1`. A reader keeps fields it does not know. |
| `id` | the board's id (random). The app remembers the last view per id. |
| `title` | shown in the app |
| `created`, `updated` | ISO time, UTC |
| `updated_by` | `"human"` (the app) or `"agent"` (the CLI, `window.ilucanvas`) |
| `assets` | image files, by asset id |
| `items` | everything on the board, in stacking order (later = on top) |

### Assets

The asset id is the first 16 hex digits of the file's SHA-256: the same picture
added twice is stored once. (Boards converted from PureRef in the app may use
other ids; anything unique is fine.)

| field | |
|---|---|
| `file` | path inside the ZIP, `images/…` |
| `type` | `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/bmp`, `image/avif` |
| `w`, `h` | pixel size as displayed (EXIF rotation applied) |
| `bytes`, `sha256` | size and hash of the file |
| `thumb` | path of the preview, `thumbs/<id>.webp` (`.jpg` / `.png` from Safari) (optional) |
| `color` | average colour `#rrggbb` (optional) — shown while loading and when tiny |
| `name` | the original file name |
| `source` | where it came from (URL), optional |
| `added` | ISO time |

### Items

All items: `id`, `type`, `x`, `y`, `w`, `h` (the box in board units, y down,
before rotation), optional `rot` (degrees clockwise, around the box centre;
images, notes, shapes and strokes turn — connectors follow the turned sides),
`parent` (a group id), `locked` (`true`: not moved by the mouse), `note`
(free text). Unknown types are kept and drawn as a dashed box.

**image** — `asset`, optional `flipX` / `flipY` (`true`), `crop` (`{x, y, w, h}`
in the image's own pixels: the visible part), `opacity` (0…1).

**group** — a named frame: `name`, `color` (`violet blue orange green pink yellow red amber grey`).
Items (and groups) inside it have `parent` = its id; groups nest. Groups are
drawn below images; outer groups below inner ones. Moving or deleting a group
takes everything inside it along; ungrouping moves the items up to the group's
own parent.

**note** — text on the board: a sticky, a document or plain text. They differ
only by colour and size; the text is Markdown (below).

| field | |
|---|---|
| `text` | Markdown, every line one paragraph |
| `color` | stickies `yellow orange pink green blue violet grey`; `paper` (a document); `none` (text straight on the board) |
| `fit` | `true`: the text grows / shrinks to fill the card (stickies). Otherwise the font size is fixed and the note grows downwards to show all its text |
| `size` | `s m l xl` — 14 / 18 / 28 / 44 board units (not for `fit` notes); default `m` |
| `scale` | multiplies `size` (text made when zoomed out, notes scaled with a selection); default 1 |
| `align` | `left center right` (the whole note); default `left` |
| `ratio` | `free square a4 wide` — keeps the proportions when resizing; default `free` |

```json
{"id":"n3k9x2aa","type":"note","x":0,"y":0,"w":240,"h":240,"color":"yellow","fit":true,"text":"Rim light\n- [ ] find refs"}
```

### Note text (Markdown subset)

Every line is one paragraph (an empty line is an empty paragraph).

| | |
|---|---|
| `# ` `## ` `### ` | headings |
| `- item` (`*`, `+`) · `1. item` | bullet / numbered list; 2 spaces of indent per level |
| `- [ ] task` · `- [x] done` | checklist (clickable on the board) |
| `> text` | quote |
| `**bold**` `*italic*` `_italic_` `~~strike~~` `<u>underline</u>` | marks |
| `==text==` | yellow highlight |
| `[text]{.red}` · `[text]{.hl-green}` · `[text]{.blue .hl-yellow}` | text colour / highlight colour: `red orange yellow green blue violet pink grey` |
| `[text](https://…)` | link (Ctrl+click opens it) |
| `\*` | a literal character |

**shape** — a figure with text, for diagrams and flowcharts.

| field | |
|---|---|
| `kind` | `rect rounded ellipse diamond triangle parallelogram hexagon star` |
| `fill` | `white grey black red orange yellow green blue violet pink`, a custom `#rrggbb`, or `none` (only the outline); text is light on dark fills |
| `stroke` | outline colour from the same list or `#rrggbb`; none when left out (`grey` when `fill` is `none`) |
| `strokeWidth` | outline width in board units; when left out it grows with the shape |
| `dash` | `true`: a dashed outline |
| `text` | Markdown like a note's, centred inside the figure; the shape grows downwards to show all of it |
| `size`, `scale` | text size, as for notes |
| `align` | `left center right`; default `center` |

```json
{"id":"s7f2k1qa","type":"shape","kind":"diamond","x":320,"y":0,"w":200,"h":200,"fill":"yellow","text":"Approved?"}
```

**connector** — a line or arrow between two ends. An end is `{"id": …}` (it
follows that item), `{"id": …, "side": "top|right|bottom|left"}` (pinned to a
side; otherwise the side facing the other end is chosen as things move) or
`{"x": …, "y": …}` (a free point). When an item is deleted, the ends on it
become free points where they were.

| field | |
|---|---|
| `from`, `to` | the ends |
| `route` | `straight` (when left out), `elbow` (right angles, around the end items), `curve`, `dubins` (arcs and straight lines with a minimum turning radius — a Dubins path; what the tools make by default) |
| `start`, `end` | heads `none arrow dot`; default no start head, `arrow` at the end |
| `color` | `white grey black red orange yellow green blue violet pink`, or a custom `#rrggbb` |
| `width` | line width in board units; default 2 |
| `dash` | `true`: dashed |
| `label` | text in the middle of the line |

`x y w h` of a connector are its bounds, recomputed by the tools whenever its
ends move — read them, do not edit them. Connectors never have a `parent`.

```json
{"id":"c4n8w2pd","type":"connector","from":{"id":"s1a2b3c4"},"to":{"id":"s7f2k1qa","side":"left"},"route":"elbow","end":"arrow","color":"grey","label":"yes","x":200,"y":60,"w":120,"h":40}
```

**stroke** — freehand ink: pen, highlighter or tape.

| field | |
|---|---|
| `tool` | `pen` (pressure changes thickness), `highlighter` (40 % opaque, flat ends), `tape` (55 % opaque ribbon with torn ends) |
| `nib` | `italic` — a pen with a broad, slanted nib (stylus barrel rotation turns it); round when left out |
| `color` | `white grey black red orange yellow green blue violet pink`, or a custom `#rrggbb` |
| `width` | line width in the stroke's own units |
| `dash` | `true`: drawn dashed along its centre line (pen and highlighter) |
| `end` | `"arrow"`: an arrowhead at the stroke's last point (pen and highlighter) |
| `pts` | the samples, flat: `x, y, pressure, x, y, pressure, …` — pressure 0…1 (0.5 for a mouse) |
| `tw` | optional, one number per sample: the stylus barrel rotation in degrees |
| `vw`, `vh` | the size of the box `pts` are measured in, from its top-left |

The points are drawn stretched from `vw × vh` into `x, y, w, h`, so moving
and resizing a stroke never rewrites them (a stroke made twice as big draws
twice as thick). `x y w h` hug the ink. Changing `width` or `tool` with the
tools measures the stroke again (`vw = w` afterwards, `width` in board units).

```json
{"id":"k9f2m1qa","type":"stroke","tool":"pen","color":"red","width":4,"x":96,"y":46,"w":108,"h":38,"vw":108,"vh":38,"pts":[4.2,4.2,0.3,54.2,30.1,0.8,104.2,8.6,0.5]}
```

**video** — a YouTube video by link: a card with its poster; it plays in the
app (the player loads from YouTube). For studying a reference: speed, an A–B
loop, labelled timecodes.

| field | |
|---|---|
| `provider` | `youtube` |
| `videoId` | the 11-character YouTube id |
| `url` | `https://www.youtube.com/watch?v=<id>` |
| `title` | optional, from the video page |
| `asset` | optional: the poster, an ordinary image asset (`images/youtube-<id>.jpg`), so the board shows it offline |
| `start` | seconds to start from (a link's `t=`) |
| `rate` | playback speed 0.25…2; 1 when left out |
| `loop` | `{ "a": seconds, "b": seconds }`, the A–B loop |
| `marks` | timecodes: `[{ "t": seconds, "label": "…", "end"?: seconds }]`, sorted by `t` |
| `duration` | seconds, noted by the app once the player knows it (draws the timecodes on the card) |

```json
{"id":"v8k2m1qa","type":"video","provider":"youtube","videoId":"dQw4w9WgXcQ","url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","title":"…","asset":"263dedc00c8521ab","x":0,"y":0,"w":640,"h":360,"start":43,"rate":0.5,"loop":{"a":60,"b":65},"marks":[{"t":43,"label":"chorus"}]}
```

## Checks (`ilucanvas validate`)

Errors: wrong `format`; an item whose `asset` is not in `assets`; a `parent`
that is not a group; groups inside each other in a circle; duplicate ids;
a connector end that is neither `{id}` nor `{x, y}`, or names an unknown item or the connector itself;
`x y w h` that are not numbers, `w`/`h` ≤ 0; an asset `file` missing from the ZIP.
Warnings: unknown item types, assets nobody uses, missing previews.

JSON Schema: [schema/canvas.schema.json](../schema/canvas.schema.json).
