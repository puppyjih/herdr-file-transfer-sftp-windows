# herdr-file-transfer-sftp-windows

Windows file-transfer mod for Herdr. Uses OpenSSH scp (SFTP by default with modern OpenSSH).

Windows adaptation of [Files Transfer by vladimiryakimenko](https://github.com/vladimiryakimenko/herdr-files-transfer), based on File Icons and Herdr's built-in Files panel. Modified 2026-11-17; see NOTICE. Not an official Herdr release.

## What it adds

- Explorer-style folder navigation: click a folder to enter it, with Back / Up / Terminal folder / Refresh at the top.
- Paste an absolute path into the address bar and press Enter. Use the filter below it for partial names or patterns like **\*.png**.
- Name, size, and modification-date headers toggle ascending/descending sorting; folders stay first. The sort preference persists.
- Ctrl-click to pick items or Shift-click to select a range. Use the download button or right-click the selection.
- The **`>_` icon** next to download Settings opens a new terminal in the browsed folder on the same machine.
- On Windows, **Split** shows a local folder on the left and the Files folder on the right. Select items and use **Upload →** or **← Download**.
- **↓ Settings** remembers a local download folder per machine or Git project. The selected left folder takes priority in Split view.
- Modification dates from Windows and remote POSIX hosts are displayed in the local computer's timezone. Unknown dates sort last.
- Terminal folder tracking defaults to ON. Entering a folder, going Up or Back turns it OFF and pins both the folder and its machine, even when another terminal is selected. Click Terminal folder OFF to turn tracking ON and jump to the current terminal location. Clicking ON explicitly also allows pinning the current location. Browsing never changes the terminal directory.

- Right-click file/folder → download to the Windows Downloads known folder.
- Copy files/folders in Explorer, then Ctrl+V or Paste into this folder in Files.
- Drag files/folders onto a row to upload/copy into that folder.
- New file, new folder, rename, copy path, Show in Explorer, local Recycle Bin.
- Background transfers; existing names get `name (1).ext` instead of replacement.
- Read-only text/Markdown and standard image previews.
- Local Windows files; remote Linux/macOS and remote Windows paths in machines connected to Herdr.

## Install on Windows

Requires the Herdr desktop app, Windows PowerShell 5.1 and Windows OpenSSH `scp.exe`.
Start Herdr with Pixel HQ selected, open PowerShell in this repository, and run:

```powershell
.\install-windows.ps1
```

The installer creates `mods/files-transfer-windows` and clones the current layout to
`pixel-hq-files-transfer-windows`. It connects only the clone's Files block; the Files
button remains the same. Existing names are refused, not overwritten.
Return to the old layout in Settings → Look. No EXE build is needed.

## Remote connections

Use machines already connected in Herdr through SSH (with herdr-core), and configure
non-interactive OpenSSH key/agent authentication. Transfers use the machine's SSH alias
and Windows `scp.exe` with BatchMode=yes. A host that only offers SFTP, without a shell
or Herdr connection, cannot be added as a standalone SFTP session by this mod.

Remote POSIX steps use `sh`/`mktemp` and the original placement script. Remote Windows
filesystem actions use a small PowerShell helper sent in memory; no separate server
software or permanent helper file is installed. Drive/UNC paths select Windows handling.
Use a normal `~/.ssh/config` Host alias for custom ports, keys and IPv6 hosts.

## Implementation and limits

PowerShell helpers use JSON requests (passed through UTF-16LE EncodedCommand), literal
paths and .NET operations. No shell interpolation of file names, no execution-policy
change. A new temporary folder holds transfers until publication. File and directory
moves refuse existing names. Source links/junctions are refused for local recursive copy.
Failed jobs report errors; multiple selected items are not an all-or-nothing transaction:
items already published before a later failure remain at the destination.

On Windows, **Queue** runs one item at a time. It shows measured bytes, a percentage and an
estimated time when the total is known. Large folder trees or unavailable metadata can limit
those estimates. Cancel stops a queued or running transfer before publication, and Retry starts
it again from the beginning. Active transfers are not restored into the UI after an app restart.
Remote permanent deletion still requires the original confirmation dialog. Local deletion
uses the Windows Recycle Bin; cancelling Windows' operation must leave the file in place.
HEIC/AVIF need a codec and are not promised by this port; common PNG/JPEG/GIF/BMP/SVG and
Windows-supported TIFF/ICO are the intended preview formats. macOS paths remain in the
source but are not regression-tested in this adaptation.

## Validation

```powershell
python -X utf8 tests/windows_smoke.py
& "$env:LOCALAPPDATA\Programs\herdr-app\herdr-app.exe" check "$PWD\mods\files-transfer-windows"
```

The smoke check uses disposable local files to exercise Windows filesystem operations,
detached transfers, Unicode/quotes/brackets, duplicate names, hidden folder contents and
Windows destination finalization. It never connects to a user's server unless explicitly invoked with `--remote-machine <alias>`.
A real Windows-to-Linux SCP roundtrip has also passed on a configured test host, with a
Unicode/brackets/apostrophe filename and byte-identical content. Remote Windows helpers
passed an in-memory encoded-command check on local Windows, but a real remote Windows
connection has not been tested. Real remote
Linux/Windows transfers require a configured test host; do not infer those from a local pass.

## Publishing / credits

You may publish a modified version subject to Apache-2.0 and the retained third-party
licenses: keep LICENSE, NOTICE, source attributions, Material Icon Theme's MIT notice,
and Lucide's ISC notice. Mark modified files. A new independent GitHub repository is allowed; a GitHub Fork is not required.
Retain the upstream attribution and all required license notices. Do not include your `.ssh` files, app state, personal logs or machine
addresses in a public repository. The installer never creates or pushes a GitHub repository.
See LICENSE, NOTICE, and the LICENSE-* files inside the mod. Original documentation is
in UPSTREAM_README.md; its macOS installation command is not the Windows installer.
