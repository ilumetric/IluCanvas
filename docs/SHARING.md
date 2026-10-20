# Sharing a board with your team

IluCanvas has no server. To show your board to others you put the
`.ilucanvas` file somewhere they can download it; they open it by link, view it
(read only) and press **Sync** when you change it.

## Google Drive

**You (the owner):**

1. Keep the `.ilucanvas` file in a Google Drive folder. With
   [Google Drive for desktop](https://www.google.com/drive/download/) the
   folder is on your disk (e.g. `G:\My Drive\Refs\`): open that folder in
   IluCanvas and work as usual — every save is uploaded by Drive.
2. In Google Drive: right-click the file → **Share** → General access:
   **Anyone with the link** (Viewer) → **Copy link**.
3. Send the link.

**Them (viewers):** IluCanvas → **Open link** → paste. The file downloads into
the browser's storage and opens read only (also offline later). The board stays
in their boards bar under *From links*. When you save a new version, an amber
dot appears there and the **Sync** button turns amber; it downloads the new
version.

To keep downloaded boards as ordinary files on disk instead (Chrome / Edge):
**Settings → Boards from links → Choose folder…**. New downloads go there under
the file's own name, a sync replaces that file, and boards downloaded earlier
move there on their next sync. Removing such a board from the list leaves its
file in the folder. The browser asks for access to the folder once per session.

Alternative without links: share the Drive *folder* with the team. With Google
Drive for desktop, they open that folder in IluCanvas (*Open folder*) and see
every board in it, always up to date — no API key needed.

### The Google API key (one time)

Web pages are not allowed to download Google Drive files directly; Google's
Drive API is, for files shared "Anyone with the link", with an **API key**. It
only reads public files; it cannot see anything private.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a
   project (any name, e.g. "IluCanvas").
2. **APIs & Services → Library → Google Drive API → Enable.**
3. **APIs & Services → Credentials → Create credentials → API key.**
4. Restrict the key:
   * *Application restrictions* → **Websites**: add the site address, e.g.
     `https://ilumetric.github.io/*` (and `http://localhost:8790/*` for local use).
   * *API restrictions* → **Restrict key** → **Google Drive API**.
5. Put the key into `config.js` (`googleApiKey`) and publish the site. Everyone
   who opens your copy of IluCanvas can then open Drive links — viewers need
   no key and no setup. A key restricted this way is safe to publish in a web
   page: it works only on your site and only for public Drive files.

The Drive API is free; its request quota is far above what viewing a few
boards needs. The download shows its progress.

### When it does not work

| Message | What to do |
|---|---|
| No access | The file is not shared "Anyone with the link". |
| File not found | Wrong link, or the file was deleted / moved to trash. |
| Drive API not enabled | Step 2 above, in the key's project. |
| The key does not work / not allowed on this site | Check `config.js`, and that the site address is in the key's website restrictions. |

## Other places

Any link that serves the file with CORS allowed works the same way: Dropbox
shared links (`?dl=0` is fine — IluCanvas rewrites them), GitHub releases /
raw files, your own server or NAS with `Access-Control-Allow-Origin: *`. Sync
compares the server's ETag / Last-Modified when it sends them; otherwise it
just downloads again.

## Why not real-time collaboration?

The file is the source of truth, and one person edits it. Viewers always see a
complete, consistent version (the one you last saved), and nothing you do needs
an account or a server. Several editors at once is a different design (a sync
server); it can come later.
