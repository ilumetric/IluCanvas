# PureRef `.pur` format and the IluCanvas reader

`src/core/pureref.js` opens PureRef boards read-only and returns the embedded images and where each one sits on the canvas. Text notes are partly supported. This document covers:

* the byte layout as checked against a real file
* what is verified, what is inferred, and what is unknown
* what the parser supports and what it does not

Reference sample: `NewScene.pur`, 5,983,062 bytes, saved by PureRef 2.1.3 (Windows, Qt 6). It contains 2 images and 2 image items. It has no notes, groups, drawings, crops, rotations or flips.

---

## 1. Two formats

| | PureRef 1.x (1.10 – 1.11.x) | PureRef 2.x (2.1.3 sample) |
|---|---|---|
| Container | One flat Qt `QDataStream` | `QDataStream` header plus a **SQLite 3 database** |
| Version string | `"1.10"` | `"2.1"` |
| Image data | Raw bytes back to back after a fixed 224-byte header, with no length prefix. Found through a reference table at the end of the file. | `images.data` BLOB, one row per distinct image |
| Items | Nested records. Each starts with its end offset and a type string (`GraphicsImageItem` or `GraphicsTextItem`). | Table `items` for common fields, plus `items_images`, `items_notes`, `items_groups` and `items_drawings` |
| Transform | `QTransform` (9 doubles) written inline | The same `QTransform`, wrapped in a `QVariant` and stored in a TEXT column (see §2.4) |
| Crop | Inline `QPainterPath` in item coordinates | `items_images.image_bounds`: the same `QPainterPath` in a `QVariant` |
| Image → item mapping | Inline `QTransform`, which FyorDev calls "matrixBeforeCrop", "xCrop/yCrop" and "scaleCrop" | `items_images.image_transform` |
| Hierarchy | Only text items can be children (count field plus nested records) | `items.parent` (`-1` = top level); any item can have a parent, and groups exist |
| Checksum | MD5 hex of bytes [108, EOF) | MD5 hex of every byte after the checksum string |

Both formats use the same coordinate model (§2.5). PureRef 2 kept the 1.x data model and moved it into SQL tables.

---

## 2. PureRef 2.x (verified on the sample)

### 2.1 File header (big-endian `QDataStream`)

| Offset (sample) | Type | Sample value | Meaning |
|---|---|---|---|
| 0 | QString (u32 byte length, then UTF-16BE) | `"2.1"` (length 6) | File format version |
| 10 | u16 | 0 | **unknown**. 1.x stored the top-level item count here. |
| 12 | u16 | 0 | **unknown**. 1.x stored the image item count here. |
| 14 | u64 | 5,967,872 (`0x5B1000`) | File offset of the moved database head. This also equals the database size. |
| 22 | QString | `"2.1.3"` | Application version. Also stored in `metadata.application_version`. |
| 36 | QString | 32 hex characters | MD5 of every file byte after this string (here [104, EOF)). **Verified.** |
| 104 | QByteArray (u32 length + bytes) | 15,082-byte JPEG, 256×256 | Scene thumbnail. Byte-identical to `metadata.thumbnail`. |
| 15,190 | | | End of header = `H` |

A null QString or QByteArray has the length `0xFFFFFFFF`.

### 2.2 The relocated SQLite database

PureRef writes a normal SQLite file of `D` bytes. It then puts its header over the database's first `H` bytes and appends those bytes at the end:

```
file[0 .. H)        header (section 2.1)
file[H .. D)      = db[H .. D)        same offsets as in the database
file[D .. D+H)    = db[0 .. H)        starts with "SQLite format 3\0"
file size = D + H
```

In the sample, `D` = 5,967,872 (1,457 pages of 4,096 bytes) and `H` = 15,190, so database page 4 straddles the boundary. The rebuilt database passes `PRAGMA integrity_check`. This was checked with `node:sqlite` as an oracle; the oracle is not used by the parser.

Strings in the PureRef binary agree with this layout. Its recovery code reports "First try to recover file failed, trying to find header", which means it searches for `SQLite format 3`. The parser does the same when the u64 offset is damaged (§4.4).

Database properties in the sample:

| Property | Value |
|---|---|
| Page size | 4096 |
| Read/write version | 1/1 (rollback journal, not WAL) |
| Text encoding | UTF-8 |
| `auto_vacuum` | 1 (FULL), so page 2 is a pointer-map page |
| `user_version` | 200101 |
| `application_id` | 940753918 (`0x3812C3FE`) |
| Freelist | empty |

### 2.3 Tables

This is the schema exactly as stored in `sqlite_master` (root pages 3–9). `id INTEGER PRIMARY KEY` is the rowid, so the record stores NULL in that column.

```sql
images        (id INTEGER PRIMARY KEY, source_type INTEGER, origin TEXT, source TEXT, format TEXT,
               checksum TEXT, data BLOB, width INTEGER, height INTEGER)
metadata      (id INTEGER PRIMARY KEY, scene_rect TEXT, application_version TEXT, view_transform TEXT,
               thumbnail BLOB, horizontal_scroll INTEGER, vertical_scroll INTEGER, last_save_path TEXT,
               last_load_path TEXT, last_load_checksum TEXT, saved INTEGER)
items         (parent INTEGER, id INTEGER PRIMARY KEY, name TEXT, transform BLOB, sort_order BLOB,
               z REAL, opacity REAL, locked INTEGER, comment INTEGER)
items_images  (image INTEGER, playback_speed REAL, id INTEGER PRIMARY KEY, playback_state INTEGER,
               image_transform BLOB, image_bounds BLOB, playback_frame INTEGER, flags INTEGER)
items_drawings(id INTEGER PRIMARY KEY, strokes BLOB)
items_notes   (text_color TEXT, id INTEGER PRIMARY KEY, fixed_size TEXT, background_color TEXT,
               text TEXT, style INTEGER)
items_groups  (id INTEGER PRIMARY KEY, background_color TEXT, lock_mode INTEGER)
```

The column order is not alphabetical or logical, so the parser reads column names from the stored `CREATE TABLE` SQL instead of hard-coding positions.

| Column | Meaning | Status |
|---|---|---|
| `images.data` | Original file bytes (JPEG/PNG/...) | **verified**: MD5 = `images.checksum` |
| `images.checksum` | MD5 hex of `data`. Used as the image key. | **verified** |
| `images.width/height` | Size PureRef lays the image out at | **verified**: matches the image headers and `image_transform` |
| `images.format` | `"JPG"`, `"PNG"`, ... | verified (sample) |
| `images.source`, `origin` | Original file path. Both are equal in the sample. | verified (sample). Difference between the two is **unknown**. |
| `images.source_type` | 1 in the sample | **unknown**. Probably embedded vs. linked. |
| `items.parent` | Parent item id, `-1` = top level | verified (`-1`). Nesting is **inferred**. |
| `items.name` | File name without extension | verified |
| `items.transform` | `QVariant<QTransform>`: item → parent coordinates | **verified** for translation |
| `items.z` | Stacking order, larger = on top (1, 2 in the sample) | verified (sample). PureRef renumbers it with `row_number() OVER (ORDER BY z)` (SQL in the binary). |
| `items.sort_order` | `QVariant<BigRational>`, order among siblings | decoded for small values only (§2.4) |
| `items.opacity`, `locked` | 1, 0 | Meaning is obvious from the name. Not applied by the parser. |
| `items.comment` | NULL | **unknown** |
| `items_images.image` | `images.id` | verified |
| `items_images.image_transform` | `QVariant<QTransform>`: image pixels → item coordinates. Sample: `translate(-w/2, -h/2)` | **verified** |
| `items_images.image_bounds` | `QVariant<QPainterPath>`: visible (cropped) region in item coordinates. Sample: closed 5-point rectangle ±w/2, ±h/2 | **verified** for "no crop". The crop case is inferred (same model as 1.x). |
| `items_images.flags` | 1 in the sample | **unknown** |
| `items_images.playback_*` | Animated images/videos (1, 0, 0 in the sample) | **unknown / ignored** |
| `metadata.scene_rect` | `QVariant<QRectF>` = bounding box of all items | **verified**: (-3212.5, -1511, 6425, 4229) is exactly the union of both items |
| `metadata.view_transform` | `QVariant<QTransform>` view zoom (0.061 in the sample) | verified (decodes) |
| `metadata.horizontal_scroll/vertical_scroll` | View scroll position (-291, -175) | plausible, not used |
| `metadata.last_save_path`, `last_load_path`, `saved` | Bookkeeping | not used |
| `items_notes.*`, `items_groups.*`, `items_drawings.*` | Notes, groups, pen strokes | **no sample**. Value formats are unknown (§5). |

### 2.4 How Qt values are stored

`transform`, `sort_order`, `image_transform`, `image_bounds`, `scene_rect` and `view_transform` are declared `BLOB` or `TEXT`, but their storage class is **TEXT**. PureRef serializes a `QVariant` with `QDataStream` (big-endian, 64-bit doubles, Qt 5 type numbers). It then stores those bytes as a Latin-1 `QString`, so every byte becomes one code point and SQLite saves it as UTF-8. For example, the double 1.0 (`3F F0 00 …`) appears on disk as `3F C3 B0 00 …`.

To decode, take the UTF-8 text and turn each code point (always ≤ 0xFF) back into one byte. (`node:sqlite` truncates these values at the first NUL, so read them with `CAST(x AS BLOB)` when you use it for debugging.)

`QVariant` layout: `u32 typeId`, `u8 isNull`. If `typeId` is 1024 (User), a `u32 length` and the NUL-terminated type name follow. The payload comes last:

| Type | typeId | Payload |
|---|---|---|
| `QTransform` | 80 | 9 × f64: m11 m12 m13 m21 m22 m23 m31(dx) m32(dy) m33 |
| `QRectF` | 20 | 4 × f64: x, y, w, h |
| `QPainterPath` | 1024 `"QPainterPath"` | i32 n, n × (i32 type, f64 x, f64 y), i32 fill start, i32 fill rule. Type: 0 MoveTo, 1 LineTo, 2 CurveTo, 3 CurveToData. |
| `BigRational` | 1024 `"BigRational"` | numerator, denominator. Each is `i32 sign (-1/0/1)`, `u64 blockCount`, then `blockCount × u32` (least significant block first). Only 1/1 and 2/1 have been seen. The binary contains `BigUnsigned`/`BigInteger` error strings, which match Matt McCutchen's C++ BigInteger library. |

`QTransform` maps a point as `x' = m11·x + m21·y + dx`, `y' = m12·x + m22·y + dy` (row-vector convention). Qt's `a * b` means "apply a, then b".

### 2.5 Coordinate model

```
image pixel (0..w, 0..h)
   --image_transform-->  item coordinates   (clip: image_bounds path, same space)
   --items.transform-->  parent coordinates
   --parent's transform ... -->  scene
```

Sample:

* Image item 0 (6425×3022): `image_transform = translate(-3212.5, -1511)`, `transform = identity`. Its scene rectangle is (-3212.5, -1511) → (3212.5, 1511).
* Image item 1 (1315×1197): `image_transform = translate(-657.5, -598.5)`, `transform = translate(-2555, 2119.5)`. Its scene rectangle is (-3212.5, 1521) → (-1897.5, 2718). It is left-aligned with item 0 and sits 10 units below it.

These rectangles match `metadata.scene_rect` and the layout in the embedded thumbnail.

The ordering SQL in the binary is `SELECT * FROM items ORDER BY items.parent, items.id`, together with the `PARTITION BY parent` used for `sort_order`.

---

## 3. PureRef 1.x (from FyorDev/PureRef-format; NOT verified on a real file)

This layout comes from <https://github.com/FyorDev/PureRef-format> (`purformat/read.py`, `write.py`, `pur.hexpat`). FyorDev's fields have been relabelled as the Qt types they clearly are. No 1.x sample was available, so this is unverified, and the parser adds a warning to every 1.x result. The parser was tested only against a synthetic file built to FyorDev's writer layout.

Header (224 bytes when the app version string is 12 bytes; the parser reads it sequentially, so other lengths also work):

| Offset | Type | Meaning |
|---|---|---|
| 0 | QString | `"1.10"` (also used by 1.11.x) |
| 12 | u16 | Top-level item count (images + texts) |
| 14 | u16 | Image item count |
| 16 | u64 | Offset of the reference section ("file length" in FyorDev) |
| 24 | QString | App version, for example `"1.11.1"` (FyorDev writes 12 zero bytes) |
| 40 | QString | MD5 hex of bytes [108, EOF) |
| 108 | u32 | Next free item id |
| 112 | 4 × f64 | Canvas/scene rectangle. Exact meaning is **unknown**. |
| 144 | QTransform | View transform (zoom in m11/m22) |
| 216 | 2 × i32 | View scroll position |

Then the image data. Raw image bytes (PNG in FyorDev's files) are written back to back with no length prefix. After an image, each additional item that reuses it gets a 4-byte slot that holds the id of the item owning the original.

Each item record looks like this:

* `u64 endOffset`, `QString type`
* `GraphicsImageItem`:
  * `[u32 0 marker for "brute force loaded"]`, `QString source`, `QString name` (absent after the marker)
  * `f64 unknown (1.0)`, `QTransform transform`, `u32 id`, `f64 z`
  * `QTransform imageTransform`, `QPainterPath crop` (in item coordinates)
  * `u32 unknown (1)`, `u8 unknown (0)`, `i64 unknown (-1)`, `u32 childCount`
* `GraphicsTextItem`:
  * `QString text`, `QTransform transform`, `u32 id`, `f64 z`
  * `QColor fg`, `QColor bg` (`i8 spec`, `u16 alpha`, 4 × `u16`; spec 1 = RGB, 2 = HSV with hue in 1/100 degree)
  * `u32 childCount`
* Children (text items) follow the parent's end offset.

At the reference offset: `QString folder`, then 20-byte entries `u32 itemId, u64 start, u64 end` up to EOF. Each entry gives that item's image byte range. A 4-byte range is a duplicate slot; `0xFFFFFFFF` in it means not embedded. The parser uses this table, not PNG signature scanning, to find image bytes. This also lets it handle JPEG data.

---

## 4. What the parser does

```js
import { parsePureRef } from './src/core/pureref.js';
const pur = parsePureRef(uint8Array); // also accepts ArrayBuffer
```

It uses only `Uint8Array`, `DataView` and `TextDecoder`, so it runs in browsers and Node 20+. It contains a small read-only SQLite reader: table B-trees, overflow chains, record format, column names from the schema SQL, and UTF-8/UTF-16 text encodings. The sample parses in about 6 ms.

### 4.1 Result

```js
{
  version: '2.1', appVersion: '2.1.3',
  images: [{ key, data, mime, width, height,          // as specified
             id, format, path, orientation,            // extras
             layoutWidth, layoutHeight }],             // size PureRef lays the image out at
  items:  [{ type: 'image', image, name, path, matrix, crop, x, y, w, h, rotation, flipX, flipY, z, group,
             id, parent, opacity, locked, order,       // extras
             imageMatrix, pixelMatrix, cropPolygon, flags }],
  texts:  [{ text, html, x, y, w, h, matrix, color, background, z, rotation, flipX, flipY,
             scale /* auto-sized notes only */, id, name, parent, group, opacity, style }],
  warnings: [string],
  groups: [{ id, name, parent, group, matrix, z, background, lockMode }],   // extra
  view:   { sceneRect, transform, scrollX, scrollY },                         // extra
  thumbnail: Uint8Array | null,  // 2.x: 256×256 JPEG of the scene
  checksum: string | null,       // MD5 hex from the header (not checked by the parser)
}
```

* **`images`** come in database order (2.x) or first-reference order (1.x). `data` is a subarray of the input when the bytes are contiguous. 2.x images normally span SQLite overflow pages, so `data` is a new copy. `mime` comes from the signature (JPEG, PNG, WebP, GIF or BMP; anything else is `application/octet-stream`). `width`/`height` come from the image header. For JPEGs with an EXIF orientation of 5–8 they are swapped to the displayed size, as browsers show it. `key` is the MD5 checksum (2.x) or the index (1.x).
* **`items[].matrix`** = `[m11, m12, m21, m22, dx, dy]`, the item → scene transform. It equals the stored `items.transform` for top-level items and is composed with the parents for nested ones. `imageMatrix` maps image pixels → item coordinates. `pixelMatrix` maps image pixels → scene (`imageMatrix` then `matrix`).
* **`crop`** is the visible region in the bitmap's own pixels. It is `null` when `image_bounds` covers the whole image. If the clip is not an axis-aligned rectangle in pixel space (for example curves or a rotated clip), `crop` is its bounding box, `cropPolygon` holds the points, and a warning is added.
* **Placement**: `x, y, w, h, rotation, flipX, flipY` describe this transform: `translate(x + w/2, y + h/2) · rotate(rotation°, clockwise, y down) · scale(flipX ? -1 : 1, flipY ? -1 : 1)`, applied to the cropped image drawn as a `w × h` box centred on the origin. In CSS that is `left:x; top:y; width:w; height:h; transform: rotate(rotation deg) scale(±1, ±1)` with a centred origin. A negative determinant is reported as exactly one flip. The parser picks `flipX` or `flipY`, whichever needs the smaller rotation. A vertical flip with no rotation therefore comes out as `flipY`, not as `flipX` plus 180°. Non-uniform scale is kept in `w`/`h`. Skew cannot be represented and adds a warning.
* **`z`** is `items.z`. `items` and `texts` are sorted bottom to top by z, then id. `order` is the decoded `sort_order` (sibling order), or null.
* **`group`** is the id of the nearest ancestor that is a group (2.x), otherwise null. `parent` is the direct parent id.
* **`texts`**: if a note has a fixed size, x/y/w/h/rotation work as for images. Otherwise `x, y` is the note's top-left origin in scene coordinates, `w`/`h` are null, and `rotation`/`scale`/flips apply about that origin. If the text looks like Qt rich text, `html` holds the original and `text` is a plain-text conversion.

### 4.2 Error policy

* Every structural read is bounds-checked. Corrupt input throws `Error('PureRef: … (at byte N)')`, where N is the absolute file offset. Database offsets are mapped back through the relocation. Values assembled from overflow pages report `in <table.column> (item id) at +offset`.
* These problems are reported in `warnings` and skipped, without failing the file:
  * one bad row or cell, or a bad non-root B-tree page
  * an undecodable `QVariant`
  * a missing image or parent
  * an unknown item type
  * an unreadable optional table (`metadata`, `items_notes`, `items_groups`, `items_drawings`)
  * a damaged thumbnail
* A damaged root page of `images`, `items` or `items_images` throws, because no layout can be recovered.
* If the u64 relocation offset is wrong, the parser tries two other locations. First `fileSize - headerLength`, then a search backwards for the `SQLite format 3\0` magic. It adds a warning when it does.
* Fuzz test (not part of the repo): 3,000 mutated or truncated files. Every one either parsed or threw `PureRef: …`, none hung, and the slowest took about 35 ms.

### 4.3 Not supported, or only partly

* **Drawings** (`items_drawings.strokes`, `QList<GraphicsDrawItem::Stroke>`): skipped with a warning.
* **Notes in 2.x**: the columns are known, but no sample contained a note, so the value formats are guessed. The parser accepts a `QVariant<QColor>` or `#AARRGGBB` / `#RRGGBB` for colours and a `QVariant<QSizeF>` for `fixed_size`. It detects HTML text and ignores `style`. Treat note output as best-effort.
* **Groups**: the hierarchy and transform composition follow Qt parent/child rules (child transform relative to parent). No sample had a group, so this is unverified. Group background and lock mode are passed through. Group bounds are not computed.
* **Linked (non-embedded) images**: `data` is empty and `mime` is `application/octet-stream`. A warning is added and `path` is kept.
* **Animated images and videos** (`playback_*`): the stored bytes are returned as they are (GIF plays in a browser). Playback state is ignored.
* **Opacity, locked, `items_images.flags`, grayscale and other display options**: opacity and locked are exposed but not applied. `flags` is exposed, but its meaning is unknown.
* **Other image formats** (TIFF, HEIF, PSD, ...): returned as `application/octet-stream` with the stored size. The app must decode them itself.
* **WAL-mode databases**: rows still in a `-wal` file are invisible. A warning is added. PureRef uses `journal_mode = DELETE`.
* **Checksums** are returned but not checked by the parser. The check script checks them.
* **1.x**: implemented from FyorDev's notes and tested only against a synthetic file.
* The whole file must be in memory. For 2.x the image bytes are copied once, out of the overflow pages.

### 4.4 Still unverified for 2.x (no sample)

The sample has no rotation, flip, crop, note or group. In those cases the math (composition, inverse mapping of the clip path, decomposition) was checked against an independent corner computation on synthetic 2.x files, built by editing a copy of the sample database. Maximum corner error was 1e-13.

What is **not** confirmed is that PureRef itself writes those cases the way §2.5 describes. In particular, it is unconfirmed that a crop changes `image_bounds` and not something else, and that group children are stored relative to the group. Rendering such files in PureRef was not possible, because PureRef was running with the sample open and its command-line interface (`PureRef -c 'load;…' -c 'exportScene;…'`) could have sent commands to that running session. A future 2.x sample with a cropped, rotated, flipped and grouped image plus a note would settle these points. `test/pureref.sample.mjs <file>` prints each item's placement for comparison.

---

## 5. Unknown fields (read safely, ignored)

| Where | Field | Seen |
|---|---|---|
| 2.x header | u16 at 10, u16 at 12 | 0, 0 |
| `images` | `source_type`; `origin` vs `source` | 1; equal |
| `items` | `comment` | NULL |
| `items_images` | `flags`, `playback_speed/state/frame` | 1, 1.0, 0, 0 |
| `items_notes` | `text_color`, `background_color`, `fixed_size`, `text`, `style` value formats | no sample |
| `items_groups` | `background_color`, `lock_mode` value formats | no sample |
| `items_drawings` | `strokes` | no sample |
| `metadata` | `last_load_checksum`, `saved` | NULL, 0 |
| 1.x image item | f64 before the transform (1.0), trailing u32 (1), u8 (0), i64 (-1), "brute force" u32 0 marker | from FyorDev |
| 1.x header | the 4 doubles at 112 | from FyorDev |

---

## 6. Checking it

`node test/pureref.sample.mjs [file.pur] [outDir]` does the following:

* parses the file and prints counts, versions and each item's placement
* checks the header MD5
* checks each image's signature and end marker (JPEG `FFD8…FFD9`, PNG IEND), its header size against the stored size, and its MD5 against `images.checksum`
* writes the images, `thumbnail.jpg`, `layout.json` and `layout.html` (items drawn only from the derived x/y/w/h/rotation/flip/crop) to `outDir`

`file` defaults to `examples/NewScene.pur`, `outDir` to `<temp>/ilucanvas-pur-out`. On the sample, all checks pass. The derived layout matches PureRef's own 256×256 thumbnail and `metadata.scene_rect`.
