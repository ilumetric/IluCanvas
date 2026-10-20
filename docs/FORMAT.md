# .ilucanvas — format reference (version 1)

A `.ilucanvas` file is a **ZIP archive**. Rename a copy to `.zip` (or open it with
7-Zip) to see what is inside:

```
mimetype              application/x-ilucanvas+zip   (first entry, stored)
canvas.json           the scene (below)
preview.webp          a small cover of the board, for file lists (optional)
images/<name>.<ext>   the original image files, byte for byte, under their own names
thumbs/<asset>.webp   previews, longest side ≤ 512 px (optional; the app regenerates missing ones)
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
| `thumb` | path of the preview, `thumbs/<id>.webp` (optional) |
| `color` | average colour `#rrggbb` (optional) — shown while loading and when tiny |
| `name` | the original file name |
| `source` | where it came from (URL), optional |
| `added` | ISO time |

### Items

All items: `id`, `type`, `x`, `y`, `w`, `h` (the box in board units, y down,
before rotation), optional `rot` (degrees clockwise, around the box centre),
`parent` (a group id), `locked` (`true`: not moved by the mouse), `note`
(free text). Unknown types are kept and drawn as a dashed box.

**image** — `asset`, optional `flipX` / `flipY` (`true`), `crop` (`{x, y, w, h}`
in the image's own pixels: the visible part), `opacity` (0…1).

**group** — a named frame: `name`, `color` (`violet blue orange green pink yellow red amber grey`).
Items (and groups) inside it have `parent` = its id; groups nest. Groups are
drawn below images; outer groups below inner ones. Moving or deleting a group
takes everything inside it along; ungrouping moves the items up to the group's
own parent.

Planned item types (not in version 1 yet): `note` (sticky notes), `stroke`
(pencil drawing), `widget`.

## Checks (`ilucanvas validate`)

Errors: wrong `format`; an item whose `asset` is not in `assets`; a `parent`
that is not a group; groups inside each other in a circle; duplicate ids;
`x y w h` that are not numbers, `w`/`h` ≤ 0; an asset `file` missing from the ZIP.
Warnings: unknown item types, assets nobody uses, missing previews.

JSON Schema: [schema/canvas.schema.json](../schema/canvas.schema.json).
