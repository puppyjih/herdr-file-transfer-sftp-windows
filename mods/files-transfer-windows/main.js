// Modified for Windows and remote Windows hosts, 2026-11-17. See NOTICE.
// Files Transfer: Herdr's Files panel with VS Code's Material Icon Theme icons and file transfer.
// A lazy file browser for the focused pane's folder, with bounded read-only previews, and a
// right-click menu that downloads, uploads (paste from Finder, or drop), copies paths, creates,
// renames, moves to the Trash (here) or deletes (remote),
// on this computer or on the remote machine the space runs on (over ssh).
//
// Based on File Icons by amster93 (https://github.com/amster93/herdr-file-icons, Apache-2.0),
// itself modified from Herdr's shipped `files` mod (https://github.com/herdrdev/herdr-app,
// Apache-2.0). Added here: the menu, transfers, create/rename/trash/delete, drop, previews,
// English/Russian text.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, InputState, Input } from "gpui-base";
import { spaces, panes, focused, run, exec, readTextFile, watchFolder, theme, settings, window, props, openOverlay, closeOverlay, shared, setShared, notify, hc, appHome, home, checking, pickFolder, layout } from "herdr";
import ICONS from "./icons.js";
import {browserPath,parentPath,joinPath,folderAddress,sortedEntries,modifiedLabel,matchesName,selectRows} from "./browser.js";
import {win, winResult, normalize, jobPath, isWindowsPath} from "./windows.js";
const windowsHost = () => window()?.platform === "windows";
const windowsTarget = (on, path) => on ? isWindowsPath(path) : windowsHost();

// Right-click menu on a file or folder: download it to ~/Downloads (scp from a remote
// machine, cp here), paste files copied in Finder into it (upload), copy its path, show it
// in Finder, delete it after a confirmation. Files dropped from Finder upload too. The menu
// and the confirmation are this mod opened as a popup / dialog (props().menu, .confirm);
// they hand the choice to the panel that opened them through shared "files.request", since
// an overlay's tasks end when it closes and a transfer can take long.
const REQUEST = "files-transfer-windows.request";
const LANG_KEY = "files-transfer-windows.lang";
const MENU_ROW = 31;
// Our temporary folders, never listed in the tree.
const TEMP = /^\.herdr-(upload|download)\./;
// Runs detached so a download isn't bound by exec's 30 s. It fetches into a hidden
// temporary folder next to the target, then claims a free name atomically ("a (1).txt")
// and writes that path to <status>.dest and the exit code to <status>.
const FETCH = `src=$1 dir=$2 name=$3 st=$4 mode=$5 isdir=$6
mkdir -p "$dir" "\${st%/*}" || exit 1
rm -f "$st" "$st.dest"
tmp=$(mktemp -d "$dir/.herdr-download.XXXXXX") || exit 1
nohup sh -c '
mode=$1 src=$2 tmp=$3 dir=$4 name=$5 isdir=$6 st=$7
if [ "$mode" = scp ]; then scp -r -p -o BatchMode=yes -o ConnectTimeout=15 "$src" "$tmp/$name"; else cp -R -p "$src" "$tmp/$name"; fi >"$st.log" 2>&1
code=$?
if [ $code = 0 ]; then
  base=$name ext=
  if [ "$isdir" != 1 ]; then case "$name" in ?*.*) base=\${name%.*} ext=.\${name##*.};; esac; fi
  dest="$dir/$name" i=0
  if [ "$isdir" = 1 ]; then
    while ! mkdir "$dest" 2>/dev/null; do [ -e "$dest" ] || { code=1; break; }; i=$((i+1)); dest="$dir/$base ($i)$ext"; done
    if [ $code = 0 ]; then (cd "$tmp/$name" && for f in * .[!.]* ..?*; do if [ -e "$f" ] || [ -L "$f" ]; then mv "$f" "$dest/" || exit 1; fi; done) || code=1; fi
  else
    while ! ln "$tmp/$name" "$dest" 2>/dev/null; do [ -e "$dest" ] || { code=1; break; }; i=$((i+1)); dest="$dir/$base ($i)$ext"; done
  fi
  [ $code = 0 ] && printf %s "$dest" >"$st.dest"
fi
rm -rf "$tmp"
echo $code >"$st"' fetch "$mode" "$src" "$tmp" "$dir" "$name" "$isdir" "$st" </dev/null >/dev/null 2>&1 &`;

// Upload, detached like FETCH: copies local files into a temporary folder on the target
// (made beforehand with mktemp there) and writes the exit code to <status>.
const SEND = `st=$1 mode=$2 dest=$3; shift 3
mkdir -p "\${st%/*}" || exit 1
rm -f "$st"
nohup sh -c 'st=$1 mode=$2 dest=$3; shift 3
if [ "$mode" = scp ]; then scp -r -p -o BatchMode=yes -o ConnectTimeout=15 "$@" "$dest"; else cp -R -p "$@" "$dest"; fi >"$st.log" 2>&1
echo $? >"$st"' send "$st" "$mode" "$dest" "$@" </dev/null >/dev/null 2>&1 &`;

// Runs on the target machine once an upload is in: moves each uploaded item from the
// temporary folder into place under a free name, prints the names it used, removes the folder.
const PLACE = `tmp=$1 dir=$2
for p in "$tmp"/* "$tmp"/.[!.]* "$tmp"/..?*; do
  [ -e "$p" ] || [ -L "$p" ] || continue
  name=\${p##*/} base=\${p##*/} ext= i=0 dest="$dir/\${p##*/}"
  if [ -d "$p" ] && [ ! -L "$p" ]; then
    while ! mkdir "$dest" 2>/dev/null; do [ -e "$dest" ] || exit 1; i=$((i+1)); dest="$dir/$name ($i)"; done
    (cd "$p" && for f in * .[!.]* ..?*; do if [ -e "$f" ] || [ -L "$f" ]; then mv "$f" "$dest/" || exit 1; fi; done) || exit 1
  else
    case "$name" in ?*.*) base=\${name%.*} ext=.\${name##*.};; esac
    while ! ln "$p" "$dest" 2>/dev/null; do [ -e "$dest" ] || exit 1; i=$((i+1)); dest="$dir/$base ($i)$ext"; done
  fi
  printf '%s\\n' "\${dest##*/}"
done
rm -rf "$tmp"`;

// Files copied in Finder (⌘C): their paths, from the general pasteboard.
const CLIPBOARD = `ObjC.import("AppKit");
const urls = $.NSPasteboard.generalPasteboard.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL),
  $.NSDictionary.dictionaryWithObjectForKey(true, "NSPasteboardURLReadingFileURLsOnlyKey"));
const out = [];
if (urls) for (let i = 0; i < urls.count; i++) out.push(urls.objectAtIndex(i).path.js);
JSON.stringify(out);`;

// The ssh target behind a Herdr machine name (hc machine ls: "dev@host" or an ssh-config alias).
async function sshTarget(machine) {
  const r = await hc(["machine", "ls", "--json"]);
  const m = JSON.parse(r.stdout || "{}").machines?.find(x => x.name === machine);
  if (!m?.target) throw new Error(`No ssh address for machine ${machine}`);
  return m.target;
}

// Interface text: Russian when macOS is set to Russian, else English (see init).
const STRINGS = {
  en: {
    pasteHere: "Paste here", pasteInto: "Paste into this folder", pasteBeside: "Paste here",
    download: "Download to Downloads", downloadFolder: "Download folder to Downloads",
    copyPath: "Copy path", reveal: "Reveal in Finder", delete: "Delete…",
    pathCopied: "Path copied", nothingToPaste: "Nothing to paste",
    nothingToPasteBody: "Copy a file or folder in Finder (⌘C), then choose Paste.",
    tooDangerous: (p) => `Refusing to delete ${p}`, deleted: (n) => `Deleted ${n}`,
    downloadFailed: (n) => `Couldn't download ${n}`, uploadFailed: (n) => n ? `Couldn't upload ${n}` : "Couldn't upload",
    deleteFailed: (n) => `Couldn't delete ${n}`, failed: "Something went wrong", code: (c) => `exit code ${c}`,
    items: (n) => `${n} ${n === 1 ? "item" : "items"}`, downloaded: (n) => `Downloaded ${n}`, uploaded: (n) => `Uploaded ${n}`,
    askDelete: (dir, n) => `Delete ${dir ? "folder" : "file"} “${n}”?`,
    deleteDetail: (dir) => dir ? "The folder and everything in it will be deleted. This can't be undone." : "This can't be undone.",
    cancel: "Cancel", confirmDelete: "Delete",
    uploading: (n) => `Uploading ${n}…`, downloading: (n) => `Downloading ${n}…`, transferring: (n) => `Transferring ${n}…`,
    source: "Source", preview: "Preview", openInPreview: "Open in Preview", loadingImage: "Loading image…",
    imageTooBig: (n) => `Image is too large to preview (${n})`, imageFailed: "Couldn't show this image",
    newFile: "New file…", newFolder: "New folder…", rename: "Rename…", moveToTrash: "Move to Trash",
    newFileTitle: "New file", newFolderTitle: "New folder", renameTitle: (n) => `Rename “${n}”`,
    nameLabel: "Name", create: "Create", save: "Rename", in: (p) => `In ${p}`,
    badName: "Enter a name without “/”", exists: (n) => `“${n}” already exists`,
    created: (n) => `Created ${n}`, renamed: (a, b) => `Renamed ${a} → ${b}`, trashed: (n) => `Moved ${n} to the Trash`,
    createFailed: (n) => `Couldn't create ${n}`, renameFailed: (n) => `Couldn't rename ${n}`, trashFailed: (n) => `Couldn't move ${n} to the Trash`,
    remoteDelete: "This machine has no Trash: it will be deleted permanently.",
  },
  ru: {
    pasteHere: "Вставить сюда", pasteInto: "Вставить в эту папку", pasteBeside: "Вставить рядом",
    download: "Скачать в Загрузки", downloadFolder: "Скачать папку в Загрузки",
    copyPath: "Скопировать путь", reveal: "Показать в Finder", delete: "Удалить…",
    pathCopied: "Путь скопирован", nothingToPaste: "Нечего вставить",
    nothingToPasteBody: "Скопируйте файл или папку в Finder (⌘C), потом выберите «Вставить».",
    tooDangerous: (p) => `Слишком опасный путь: ${p}`, deleted: (n) => `Удалено: ${n}`,
    downloadFailed: (n) => `Не удалось скачать ${n}`, uploadFailed: (n) => n ? `Не удалось загрузить ${n}` : "Не удалось загрузить",
    deleteFailed: (n) => `Не удалось удалить ${n}`, failed: "Не получилось", code: (c) => `код ${c}`,
    items: (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "объект" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "объекта" : "объектов"}`,
    downloaded: (n) => `Скачано: ${n}`, uploaded: (n) => `Загружено: ${n}`,
    askDelete: (dir, n) => `Удалить ${dir ? "папку" : "файл"} «${n}»?`,
    deleteDetail: (dir) => dir ? "Папка будет удалена со всем содержимым. Это нельзя отменить." : "Это нельзя отменить.",
    cancel: "Отмена", confirmDelete: "Удалить",
    uploading: (n) => `Загружается ${n}…`, downloading: (n) => `Скачивается ${n}…`, transferring: (n) => `Передаётся: ${n}…`,
    source: "Код", preview: "Просмотр", openInPreview: "Открыть в Просмотре", loadingImage: "Загружается изображение…",
    imageTooBig: (n) => `Изображение слишком большое для просмотра (${n})`, imageFailed: "Не удалось показать изображение",
    newFile: "Новый файл…", newFolder: "Новая папка…", rename: "Переименовать…", moveToTrash: "В Корзину",
    newFileTitle: "Новый файл", newFolderTitle: "Новая папка", renameTitle: (n) => `Переименовать «${n}»`,
    nameLabel: "Имя", create: "Создать", save: "Переименовать", in: (p) => `В папке ${p}`,
    badName: "Введите имя без «/»", exists: (n) => `«${n}» уже существует`,
    created: (n) => `Создано: ${n}`, renamed: (a, b) => `Переименовано: ${a} → ${b}`, trashed: (n) => `В Корзине: ${n}`,
    createFailed: (n) => `Не удалось создать ${n}`, renameFailed: (n) => `Не удалось переименовать ${n}`, trashFailed: (n) => `Не удалось переместить ${n} в Корзину`,
    remoteDelete: "На этой машине нет Корзины: удаление навсегда.",
  },
};
const T = () => {
 const t=STRINGS[shared(LANG_KEY)] ?? STRINGS.en;
 return windowsHost()?{...t,reveal:"Show in Explorer",nothingToPasteBody:"Copy files or folders in Explorer (Ctrl+C), then paste here (Ctrl+V).",openInPreview:"Open in default app",badName:"Enter a valid file name without path separators"}:t;
};

// Previews: Markdown is drawn formatted (with a Source toggle); images are copied into the
// app folder first, because image() only reads from there, and the formats GPUI can't draw
// are turned into PNG with sips.
const MARKDOWN = /\.(md|markdown|mdx)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|heic|heif|avif)$/i;
const CONVERT = /\.(ico|tiff?|heic|heif|avif)$/i;
const PREVIEW_DIR = "data/files-transfer-windows/preview";
const MAX_IMAGE = 50 * 1024 * 1024;
// Preview Plus (linziyanleo/herdr-mods), when the layout pairs it with this panel in a stack
// (this block's props.previewStack names the stack, its child "preview-plus" shows the file):
// Markdown, PNG/JPEG/WebP/SVG images and PDFs open there. It reads media only from this
// computer, so a remote image or PDF is copied here first. Everything else stays in this panel.
const PP_TARGET = "preview-plus.target";
const PP_MARKDOWN = /\.(md|markdown)$/i;
const PP_MEDIA = /\.(png|jpe?g|webp|svg|pdf)$/i;
function bytesText(n) {
  if(!Number.isFinite(n))return "—";
  if(n<1024)return n+" B";
  if(n<1048576)return (n/1024).toFixed(1)+" KB";
  if(n<1073741824)return (n/1048576).toFixed(1)+" MB";
  return (n/1073741824).toFixed(2)+" GB";
}

const parentOf = path => {const p=normalize(path),parent=p.slice(0,p.lastIndexOf("/"))||"/";return /^[A-Za-z]:$/.test(parent)?parent+"/":parent;};

// A menu row is [action, label, icon]; null draws a divider.
const MENU = (target, t = T()) => target.items?.length>1
  ? [["download", "Download selected ("+target.items.length+")", "download.svg"]]
  : target.root
  ? [["paste", t.pasteHere, "paste.svg"], ["copy", t.copyPath, "copy.svg"], null,
     ["new-file", t.newFile, "file-plus.svg"], ["new-folder", t.newFolder, "folder-plus.svg"]]
  : [
      ["download", target.dir ? t.downloadFolder : t.download, "download.svg"],
      ["paste", target.dir ? t.pasteInto : t.pasteBeside, "paste.svg"],
      ["copy", t.copyPath, "copy.svg"],
      ...(target.on ? [] : [["reveal", t.reveal, "finder.svg"]]),
      null,
      ["new-file", t.newFile, "file-plus.svg"],
      ["new-folder", t.newFolder, "folder-plus.svg"],
      ["rename", t.rename, "pen.svg"],
      null,
      // Here: the Trash (Put Back works); another machine has none, so it asks and deletes.
      target.on ? ["delete", t.delete, "trash.svg"] : ["trash", t.moveToTrash, "trash.svg"],
    ];
// A name typed for a new entry or a rename: one path component.
const validName = (n) => n !== "" && n !== "." && n !== ".." && !/[\/\\\u0000-\u001f]/.test(n);
// Run on the entry's machine. Each refuses to replace what is there (exit 17).
const MAKE_FILE = 'set -C; [ -e "$1" ] || [ -L "$1" ] && exit 17; : > "$1"';
const MAKE_FOLDER = '[ -e "$1" ] || [ -L "$1" ] && exit 17; mkdir -- "$1"';
const MOVE = '[ -e "$2" ] || [ -L "$2" ] && exit 17; mv -- "$1" "$2"';
const menuHeight = list => list.reduce((h, it) => h + (it ? MENU_ROW : 9), 10);

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: normalize(pane?.cwd || f?.cwd || space?.folder), on };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const DIR = "mods/files-transfer-windows";

// Material Icon Theme's rules, as VS Code applies them: names match case-insensitively; a
// path rule (".github/workflows") beats a name, a name beats an extension, and the longest
// extension wins ("spec.ts" over "ts"). Light themes check the theme's light table first.
const bare = name => name.replace(/^__(.+)__$/, "$1").replace(/^[._-]/, "");
const opened = id => id.endsWith("_light") ? `${id.slice(0, -6)}-open_light` : `${id}-open`;
function lookup(table, key, dark) { return (dark ? undefined : ICONS.light[table][key]) ?? ICONS[table][key]; }
function icon(path, dir, open, dark) {
  const parts = path.toLowerCase().split("/"), name = parts[parts.length - 1];
  const table = dir ? "folderNames" : "fileNames", find = key => lookup(table, key, dark) ?? (dir ? lookup(table, bare(key), dark) : undefined);
  let id;
  for (let i = 0; !id && i < parts.length - 1; i++) id = find(parts.slice(i).join("/"));
  if (dir) {
    id ??= find(name) ?? ICONS.folder;
    return `${DIR}/icons/${open ? opened(id) : id}.svg`;
  }
  id ??= lookup(table, name, dark);
  for (let dot = name.indexOf("."); !id && dot !== -1; dot = name.indexOf(".", dot + 1)) id = lookup("fileExtensions", name.slice(dot + 1), dark);
  return `${DIR}/icons/${id ?? ICONS.file}.svg`;
}

async function directory(path, on) {
  if(windowsTarget(on,path)) return win("list",{path},on);
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; meta=$(stat -c "%Y %s" -- "$p" 2>/dev/null || stat -f "%m %z" "$p" 2>/dev/null); printf "%s\\0%s\\0%s\\0" "$kind" "$meta" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i=0; i+2<fields.length; i+=3) {
    const [stamp,size]=fields[i+1].match(/^-?\d+ \d+$/)?fields[i+1].split(" ").map(Number):[null,null];
    const dir=fields[i]==="d";
    out.push({name:fields[i+2],dir,mtime:stamp===null?null:stamp*1000,size:dir?null:size});
  }
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    if (props()?.downloadSettings) return;
    if (props()?.ask) return this.initAsk(cx);
    if (props()?.menu || props()?.confirm) { this.at = 0; this.handle = cx.focus_handle(); this.handle.focus(); return; }
    // Which panel a menu choice is for: the one that opened the menu.
    this.me = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.jobs = [];
    this.queueOpen = false;
    this.search = "";
    this.selection = new Set();
    this.anchor = null;
    this.local = { root: "", entries: [], selection: new Set(), anchor: null, loading: false };
    this.initBrowserInputs(cx);

    this.originKey=key();this.followTerminalEnabled=true;this.pinnedLocation=null;this.history=[];
    try {const saved=JSON.parse(localStorage.getItem("browser-sort")||"{}");this.sortBy=["mtime","size"].includes(saved.by)?saved.by:"name";this.sortDirection=saved.direction===-1?-1:1;}catch{this.sortBy="name";this.sortDirection=1;}

    // ⌘V pastes into the selected row's folder: the panel takes the keyboard when clicked.
    this.keys = cx.focus_handle();
    // Cached previews are cleaned individually, never by an unbounded recursive sweep.

    this.selected = null; // { path, dir } inside the shown folder
    cx.spawn(async cx => {
      if(windowsHost() || checking()) return;
      const r = await exec("defaults", ["read", "-g", "AppleLanguages"]).catch(() => null);
      const lang = /^\W*"?ru/m.test(r?.stdout?.split("\n").find(l => /\w/.test(l) && !/^\s*\(/.test(l)) ?? "") ? "ru" : "en";
      if (shared(LANG_KEY) !== lang) setShared(LANG_KEY, lang);
    });
    cx.timer.every(1000, cx => this.poll(cx));
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    if(!checking()) this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  viewLocation() {
    if(this.followTerminalEnabled===false&&this.pinnedLocation)return this.pinnedLocation;
    const base=location();
    return {...base,cwd:browserPath(base.cwd)};
  }

  initBrowserInputs(cx) {
    this.editorsFocused=new Set();
    const init=(id,placeholder)=>{
      const input=InputState.new({placeholder});
      input.on("focus",()=>this.editorsFocused.add(id));
      input.on("blur",()=>this.editorsFocused.delete(id));
      return input;
    };
    this.pathInput=init("path","Folder path");
    this.pathInput.on("submit",(_event,cx)=>this.jumpToPath(this.pathInput.value(),cx));
    this.searchInput=init("search","Find files or *.png");
    this.searchInput.on("change",(_event,cx)=>{
      this.search=this.searchInput.value();
      this.clearSelection();
      cx.notify();
    });
    this.localPathInput=init("local","Local folder path");
    this.localPathInput.on("submit",(_event,cx)=>{
      const path=folderAddress(this.localPathInput.value(),true);
      if(path)this.loadLocal(path,cx);
      else notify({title:"Enter an absolute Windows folder path",level:"warning"});
    });
  }

  jumpToPath(value,cx){
    const current=this.viewLocation();
    const path=folderAddress(value,windowsTarget(current.on,current.cwd));
    if(!path){
      notify({title:"Enter an absolute folder path on the current machine",level:"warning"});
      return;
    }
    this.keys.focus();
    if(path===this.root){this.refresh(cx);cx.notify();return;}
    this.navigate(path,cx);
  }

  downloadScope(on=this.on){
    return {on:on??null,project:(on??null)===(this.on??null)?this.repoRoot:null};
  }

  downloadSettings(){
    try{return JSON.parse(localStorage.getItem("download-folders-v1")||"{}")||{};}
    catch{return {};}
  }

  downloadKey(scope,type){
    return JSON.stringify([scope.on,type==="project"?scope.project:null]);
  }

  async downloadDirectory(scope){
    const prefs=this.downloadSettings();
    return (scope.project && prefs[this.downloadKey(scope,"project")]) ||
      prefs[this.downloadKey(scope,"machine")] || await win("downloads");
  }

  openDownloadSettings(){
    const scope=this.downloadScope(),prefs=this.downloadSettings();
    openOverlay({mod:"files-transfer-windows",kind:"dialog",width:460,height:scope.project?258:186,
      props:{downloadSettings:{from:this.me,scope,project:scope.project?prefs[this.downloadKey(scope,"project")]:null,
        machine:prefs[this.downloadKey(scope,"machine")]}}});
  }

  async chooseDownloadFolder(req){
    const prefs=this.downloadSettings();
    const key=this.downloadKey(req.scope,req.type);
    if(req.reset)delete prefs[key];
    else {
      const folder=await pickFolder({prompt:"Choose a local download folder"});
      if(!folder)return;
      prefs[key]=folder;
    }
    localStorage.setItem("download-folders-v1",JSON.stringify(prefs));
  }

  openTerminal(){
    if(!this.root||this.error||this.loading)return;
    const candidates=spaces().filter(space=>(space.machine??null)===(this.on??null));
    const space=candidates.find(space=>space.active)||candidates[0];
    if(space){run("tab.new",{space:space.id,folder:this.root});return;}
    if(this.on){
      run("space.new",{machine:this.on,folder:this.root});
      return;
    }
    // Asking for a local terminal while the active space is remote needs an explicit machine.
    run("space.new",{machine:"",folder:this.root});
  }

  async loadLocal(path,cx){
    const local=this.local;
    if(local.loading&&local.loadingPath===path)return;
    const ticket={};
    local.ticket=ticket;local.loading=true;local.loadingPath=path;local.error=null;
    cx.notify();
    try{
      const entries=await directory(path,null);
      if(local.ticket!==ticket)return;
      if(local.root!==path){local.selection.clear();local.anchor=null;}
      local.root=path;
      local.entries=entries.filter(entry=>!TEMP.test(entry.name)).slice(0,PER_FOLDER);
      local.selection=new Set([...local.selection].filter(name=>local.entries.some(entry=>entry.name===name)));
      this.localPathInput.set_value(path);
    }catch(error){
      if(local.ticket===ticket)local.error=String(error.message??error);
    }finally{
      if(local.ticket===ticket){local.loading=false;cx.notify();}
    }
  }

  toggleSplit(cx){
    this.split=!this.split;
    const find=node=>node?.id==="panel"?node:node?.children?.map(find).find(Boolean);
    const panel=find(layout());
    if(!this.split){
      if(this.panelWidth && panel?.size?.px===this.splitWidth)run("layout.resize",{id:"panel",px:this.panelWidth});
      this.panelWidth=null;cx.notify();return;
    }
    if(panel?.size?.px && panel.size.px<710){
      this.panelWidth=panel.size.px;
      this.splitWidth=Math.min(740,panel.max??740);
      run("layout.resize",{id:"panel",px:this.splitWidth});
    }
    if(!this.local.root){
      const scope=this.downloadScope();
      cx.spawn(async cx=>{
        try{
          const path=browserPath(await this.downloadDirectory(scope));
          await this.loadLocal(path,cx);
          if(!this.local.root){
            const fallback=browserPath(home());
            if(fallback&&fallback!==path)await this.loadLocal(fallback,cx);
          }
        }catch(error){this.local.error=String(error.message??error);cx.notify();}
      });
    }
    cx.notify();
  }

  clearSelection(){
    this.selected=null;
    this.selection.clear();
    this.anchor=null;
  }

  visibleEntries(){
    const entries=(this.entries.get("")??[]).filter(entry=>matchesName(entry.name,this.search));
    return sortedEntries(entries,this.sortBy,this.sortDirection);
  }

  selectedEntries(){
    return this.visibleEntries().filter(entry=>this.selection.has(entry.name));
  }

  queueDownloads(entries,root,on,cx,destination=null,scope=this.downloadScope(on)){
    if(!root||!entries.length)return;
    cx.spawn(async cx=>{
      try{
        const dir=windowsHost()?(destination||await this.downloadDirectory(scope)):null;
        for(const entry of entries){
          await this.download(joinPath(root,entry.name),entry.name,entry.dir,on,{destination:dir,scope,size:entry.size});
        }
        this.queueOpen=windowsHost();
      }catch(error){notify({title:"Could not queue downloads",body:String(error),level:"error"});}
      cx.notify();
    });
  }

  uploadLocalSelection(cx){
    const local=this.local,destination=this.root,on=this.on;
    const paths=local.entries.filter(entry=>local.selection.has(entry.name)).map(entry=>joinPath(local.root,entry.name));
    if(!paths.length||!destination||this.error||this.loading)return;
    cx.spawn(async cx=>{
      try{await this.upload(paths,destination,on);this.queueOpen=true;}
      catch(error){notify({title:"Could not queue uploads",body:String(error),level:"error"});}
      cx.notify();
    });
  }
  viewKey(){return JSON.stringify({origin:this.followTerminalEnabled===false?null:key(),...this.viewLocation()});}
  navigate(path,cx,remember=true){
    const next=browserPath(path),current=this.viewLocation();
    if(!next)return;
    if(remember&&this.root&&next!==this.root){this.history.push(this.root);if(this.history.length>100)this.history.shift();}
    // Pin both machine and folder: switching terminals must not retarget a transfer.
    this.followTerminalEnabled=false;this.pinnedLocation={cwd:next,on:current.on};
    this.refresh(cx);cx.notify();
  }
  closePreview(cx){
    if(!this.file)return false;
    this.show(null);
    cx.notify();
    return true;
  }
  goBack(cx){
    if(this.closePreview(cx))return;
    const path=this.history.pop();
    if(path)this.navigate(path,cx,false);
  }
  goUp(cx){
    if(this.closePreview(cx)||!this.root)return;
    const parent=parentPath(this.root);
    if(parent!==this.root)this.navigate(parent,cx);
  }
  followTerminal(cx){
    this.originKey=key();this.followTerminalEnabled=true;this.pinnedLocation=null;this.history=[];
    this.show(null);this.selected=null;this.refresh(cx);cx.notify();
  }
  toggleTerminalFollow(cx){
    if(this.followTerminalEnabled!==false){
      this.pinnedLocation=this.viewLocation();this.followTerminalEnabled=false;this.refresh(cx);cx.notify();
    }else this.followTerminal(cx);
  }
  setSort(field,cx){
    this.sortDirection=this.sortBy===field?-this.sortDirection:field==="name"?1:-1;
    this.sortBy=field;
    localStorage.setItem("browser-sort",JSON.stringify({by:field,direction:this.sortDirection}));cx.notify();
  }
  watch(root,cx){
    if(this.on||this.watched===root)return;
    this.watched=root;const context=this.context;
    cx.spawn(async cx=>{
      try {while(this.context===context&&this.watched===root){this.folderWatch=watchFolder(root);await this.folderWatch;if(this.context===context&&this.watched===root)this.refresh(cx);}}
      catch{if(this.context===context)this.watched=null;}
    });
  }

  async loadFolder(path, context) {
    const on = this.on, root = this.root;
    const entries = (await directory(path ? `${root}/${path}` : root, on)).filter(e => !TEMP.test(e.name));
    if (this.viewKey() !== context || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    if(this.followTerminalEnabled!==false&&this.originKey!==key()){this.originKey=key();this.history=[];}
    const {cwd,on}=this.viewLocation(),context=this.viewKey();
    if (context !== this.context) {
      this.folderWatch?.cancel?.();this.folderWatch=null;this.loading=false;
      this.context = context; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set();
      this.pending = new Set(); this.marks = {}; this.repoRoot = null; this.clearSelection(); this.search = ""; this.searchInput.set_value(""); this.pathInput.set_value(cwd); this.show(null); this.watched = null; this.error = null; this.limited = false;
    }
    if (!cwd || this.loading) return;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) await this.loadFolder(path, context);
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (this.viewKey() !== context) return;
        this.marks = marks; this.repoRoot = top?.code === 0 ? top.stdout.trim() : null; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.viewKey() === context) this.error = String(e); }
      finally {if(this.context===context)this.loading=false;cx.notify();}
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.viewKey() === context) this.error = String(e); }
          finally { this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    this.md = null; this.source = false;
    if (this.img) { this.cleanPreview(parentOf(this.img.abs)); this.img = null; }
    if (!path || !cx) return;
    if (IMAGE.test(path)) return this.showImage(path, cx);
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || this.viewKey() !== context) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        if (MARKDOWN.test(path)) this.md = text.length > 400000 ? text.slice(0, 400000) : text;
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.viewKey() === context) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // A copy of src (on machine `on`) in this mod's preview folder, here; its absolute path.
  cleanPreview(path) {
    if(windowsHost()) win("preview-clean",{path}).catch(()=>{});
    else exec("rm",["-rf",path]).catch(()=>{});
  }
  async stage(src, on) {
    if(windowsHost()) {
      if(on){
        const size=windowsTarget(on,src)?await win("size",{path:src},on):Number((await exec("sh",["-c",'wc -c < "$1"',"size",src],{on})).stdout.trim());
        if(!Number.isFinite(size)||size>MAX_IMAGE)throw Error(T().imageTooBig(bytesText(size)));
      }
      const dir=`${normalize(appHome())}/${PREVIEW_DIR}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
      return win("stage",{source:on?`${await sshTarget(on)}:${src}`:src,remote:!!on,destination:dir+"/"+normalize(src).split("/").pop()});
    }
    const size = await exec("sh", ["-c", 'wc -c < "$1"', "size", src], { on });
    if (size.code !== 0) throw new Error((size.stderr || T().imageFailed).trim());
    const bytes = Number(size.stdout.trim());
    if (bytes > MAX_IMAGE) throw new Error(T().imageTooBig(bytesText(bytes)));
    const dir = `${appHome()}/${PREVIEW_DIR}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    await exec("mkdir", ["-p", dir]);
    const file = `${dir}/${src.split("/").pop()}`;
    const copy = on
      ? await exec("scp", ["-p", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", `${await sshTarget(on)}:${src}`, file])
      : await exec("cp", [src, file]);
    if (copy.code !== 0) { await exec("rm", ["-rf", dir]).catch(() => {}); throw new Error((copy.stderr || T().imageFailed).trim()); }
    return { file, bytes };
  }

  // Shows the file in the paired Preview Plus; false when it isn't paired or isn't for it.
  handoff(path, cx) {
    const stack = props()?.previewStack, markdown = PP_MARKDOWN.test(path);
    if (!stack || (!markdown && !PP_MEDIA.test(path))) return false;
    const abs = `${this.root}/${path}`, on = this.on ?? null, root = this.root;
    const go = (target) => {
      const f = focused(), space = f?.space ?? spaces().find(s => s.active)?.id;
      if (!space) return;
      setShared(PP_TARGET, { ...(shared(PP_TARGET) ?? {}), [space]: target });
      run("layout.select", { stack, child: "preview-plus" });
    };
    if (markdown || !on) { go({ file: abs, root, on: markdown ? on : null }); return true; }
    cx.spawn(async () => {
      try { const { file } = await this.stage(abs, on); go({ file, root: parentOf(file), on: null }); }
      catch (e) { notify({ title: T().imageFailed, body: String(e.message ?? e), level: "error" }); }
    });
    return true;
  }

  // An image: copied into the app folder (scp from a remote machine), converted when GPUI
  // can't draw its format, measured with sips, then drawn fitted to the panel.
  showImage(path, cx) {
    const context = this.context, root = this.root, on = this.on ?? null, src = `${root}/${path}`;
    const ext = path.split(".").pop().toLowerCase(), id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    cx.spawn(async cx => {
      let file = null;
      try {
        const staged = await this.stage(src, on), dir = parentOf(staged.file), bytes = staged.bytes;
        if(windowsHost()) {
          file=staged.file;
          const meta=await win("image",{path:file});file=meta.file;
          if(this.file!==path || this.viewKey()!==context){this.cleanPreview(dir);return;}
          this.img={rel:file.slice(normalize(appHome()).length+1),abs:file,local:on?null:src,w:meta.w,h:meta.h,bytes};
          return;
        }
        file = `${dir}/${id}.${ext}`;
        await exec("mv", [staged.file, file]);
        if (CONVERT.test(path)) {
          const png = `${dir}/${id}.png`;
          const c = await exec("sips", ["-s", "format", "png", file, "--out", png]);
          await exec("rm", ["-f", file]);
          file = png;
          if (c.code !== 0) throw new Error(T().imageFailed);
        }
        let w = null, h = null;
        if (ext !== "svg") {
          const d = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
          w = Number(d.stdout.match(/pixelWidth:\s*(\d+)/)?.[1]) || null;
          h = Number(d.stdout.match(/pixelHeight:\s*(\d+)/)?.[1]) || null;
        }
        if (this.file !== path || this.viewKey() !== context) { await exec("rm", ["-rf", parentOf(file)]); return; }
        this.img = { rel: file.slice(appHome().length + 1), abs: file, local: on ? null : src, w, h, bytes };
      } catch (e) {
        if(file) this.cleanPreview(parentOf(file));
        if (this.file === path && this.viewKey() === context) this.fileError = String(e.message ?? e);
      } finally { cx.notify(); }
    });
  }

  // What an open file shows: an image, formatted Markdown, or the read-only code view.
  preview(t) {
    const img = this.img;
    if (img) {
      const room = { w: Math.max(1,(this.size?.width ?? 360)/(this.split?2:1) - 32), h: Math.max(1,(this.size?.height ?? 480) - 42 - 32 - 33 - 34 - 32 - (this.split ? 29 : 0) - (this.queueOpen && this.jobs.length ? 132 : 0)) };
      const k = img.w && img.h ? Math.min(1, room.w / img.w, room.h / img.h) : null;
      const info = [img.w && `${img.w}×${img.h}`, bytesText(img.bytes), k !== null && k < 1 && `${Math.round(k * 100)}%`].filter(Boolean).join(" · ");
      return v_flex().flex_1().min_h(0)
        .child(div().id("files-image").flex_1().min_h(0).p(16).flex().items_center().justify_center().overflow_hidden().bg(t.canvas)
          .child(k !== null ? image(img.rel).w(Math.max(1, img.w * k)).h(Math.max(1, img.h * k)) : image(img.rel).size_full()))
        .child(h_flex().h(34).flex_none().px(14).gap(8).items_center().border_t(1).border_color(t.border).text_size(12).text_color(t.dim)
          .child(div().flex_1().min_w(0).truncate().child(info))
          .child(div().id("files-open-preview").px(8).py(3).rounded(6).cursor_pointer().text_color(t.muted)
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => (windowsHost()?win("open",{path:img.local ?? img.abs}):exec("open", ["-a", "Preview", img.local ?? img.abs])).catch(() => {}))
            .child(T().openInPreview)));
    }
    if (this.md !== null && !this.source) {
      return div().id("files-md").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(14).text_size(13.5)
        .child(TextView.markdown(`md-${this.file}`, this.md).selectable(true));
    }
    if (this.code) return Editor.new(this.code).flex_1().min_h(0);
    return div().p(12).text_color(t.dim).child(this.fileError || (IMAGE.test(this.file) ? T().loadingImage : "Loading file…"));
  }

  // path: inside the shown folder ("" for the folder itself).
  openMenu(path, dir) {
    const entry=this.visibleEntries().find(item=>item.name===path);
    const target = path
      ? { path: joinPath(this.root,path), name: path.split("/").pop(), dir, on: this.on ?? null, from: this.me,
        rootPath:this.root,items:this.selection.has(path)?this.selectedEntries():[entry??{name:path,dir}],
        scope:this.downloadScope(),destination:this.split?this.local.root:null }
      : { path: this.root, name: this.root.split("/").pop(), dir: true, root: true, on: this.on ?? null, from: this.me };
    openOverlay({ mod: "files-transfer-windows", kind: "popup", width: 250, height: menuHeight(MENU(target)), props: { menu: target } });
  }

  // A choice made in the menu or the confirmation, for this panel.
  take(cx) {
    const req = shared(REQUEST);
    if (!req || req.from !== this.me || req.id === this.lastRequest) return;
    this.lastRequest = req.id;
    setShared(REQUEST, null);
    const { action, path, name, dir, on } = req;
    if(action==="download-settings"){
      cx.spawn(async cx=>{
        try{await this.chooseDownloadFolder(req);}
        catch(error){notify({title:"Could not save download folder",body:String(error),level:"error"});}
        cx.notify();
      });
      return;
    }
    if(action==="download"){
      this.queueDownloads(req.items??[{name,dir}],req.rootPath??parentOf(path),on,cx,req.destination,req.scope);
      return;
    }
    if (action === "delete") {
      openOverlay({ mod: "files-transfer-windows", kind: "dialog", width: 420, height: 176, props: { confirm: { path, name, dir, on, from: this.me } } });
      return;
    }
    if (action === "new-file" || action === "new-folder" || action === "rename") {
      // New entries go into the folder clicked, or beside the file clicked.
      const folder = action === "rename" ? parentOf(path) : dir ? path : parentOf(path);
      openOverlay({ mod: "files-transfer-windows", kind: "dialog", width: 440, height: 214,
        props: { ask: { kind: action, folder, path, name, dir, on, from: this.me } } });
      return;
    }
    cx.spawn(async cx => {
      try {
        if (action === "copy") {
          if(windowsHost()) await win("copy-path",{path});
          else await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", path]);
          notify({ title: T().pathCopied, body: path, level: "info", timeout: 2500 });
        } else if (action === "reveal") {
          if(windowsHost()) await win("reveal",{path});else await exec("open", ["-R", path]);
        } else if (action === "paste") {
          await this.paste(dir ? path : parentOf(path), on);
        } else if (action === "trash") {
          if (on || path === this.root || path.split("/").filter(Boolean).length < 2) throw new Error(T().tooDangerous(path));
          const r = windowsHost()?await winResult("trash",{path,root:this.root}):await exec("trash", [path]);
          if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
          notify({ title: T().trashed(name), body: path.replace(home(), "~"), level: "success", timeout: 4000 });
          if (this.file && `${this.root}/${this.file}`.startsWith(path)) this.show(null);
          this.refresh(cx);
        } else if (action === "create-file" || action === "create-folder") {
          const target = `${req.folder}/${req.value}`;
          const r = windowsTarget(on,target)?await winResult(action==="create-file"?"new-file":"new-folder",{path:target},on):await exec("sh", ["-c", action === "create-file" ? MAKE_FILE : MAKE_FOLDER, "make", target], { on });
          if (r.code === 17) throw new Error(T().exists(req.value));
          if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
          notify({ title: T().created(req.value), body: on ? `${on}:${target}` : target.replace(home(), "~"), level: "success", timeout: 3000 });
          this.reveal(target, action === "create-folder");
          this.refresh(cx);
        } else if (action === "rename-yes") {
          const target = `${parentOf(path)}/${req.value}`;
          if (target === path) return;
          const r = windowsTarget(on,path)?await winResult("rename",{path,to:target},on):await exec("sh", ["-c", MOVE, "move", path, target], { on });
          if (r.code === 17) throw new Error(T().exists(req.value));
          if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
          notify({ title: T().renamed(name, req.value), body: on ? `${on}:${target}` : target.replace(home(), "~"), level: "success", timeout: 3000 });
          if (this.file && `${this.root}/${this.file}` === path) this.show(null);
          this.reveal(target, dir);
          this.refresh(cx);
        } else if (action === "delete-yes") {
          // Never the shown folder itself, the home folder or a root-level path.
          if (path === this.root || path.split("/").filter(Boolean).length < 2) throw new Error(T().tooDangerous(path));
          const r = windowsTarget(on,path)?await winResult("remove",{path,root:this.root},on):await exec("rm", ["-rf", "--", path], { on });
          if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
          notify({ title: T().deleted(name), body: on ? `${on}:${path}` : path, level: "success", timeout: 4000 });
          if (this.file && `${this.root}/${this.file}`.startsWith(path)) this.show(null);
          this.refresh(cx);
        }
      } catch (e) {
        const what = { download: T().downloadFailed(name), paste: T().uploadFailed(), "delete-yes": T().deleteFailed(name),
          trash: T().trashFailed(name), "create-file": T().createFailed(req.value), "create-folder": T().createFailed(req.value),
          "rename-yes": T().renameFailed(name) }[action] ?? T().failed;
        notify({ title: what, body: String(e.message ?? e), level: "error" });
      }
      cx.notify();
    });
  }

  // Files copied in Finder, uploaded into folder (absolute, on the machine `on`).
  async paste(folder, on) {
    let files;
    if(windowsHost()) files=await win("clipboard-files");
    else {const r=await exec("osascript",["-l","JavaScript","-e",CLIPBOARD]);files=r.code===0?JSON.parse(r.stdout.trim()||"[]"):[];}
    if (!files.length) return notify({ title: T().nothingToPaste, body: T().nothingToPasteBody, level: "warning", timeout: 5000 });
    await this.upload(files, folder, on);
  }

  // ⌘V: into the selected folder, beside the selected file, else into the shown folder.
  pasteKey(cx) {
    if (!this.root) return;
    const sel = this.selected;
    const folder = !sel ? this.root : sel.dir ? `${this.root}/${sel.path}` : parentOf(`${this.root}/${sel.path}`);
    const on = this.on ?? null;
    cx.spawn(async cx => {
      try { await this.paste(folder, on); }
      catch (e) { notify({ title: T().uploadFailed(), body: String(e.message ?? e), level: "error" }); }
      cx.notify();
    });
  }

  // A new or renamed entry: its folders open in the tree and it is selected.
  reveal(abs, dir) {
    if (!abs.startsWith(`${this.root}/`)) return;
    const rel = abs.slice(this.root.length + 1), parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
    this.selected = { path: rel, dir };
    this.selection=new Set([rel]);
    this.anchor=rel;
  }

  async download(path, name, dir, on, options = {}) {
    if(windowsHost()) {
      const destination=options.destination || await this.downloadDirectory(options.scope ?? this.downloadScope(on));
      this.enqueue({kind:"download",path,name,isDirectory:dir,on,destination,total:options.size ?? null});
      return;
    }
    const src = on ? `${await sshTarget(on)}:${path}` : path;
    const status = `${appHome()}/data/files-transfer-windows/${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const r = await exec("sh", ["-c", FETCH, "fetch", src, `${home()}/Downloads`, name, status, on ? "scp" : "cp", dir ? "1" : "0"]);
    if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
    this.jobs.push({ kind: "download", status, name });
  }

  // Local files into dir on the shown folder's machine: into a temporary folder there
  // first, then into place under free names (PLACE), so nothing is overwritten.
  async upload(files, dir, on) {
    if(windowsHost()) {
      for(const source of files.map(normalize)){
        this.enqueue({kind:"upload",source,name:source.replace(/\/$/,"").split("/").pop(),dir,on});
      }
      this.queueOpen=true;
      return;
    }
    const mk = await exec("mktemp", ["-d", `${dir}/.herdr-upload.XXXXXX`], { on });
    if (mk.code !== 0) throw new Error((mk.stderr || `exit ${mk.code}`).trim());
    const tmp = mk.stdout.trim();
    const dest = on ? `${await sshTarget(on)}:${tmp}/` : `${tmp}/`;
    const status = `${appHome()}/data/files-transfer-windows/${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const r = await exec("sh", ["-c", SEND, "send", status, on ? "scp" : "cp", dest, ...files]);
    if (r.code !== 0) {
      await exec("rm", ["-rf", "--", tmp], { on }).catch(() => {});
      throw new Error((r.stderr || `exit ${r.code}`).trim());
    }
    const name = files.length === 1 ? files[0].split("/").pop() : T().items(files.length);
    this.jobs.push({ kind: "upload", status, name, tmp, dir, on });
  }

  // Finished transfers write their exit code to the status file.
  async cleanRemoteStage(path,dir,on,remoteWin) {
    if(remoteWin) await win("stage-remove",{path,destination:dir},on).catch(()=>{});
    else if(path&&path.startsWith(dir.replace(/\/$/,"")+"/.herdr-upload."))await exec("rm",["-rf","--",path],{on}).catch(()=>{});
  }
  enqueue(spec) {
    const active=this.jobs.filter(job=>!["done","failed","cancelled"].includes(job.state));
    const recent=this.jobs.filter(job=>["done","failed","cancelled"].includes(job.state)).slice(-30);
    this.jobs=[...recent,...active,{...spec,state:"queued",windows:true,status:jobPath()}];
  }

  async startJob(job) {
    const status=job.status;
    if(job.kind==="download"){
      let total=job.total;
      if(job.on && !Number.isFinite(total)){
        total=await this.remoteBytes(job.path,job.on,job.isDirectory).catch(()=>null);
      }
      const source=job.on?(await sshTarget(job.on))+":"+job.path:job.path;
      await win("start",{status,kind:"download",source,remote:!!job.on,name:job.name,destination:job.destination,total});
    } else if(!job.on){
      await win("start",{status,kind:"upload-local",sources:[job.source],destination:job.dir});
    } else {
      const ssh=await sshTarget(job.on);
      job.remoteWin=windowsTarget(job.on,job.dir);
      if(job.remoteWin)job.tmp=await win("stage-create",{path:job.dir},job.on);
      else{
        const result=await exec("mktemp",["-d",joinPath(job.dir,".herdr-upload.XXXXXX")],{on:job.on});
        if(result.code!==0)throw Error(result.stderr||"Cannot create remote staging folder");
        job.tmp=result.stdout.trim();
      }
      try{
        await win("start",{status,kind:"upload-remote",sources:[job.source],destination:ssh+":"+job.tmp+"/"});
      }catch(error){
        await this.cleanRemoteStage(job.tmp,job.dir,job.on,job.remoteWin);
        throw error;
      }
    }
    job.started=Date.now();
    job.state="running";
  }

  async remoteBytes(path,on,dir=true){
    if(windowsTarget(on,path))return win(dir?"tree-bytes":"size",{path},on);
    // Count payload bytes rather than allocated disk blocks. Cap recursive sampling.
    const script=dir
      ? `if [ -d "$1" ]; then
          if find "$1" -maxdepth 0 -printf "" >/dev/null 2>&1; then
            find "$1" -type f -printf "%s\\n"
          else
            find "$1" -type f -exec stat -f "%z" {} +
          fi | head -n 5001 | awk 'NR<=5000 { sum += $1 } END { if (NR<=5000) printf "%.0f", sum }'
        else printf 0; fi`
      : 'if [ -f "$1" ]; then stat -c "%s" -- "$1" 2>/dev/null || stat -f "%z" "$1"; else printf 0; fi';
    const result=await exec("sh",["-c",script,"measure",path],{on,timeout:5000});
    const value=result.stdout?.trim();
    return result.code===0 && /^\d+$/.test(value)?Number(value):null;
  }

  async finishJob(job,result,cx) {
    const cancelled=result.code==="2" || (job.state==="cancelling" && job.kind==="upload" && !!job.on);
    job.state="finalizing";cx.notify();
    try {
      if(cancelled){job.state="cancelled";return;}
      if(result.code!=="0")throw Error(result.log||"Transfer failed");
      if(job.kind==="upload" && job.on){
        if(job.remoteWin)await win("stage-place",{path:job.tmp,destination:job.dir},job.on);
        else {
          const placed=await exec("sh",["-c",PLACE,"place",job.tmp,job.dir],{on:job.on});
          if(placed.code!==0)throw Error(placed.stderr||"Cannot finish upload");
        }
      }
      job.state="done";
      job.saved=result.dest?.[0];
      notify({title:job.kind==="download"?T().downloaded(job.name):T().uploaded(job.name),
        body:job.saved || (job.on?job.on+":"+job.dir:job.dir),level:"success",timeout:5000});
    }catch(error){
      job.state="failed";job.error=String(error.message??error);
    }finally{
      if(job.tmp)await this.cleanRemoteStage(job.tmp,job.dir,job.on,job.remoteWin);
      await win("status-clean",{status:job.status}).catch(()=>{});
      this.refresh(cx);
      if(this.local.root)this.loadLocal(this.local.root,cx);
    }
  }

  cancelJob(job,cx){
    if(job.state==="queued"){job.state="cancelled";cx.notify();return;}
    if(job.state!=="running")return;
    job.state="cancelling";cx.notify();
    cx.spawn(async cx=>{
      try{await win("cancel",{status:job.status});}
      catch(error){
        if(job.state==="cancelling")job.state="running";
        notify({title:"Could not cancel transfer",body:String(error),level:"error"});
      }
      cx.notify();
    });
  }

  retryJob(job,cx){
    if(job.state!=="failed"&&job.state!=="cancelled")return;
    const {kind,path,name,isDirectory,on,destination,total,source,dir}=job;
    this.jobs=this.jobs.filter(item=>item!==job);
    this.enqueue({kind,path,name,isDirectory,on,destination,total,source,dir});
    cx.notify();
  }

  async tickQueue(cx){
    const active=this.jobs.find(job=>job.windows && ["running","cancelling"].includes(job.state));
    if(active){
      const result=await win("status",{status:active.status}).catch(()=>null);
      if(!result)return;
      if(result.code!=null){await this.finishJob(active,result,cx);return;}
      let bytes=result.bytes;
      if(active.tmp && Date.now()-(active.sampled??0)>2400){
        bytes=await this.remoteBytes(active.tmp,active.on).catch(()=>null);
        active.sampled=Date.now();
      }
      if(Number.isFinite(bytes))active.bytes=bytes;
      if(Number.isFinite(result.total))active.total=result.total;
      cx.notify();
      return;
    }
    const next=this.jobs.find(job=>job.windows && job.state==="queued");
    if(!next)return;
    next.state="starting";cx.notify();
    try{await this.startJob(next);}
    catch(error){next.state="failed";next.error=String(error.message??error);}
    cx.notify();
  }

  poll(cx) {
    if (!this.jobs?.length || this.polling) return;
    if(windowsHost() && !this.jobs.some(job=>["queued","running","cancelling"].includes(job.state)))return;
    this.polling=true;
    cx.spawn(async cx => {
      let changed = false;
      try {
        if(windowsHost()){
          await this.tickQueue(cx);
          return;
        }
        for (const job of [...this.jobs]) {
        const code = await readTextFile(job.status).catch(() => null);
        if (code === null) continue;
        this.jobs = this.jobs.filter(j => j !== job);
        changed = true;
        const ok = code.trim() === "0";
        const log = (await readTextFile(`${job.status}.log`).catch(() => null))?.trim();
        const fail = log?.split("\n").pop() || T().code(code.trim());
        if (job.kind === "download") {
          const dest = (await readTextFile(`${job.status}.dest`).catch(() => null)) || `${home()}/Downloads/${job.name}`;
          if (ok) notify({ title: T().downloaded(dest.split("/").pop()), body: dest.replace(home(), "~"), level: "success", timeout: 6000 });
          else notify({ title: T().downloadFailed(job.name), body: fail, level: "error" });
        } else {
          try {
            if (!ok) throw new Error(fail);
            const r = await exec("sh", ["-c", PLACE, "place", job.tmp, job.dir], { on: job.on });
            if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
            const names = r.stdout.trim().split("\n").filter(Boolean);
            notify({ title: T().uploaded(names.length === 1 ? names[0] : T().items(names.length)),
              body: job.on ? `${job.on}:${job.dir}` : job.dir.replace(home(), "~"), level: "success", timeout: 6000 });
          } catch (e) {
            notify({ title: T().uploadFailed(job.name), body: String(e.message ?? e), level: "error" });
          }
          await exec("rm", ["-rf", "--", job.tmp], { on: job.on }).catch(() => {});
          this.refresh(cx);
        }
        await exec("rm", ["-f", job.status, `${job.status}.log`, `${job.status}.dest`]).catch(() => {});
      }
      } finally {this.polling=false;}
      if (changed) cx.notify();
    });
  }

  // Files dragged in from Finder: uploaded into dir (a folder inside the shown one, "" for it).
  drop(paths, dir, cx) {
    if (!paths?.length || !this.root) return;
    const target = dir ? `${this.root}/${dir}` : this.root, on = this.on ?? null;
    cx.spawn(async cx => {
      try { await this.upload(paths, target, on); }
      catch (e) { notify({ title: T().uploadFailed(), body: String(e.message ?? e), level: "error" }); }
      cx.notify();
    });
  }

  menu(t) {
    const target = props().menu, list = MENU(target), items = list.filter(Boolean);
    const choose = it => {
      setShared(REQUEST, { id: `${Date.now()}-${Math.random()}`, action: it[0], ...target });
      closeOverlay(props().overlay);
    };
    return v_flex().id("files-menu").track_focus(this.handle).w_full().p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % items.length;
        else if (e.key === "up") this.at = (this.at + items.length - 1) % items.length;
        else if (e.key === "enter") choose(items[this.at]);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, n) => {
        if (!it) return div().mx(7).my(4).h(1).bg(t.border);
        const i = items.indexOf(it), danger = it[0] === "delete";
        return h_flex().id(`fm-${n}`).h(MENU_ROW).px(8).gap(9).rounded(7).items_center().cursor_pointer()
          .when(i === this.at, el => el.bg(t.hover)).hover(s => s.bg(t.hover))
          .on_hover((on, cx) => { if (on && this.at !== i) { this.at = i; cx.notify(); } })
          .on_click(() => choose(it))
          .child(svg(`${DIR}/${it[2]}`).size(14).flex_none().text_color(danger ? t.ansi1 : t.muted))
          .child(div().flex_1().min_w(0).truncate().text_color(danger ? t.ansi1 : t.foreground).child(it[1]));
      }));
  }

  // A name for a new file or folder, or a new name: Enter creates or renames, Esc cancels.
  initAsk(cx) {
    const a = props().ask, value = a.kind === "rename" ? a.name : "";
    this.text = value; this.askError = null;
    this.input = InputState.new({ value });
    // Renaming a file selects its name without the extension, as Finder does.
    const dot = a.kind === "rename" && !a.dir ? value.lastIndexOf(".") : -1;
    if (value) this.input.set_selected_range({ start: 0, end: dot > 0 ? dot : value.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.askError = null; cx.notify(); });
    this.input.on("submit", (_e, cx) => { this.submitAsk(); cx.notify(); });
    this.input.focus();
    cx.timer.after(400, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  submitAsk() {
    const a = props().ask, value = this.text.trim();
    if (!validName(value)) { this.askError = T().badName; return; }
    const action = { "new-file": "create-file", "new-folder": "create-folder", rename: "rename-yes" }[a.kind];
    setShared(REQUEST, { id: `${Date.now()}-${Math.random()}`, action, ...a, value });
    closeOverlay(props().overlay);
  }

  ask(t) {
    const a = props().ask;
    const title = a.kind === "rename" ? T().renameTitle(a.name) : a.kind === "new-file" ? T().newFileTitle : T().newFolderTitle;
    const where = a.on ? `${a.on}:${a.folder}` : a.folder.replace(home(), "~");
    const button = (id, label, primary, act) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12.5).cursor_pointer().hover(s => s.opacity(0.88)).on_click(act).child(label);
    return v_flex().id("files-ask").track_focus(this.handle).size_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .child(div().text_size(14).font_semibold().truncate().child(title))
      .child(div().pt(4).text_size(12).text_color(t.dim).truncate().child(T().in(where)))
      .child(div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(T().nameLabel))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(this.askError ? t.ansi1 : t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(div().h(18).pt(4).text_size(11.5).text_color(t.ansi1).child(this.askError ?? ""))
      .child(h_flex().flex_1().items_end().justify_end().gap(8)
        .child(button("ask-cancel", T().cancel, false, () => closeOverlay(props().overlay)))
        .child(button("ask-ok", a.kind === "rename" ? T().save : T().create, true, (_e, cx) => { this.submitAsk(); cx.notify(); })));
  }

  // "Delete …?" with the path and the machine; Enter deletes, Esc cancels.
  confirm(t) {
    const c = props().confirm;
    const yes = () => {
      setShared(REQUEST, { id: `${Date.now()}-${Math.random()}`, action: "delete-yes", ...c });
      closeOverlay(props().overlay);
    };
    const button = (id, label, bg, fg, border, act) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(border).bg(bg)
      .text_color(fg).cursor_pointer().hover(s => s.opacity(0.88)).on_click(act).child(label);
    return v_flex().id("files-confirm").track_focus(this.handle).size_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "enter") yes();
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation();
      })
      .child(div().font_semibold().text_size(14).text_color(t.foreground).truncate().child(T().askDelete(c.dir, c.name)))
      .child(div().text_size(12).text_color(t.muted).truncate().child(c.on ? `${c.on}:${c.path}` : c.path))
      .child(div().text_size(12).text_color(t.dim).child(`${c.on ? `${T().remoteDelete} ` : ""}${T().deleteDetail(c.dir)}`))
      .child(h_flex().flex_1().items_end().justify_end().gap(8)
        .child(button("no", T().cancel, t.popover, t.foreground, t.input, () => closeOverlay(props().overlay)))
        .child(button("yes", T().confirmDelete, t.ansi1, t.background, t.ansi1, yes)));
  }

  select(path, dir) {
    this.selected = { path, dir };
    this.keys?.focus();
  }

  clickRow(entry,event,cx,orderedNames){
    const modifiers=event?.modifiers;
    const range=!!modifiers?.shift,toggle=!!(modifiers?.control||modifiers?.platform);
    const state=selectRows(this.selection,this.anchor,entry.name,orderedNames,{range,toggle});
    this.selection=state.selection;this.anchor=state.anchor;
    const single=this.selection.size===1?this.selectedEntries()[0]:null;
    this.selected=single?{path:single.name,dir:single.dir}:null;
    this.keys.focus();
    if(range||toggle){cx.notify();return;}
    if(entry.dir)this.navigate(joinPath(this.root,entry.name),cx);
    else this.handoff(entry.name,cx)||this.show(entry.name,cx);
  }

  rows(t,dark,showDate){
    const entries=this.visibleEntries();
    const orderedNames=entries.map(entry=>entry.name);
    return entries.map(entry=>{
      const path=entry.name,mark=this.marks[joinPath(this.root,path)];
      const row=h_flex().id("file-"+path).h(28).flex_none().px(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(this.selection.has(path),el=>el.bg(t.selected)).hover(style=>style.bg(t.hover))
        .on_mouse_down("left",(_event,cx)=>cx.stop_propagation())
        .on_click((event,cx)=>this.clickRow(entry,event,cx,orderedNames))
        .on_mouse_down("right",(_event,cx)=>{
          cx.stop_propagation();
          if(!this.selection.has(path)){
            this.selection=new Set([path]);this.anchor=path;this.select(path,entry.dir);
          }
          cx.notify();this.openMenu(path,entry.dir);
        })
        .on_drop((e,cx)=>{cx.stop_propagation();this.drop(e.paths,entry.dir?path:"",cx);})
        .child(image(icon(path,entry.dir,false,dark)).size(16).flex_none())
        .child(div().flex_1().min_w(0).truncate().tooltip(entry.name).child(entry.name))
        .when(Boolean(mark),el=>el.child(div().text_size(10).text_color(t.muted).child(mark)))
        .child(div().w(62).flex_none().text_size(10.5).text_color(t.dim).child(entry.dir?"—":bytesText(entry.size)));
      if(showDate)row.child(div().w(104).flex_none().text_size(10.5).text_color(t.dim)
        .tooltip(Number.isFinite(entry.mtime)?new Date(entry.mtime).toLocaleString():"수정 날짜 없음").child(modifiedLabel(entry.mtime)));
      return row;
    });
  }

  inputBox(state,t){
    return Input.new(state).w_full().h(25).px(7).rounded(5).border_1()
      .border_color(t.border).bg(t.background).text_size(11).text_color(t.foreground);
  }

  sortLabel(field,label){
    return label+(this.sortBy===field?(this.sortDirection===1?" ↑":" ↓"):"");
  }

  browserPane(t,dark){
    const showDate=!this.split || (this.size?.width??740)>650;
    const selected=this.selectedEntries();
    const address=this.on
      ? h_flex().gap(6).items_center()
          .child(div().max_w(100).truncate().text_size(10).text_color(t.muted).tooltip(this.on).child(this.on))
          .child(div().flex_1().min_w(0).child(this.inputBox(this.pathInput,t)))
      : this.inputBox(this.pathInput,t);
    const pane=v_flex().flex_1().h_full().min_w(0).min_h(0)
      .when(!!this.split,el=>el.child(h_flex().h(29).flex_none().items_center().px(8).bg(t.surface)
        .child(div().flex_1().min_w(0).truncate().text_size(11).child(this.on?"Remote · "+this.on:"This PC"))
        .child(this.navButton("files-split-download","← Download","Send selected files to the left folder",
          selected.length>0&&!!this.local.root&&!this.local.loading&&!this.error,
          (_e,cx)=>this.queueDownloads(selected,this.root,this.on,cx,this.local.root),t))))
      .child(div().px(8).py(4).flex_none().child(address));
    if(this.file)return pane.child(this.preview(t));
    return pane
      .child(h_flex().h(33).flex_none().px(8).gap(5).items_center()
        .child(div().flex_1().min_w(0).child(this.inputBox(this.searchInput,t)))
        .when(selected.length>0,el=>el.child(this.navButton("files-selected-download","↓ "+selected.length,
          this.split?"Download selected to the left folder":"Download selected",!this.split||(!!this.local.root&&!this.local.loading),
          (_e,cx)=>this.queueDownloads(selected,this.root,this.on,cx,this.split?this.local.root:null),t))))
      .child(h_flex().h(28).flex_none().px(14).gap(7).items_center().bg(t.surface).text_size(11).text_color(t.muted)
        .child(div().id("files-sort-name").flex_1().min_w(0).cursor_pointer().on_click((_e,cx)=>this.setSort("name",cx)).child(this.sortLabel("name","이름")))
        .child(div().id("files-sort-size").w(62).flex_none().cursor_pointer().on_click((_e,cx)=>this.setSort("size",cx)).child(this.sortLabel("size","크기")))
        .when(showDate,el=>el.child(div().id("files-sort-date").w(104).flex_none().cursor_pointer()
          .on_click((_e,cx)=>this.setSort("mtime",cx)).child(this.sortLabel("mtime","수정 날짜")))))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .on_mouse_down("left",(_e,cx)=>{this.clearSelection();this.keys.focus();cx.notify();})
        .on_mouse_down("right",()=>this.root&&this.openMenu("",true))
        .on_drop((e,cx)=>this.drop(e.paths,"",cx)).children(this.rows(t,dark,showDate))
        .when(!!this.error||!this.visibleEntries().length,el=>el.child(div().p(8).text_size(12).text_color(t.dim)
          .child(this.error||(this.loading?"Loading files…":this.search?"No matching files":this.root?"No files":"No folder"))))
        .when(this.limited,el=>el.child(div().p(8).text_size(11).text_color(t.dim).child("현재 폴더는 최대 500개까지 표시합니다"))));
  }

  localPane(t,dark){
    const local=this.local,entries=sortedEntries(local.entries);
    const order=entries.map(entry=>entry.name);
    const canSend=local.selection.size>0&&!!this.root&&!this.loading&&!this.error&&!local.loading;
    const rows=entries.map(entry=>h_flex().id("local-file-"+entry.name).h(28).px(8).gap(7).items_center().rounded(6)
      .hover(style=>style.bg(t.hover)).when(local.selection.has(entry.name),el=>el.bg(t.selected))
      .cursor_pointer().on_click((event,cx)=>{
        const range=!!event?.modifiers?.shift,toggle=!!event?.modifiers?.control;
        const next=selectRows(local.selection,local.anchor,entry.name,order,{range,toggle});
        local.selection=next.selection;local.anchor=next.anchor;
        if(entry.dir&&!range&&!toggle)this.loadLocal(joinPath(local.root,entry.name),cx);
        else cx.notify();
      })
      .child(image(icon(entry.name,entry.dir,false,dark)).size(16).flex_none())
      .child(div().flex_1().min_w(0).truncate().tooltip(entry.name).child(entry.name))
      .child(div().w(62).flex_none().text_size(10.5).text_color(t.dim).child(entry.dir?"—":bytesText(entry.size))));
    return v_flex().flex_1().h_full().min_w(0).min_h(0).border_r(1).border_color(t.border)
      .child(h_flex().h(29).flex_none().items_center().px(8).bg(t.surface)
        .child(div().flex_1().text_size(11).child("Local"))
        .child(this.navButton("files-split-upload","Upload →","Send selected files to the right folder",canSend,
          (_e,cx)=>this.uploadLocalSelection(cx),t)))
      .child(h_flex().gap(4).px(7).py(4).items_center()
        .child(this.navButton("files-local-up","↑","Local parent folder",!!local.root&&parentPath(local.root)!==local.root,
          (_e,cx)=>this.loadLocal(parentPath(local.root),cx),t))
        .child(div().flex_1().min_w(0).child(this.inputBox(this.localPathInput,t))))
      .child(v_flex().id("files-local-list").flex_1().min_h(0).overflow_y_scrollbar().p(5)
        .when(!!local.error||local.loading||!entries.length,el=>el.child(div().p(7).text_size(11).text_color(t.dim)
          .child(local.error||(local.loading?"Loading files…":"No files"))))
        .children(rows));
  }

  downloadFolderDialog(t){
    const settings=props().downloadSettings;
    const choose=(type,reset)=>{
      setShared(REQUEST,{id:String(Date.now())+Math.random(),action:"download-settings",from:settings.from,scope:settings.scope,type,reset});
      closeOverlay(props().overlay);
    };
    const button=(id,label,tip,enabled,action)=>this.navButton(id,label,tip,enabled,action,t)
      .h(28).border_1().border_color(enabled?t.input:t.border).bg(enabled?t.raised:t.popover);
    const row=(type,title,value,fallback)=>v_flex().w_full().p(8).gap(5).flex_none()
      .rounded(7).border_1().border_color(t.border).bg(t.surface)
      .child(div().text_size(11).font_semibold().truncate().tooltip(title).child(title))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).h(28).px(7).flex().items_center()
          .rounded(5).border_1().border_color(t.input).bg(t.background)
          .child(div().min_w(0).truncate().text_size(11).text_color(value?t.foreground:t.muted)
            .tooltip(value||fallback).child(value||fallback)))
        .child(button("choose-download-"+type,"Choose","Remember a local folder",true,()=>choose(type,false)))
        .child(button("reset-download-"+type,"Reset","Use the fallback folder",!!value,()=>choose(type,true))));
    return v_flex().size_full().p(13).gap(8).bg(t.popover).text_color(t.foreground)
      .child(div().font_semibold().child("Download folders"))
      .child(row("machine","Machine · "+(settings.scope.on||"This PC"),settings.machine,"Default Downloads"))
      .when(!!settings.scope.project,el=>el.child(row("project","Project · "+settings.scope.project,settings.project,"Use machine folder")))
      .child(h_flex().gap(6).items_center().justify_end()
        .when(!!settings.scope.project,el=>el.child(div().flex_1().min_w(0).h(28).px(7).flex().items_center()
          .rounded(5).border_1().border_color(t.border).bg(t.surface)
          .child(div().truncate().text_size(10).text_color(t.muted).child("Project folder takes priority."))))
        .child(button("download-folders-close","Close","Close",true,()=>closeOverlay(props().overlay))));
  }

  queuePanel(t){
    if(!this.queueOpen||!this.jobs.length)return div().h(0).flex_none();
    const elapsed=job=>Math.max(1,(Date.now()-(job.started??Date.now()))/1000);
    const progress=job=>{
      const bytes=job.bytes,total=job.total;
      if(!Number.isFinite(bytes))return "Measuring transfer…";
      if(!(total>0))return bytesText(bytes);
      const rate=bytes/elapsed(job);
      const left=rate>0&&total>bytes?Math.ceil((total-bytes)/rate):0;
      return bytesText(bytes)+" / "+bytesText(total)+" · "+Math.min(99,Math.floor(100*bytes/total))+"%"
        +(left>0?" · ~"+(left<60?left+"s":Math.ceil(left/60)+"m"):"");
    };
    const rows=this.jobs.map(job=>{
      const state=job.state==="running"?progress(job):job.state==="failed"?job.error:job.state;
      const target=job.kind==="download"?job.saved||job.destination:(job.on?job.on+":":"")+job.dir;
      return h_flex().id("job-"+job.status).flex_none().gap(6).items_center().px(8).py(4)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_size(11).tooltip(target||"").child((job.kind==="download"?"↓ ":"↑ ")+job.name))
          .child(div().truncate().text_size(10).text_color(job.state==="failed"?t.ansi1:t.muted).tooltip(state||"").child(state||"")))
        .when(["queued","running"].includes(job.state),el=>el.child(this.navButton("cancel-"+job.status,"Cancel","Cancel transfer",true,
          (_e,cx)=>this.cancelJob(job,cx),t)))
        .when(["failed","cancelled"].includes(job.state),el=>el.child(this.navButton("retry-"+job.status,"Retry","Queue this transfer again",true,
          (_e,cx)=>this.retryJob(job,cx),t)));
    });
    return v_flex().h(132).flex_none().min_h(0).border_t(1).border_color(t.border).bg(t.surface)
      .child(h_flex().h(26).px(8).items_center()
        .child(div().flex_1().text_size(11).font_semibold().child("Transfers"))
        .child(this.navButton("files-queue-clear","Clear finished","Remove completed items",this.jobs.some(job=>job.state==="done"),
          (_e,cx)=>{this.jobs=this.jobs.filter(job=>job.state!=="done");cx.notify();},t)))
      .child(v_flex().id("files-queue-list").flex_1().min_h(0).overflow_y_scrollbar().children(rows));
  }

  navButton(id,label,tip,enabled,action,t,active=false){
    return div().id(id).h(25).px(7).flex_none().flex().items_center().rounded(5).text_size(11).text_color(enabled?t.foreground:t.dim)
      .when(active,el=>el.bg(t.selected).border_1().border_color(t.accent))
      .when(enabled,el=>el.cursor_pointer().hover(s=>s.bg(t.hover))).tooltip(tip)
      .on_click((event,cx)=>{if(enabled)action(event,cx);}).child(label);
  }

  render(cx) {
    if (props()?.downloadSettings) return this.downloadFolderDialog(theme());
    if (props()?.menu) return this.menu(theme());
    if (props()?.confirm) return this.confirm(theme());
    if (props()?.ask) return this.ask(theme());
    this.take(cx);
    if (!checking() && this.viewKey() !== this.context) this.refresh(cx);
    const t = theme(), dark = Boolean(settings().dark);
    const canOpenTerminal=!!this.root&&!this.error&&!this.loading;
    const previewOpen=Boolean(this.file);
    const activeJobs=this.jobs.filter(job=>["queued","starting","running","cancelling","finalizing"].includes(job.state)).length;
    return v_flex().id("files").track_focus(this.keys).size_full().min_h(0)
      .on_key_down((e, cx) => {
        if(this.editorsFocused.size)return;
        if (e.keystroke === "cmd-v" || (windowsHost() && e.keystroke === "ctrl-v")) { cx.stop_propagation(); this.pasteKey(cx); }
        else if (e.keystroke === "escape" && this.selection.size) { cx.stop_propagation(); this.clearSelection(); cx.notify(); }
      })
      // Sizes arrive in window points; element sizes are given at zoom 1.
      .on_size_change((size, cx) => {
        const z = settings().zoom || 1, w = size.width / z, h = size.height / z;
        if (w !== this.size?.width || h !== this.size?.height) { this.size = { width: w, height: h }; cx.notify(); }
      })
      .rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(previewOpen, el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted)
          .tooltip("미리보기 닫기").on_click((_e,cx)=>this.closePreview(cx)).child("←")))
        .child(div().font_semibold().child("Files"))
        .when(windowsHost(),el=>el.child(this.navButton("files-split","Split","Show local and active folders side by side",true,(_e,cx)=>this.toggleSplit(cx),t,!!this.split))
          .child(this.navButton("files-queue",activeJobs?"Queue "+activeJobs:"Queue","Show transfers",true,(_e,cx)=>{this.queueOpen=!this.queueOpen;cx.notify();},t,this.queueOpen)))
        .child(h_flex().flex_1().min_w(0).gap(6).justify_end().items_center().text_size(12).text_color(t.dim)
          .when(Boolean(this.file), el => el.child(image(icon(this.file, false, false, dark)).size(14).flex_none()))
          .child(div().min_w(0).truncate().child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
          .when(this.md !== null && Boolean(this.file), el => el.child(div().id("files-md-toggle").flex_none().px(8).py(2).ml(4).rounded(6).border_1().border_color(t.border)
            .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.source = !this.source; cx.notify(); })
            .child(this.source ? T().preview : T().source)))))
      .child(h_flex().h(32).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border)
        .child(this.navButton("files-nav-back","←",previewOpen?"미리보기 닫기":"뒤로",previewOpen||this.history.length>0,
          (_e,cx)=>this.goBack(cx),t))
        .child(this.navButton("files-nav-up","↑ 상위",previewOpen?"미리보기 닫기":"상위 폴더",previewOpen||(!!this.root&&parentPath(this.root)!==this.root),
          (_e,cx)=>this.goUp(cx),t))
        .child(this.navButton("files-nav-terminal","터미널 위치",this.followTerminalEnabled!==false?"ON: 터미널 위치를 따라갑니다. 클릭하면 현재 폴더에 고정합니다.":"OFF: 현재 폴더에 고정되어 있습니다. 클릭하면 터미널 위치로 이동해 다시 따라갑니다.",true,(_e,cx)=>this.toggleTerminalFollow(cx),t,this.followTerminalEnabled!==false))
        .child(div().flex_1())
        .child(this.navButton("files-open-terminal",svg(DIR+"/terminal.svg").size(16).text_color(canOpenTerminal?t.accent:t.dim),
          "Open a terminal in this folder",canOpenTerminal,()=>this.openTerminal(),t))
        .when(windowsHost(),el=>el.child(this.navButton("files-download-settings","↓ Settings","Remember a local download folder",!!this.root,
          ()=>this.openDownloadSettings(),t)))
        .child(this.navButton("files-nav-refresh","↻","새로고침",!this.loading,(_e,cx)=>{this.refresh(cx);cx.notify();},t)))
      .child(h_flex().flex_1().w_full().items_stretch().min_h(0).min_w(0)
        .when(!!this.split,el=>el.child(this.localPane(t,dark)))
        .child(this.browserPane(t,dark)))
      .when(windowsHost()&&this.queueOpen,el=>el.child(this.queuePanel(t)))
      .when(!windowsHost() && this.jobs.length > 0, el => el.child(h_flex().h(30).flex_none().px(14).gap(8).items_center().border_t(1).border_color(t.border).text_size(12).text_color(t.muted)
        .child(svg(`${DIR}/spinner.svg`).size(12).flex_none().text_color(t.working).spin(900))
        .child(div().flex_1().min_w(0).truncate().child(this.jobs.length === 1 ? T()[this.jobs[0].kind === "upload" ? "uploading" : "downloading"](this.jobs[0].name) : T().transferring(this.jobs.length)))));
  }
}
