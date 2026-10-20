# IluCanvas

**An infinite reference board. Every board is one `.ilucanvas` file on your disk.**

Like PureRef or FigJam, but with no server and no accounts: the app is a web
page, the files stay with you. A `.ilucanvas` file is a plain ZIP —
`canvas.json` (what goes where) plus an `images/` folder with the original
pictures under their own names. Rename a copy to `.zip` and take any reference out.

**App:** https://ilumetric.github.io/IluCanvas/ · **Demo:** https://ilumetric.github.io/IluCanvas/?demo

- **Fast on big boards.** Only what is visible gets drawn, each picture at the
  size it has on screen: ≤ 512 px previews are read from the file, originals
  only when you zoom in. A 10,000-picture board shown whole renders in ~9 ms.
  Opening time does not depend on file size.
- **References never get lost.** Saving writes only what changed (new pictures
  and `canvas.json`) and replaces the file atomically; autosave is on. If a
  write is cut off, the file is rebuilt from the records inside the ZIP.
- **Boards panel on the left:** *Open folder* lists every `.ilucanvas` and
  `.pur` in it, with covers; recent files; boards opened by link.
- **Tools:** select (V) and hand (H); named, coloured group frames (Ctrl+G,
  nestable), Arrange (Shift+A), flip, rotate, original size, layer order;
  minimap; drag-and-drop and paste (Ctrl+V) of pictures, folders and images
  from other sites.
- **Three styles** (Fun, Calm, Oli — same as IluBoard) and **six backgrounds**:
  dots, grid, crosses, doodles, garden, plain. Settings apply to every board.
- **PureRef:** `.pur` files open for viewing — just the pictures and their
  layout; *Save as .ilucanvas* makes an editable copy. Format 2.x is verified
  against a real file, 1.x follows the format description ([docs/PUREREF.md](docs/PUREREF.md)).
- **Google Drive links:** share the file with "Anyone with the link" — your team
  opens the board by link, the file downloads to them, updates come with the
  *Sync* button. Needs a Google API key: [docs/SHARING.md](docs/SHARING.md).
- **For agents:** a single-file, dependency-free CLI and `window.ilucanvas` in
  the open page; the app picks up file changes within a couple of seconds.
- Installs as an app (Chrome / Edge → *Install*): `.ilucanvas` and `.pur` then
  open with a double click, and it works offline.

## For agents

```bash
curl -O https://ilumetric.github.io/IluCanvas/ilucanvas.mjs
node ilucanvas.mjs new refs.ilucanvas --title "Character"
node ilucanvas.mjs add refs.ilucanvas refs/ https://example.com/a.jpg --new-group "Lighting"
node ilucanvas.mjs ls refs.ilucanvas
node ilucanvas.mjs apply refs.ilucanvas ops.json     # many changes in one write
node ilucanvas.mjs from-pur board.pur                # PureRef → .ilucanvas
```

More: [docs/AGENT.md](docs/AGENT.md) · format: [docs/FORMAT.md](docs/FORMAT.md) ·
schema: [schema/canvas.schema.json](schema/canvas.schema.json) · [llms.txt](llms.txt).

## How to use

1. Open https://ilumetric.github.io/IluCanvas/ in Chrome or Edge.
2. *Open folder* → the folder where your boards will live. *New canvas* creates a file in it.
3. Drop pictures or folders onto the board, or paste from the clipboard (Ctrl+V).
   Wheel zooms to the cursor; Space or the middle button pans.
4. Everything saves by itself. Copy the file, send it, put it on Google Drive.

**Firefox, Safari and embedded browsers** cannot write to a file on disk: boards
open for viewing there, and saving downloads a copy. For embedded browsers
there is a local server:

```bash
node tools/serve.mjs path/to/folder --port 8790
# http://localhost:8790/?file=board.ilucanvas
```

## Development

No build step, no dependencies, Node 20+.

```bash
npm test               # node --test: ZIP, model, CLI (source and bundle)
npm run bundle         # build ilucanvas.mjs from tools/ilucanvas.mjs + src/core/*
npm run serve          # local server on the examples/ folder
node test/pureref.sample.mjs file.pur out/   # parse a .pur and extract its pictures
```

```
index.html            the app page (GitHub Pages serves the repo root)
src/core/             no DOM: zip, canvasfile (format), model, ops, imageinfo, pureref
src/app/              UI: main, board (drawing and input), images (LOD cache),
                      store (document and saving), disk, remote, minimap, background
tools/ilucanvas.mjs   CLI (source)       ilucanvas.mjs     single-file CLI (generated)
tools/serve.mjs       local server       tools/bundle.mjs  bundler
docs/ schema/ test/ examples/
```

## License

[MIT](LICENSE) © Max Derksen
