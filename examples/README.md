# examples

Local boards for trying the app (`npm run serve` serves this folder; open
`http://localhost:8790/?file=<name>.ilucanvas`). Everything here except this
file is ignored by git: boards may hold private references.

Make one:

```bash
node ilucanvas.mjs new examples/try.ilucanvas --title "Try"
node ilucanvas.mjs add examples/try.ilucanvas path/to/images/ --new-group "Refs"
```

Or open `http://localhost:8790/?demo=30` (generated pictures; `?demo=2000` for a load test).
