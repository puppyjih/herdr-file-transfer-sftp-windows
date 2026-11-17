// Explorer navigation and ordering additions, 2026-11-17. Apache-2.0.
export function browserPath(path) {
  const value=String(path??"").replace(/\\/g,"/");
  if(/^\/$/.test(value))return "/";
  if(/^[A-Za-z]:\/*$/.test(value))return value.slice(0,2)+"/";
  return value.replace(/\/+$/,"");
}
export function parentPath(path) {
  const value=browserPath(path);
  if(!value||value==="/"||/^[A-Za-z]:\/$/.test(value)||/^\/\/[^/]+\/[^/]+$/.test(value))return value;
  const cut=value.lastIndexOf("/");
  return cut<0?value:browserPath(value.slice(0,cut)||"/");
}
export const joinPath=(root,name)=>`${browserPath(root).replace(/\/$/,"")}/${name}`;
export function sortedEntries(entries, field="name", direction=1) {
  const name=(a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"});
  return [...entries].sort((a,b)=>{
    const kind=Number(b.dir)-Number(a.dir);
    if(kind)return kind;
    if(field==="mtime"){
      const validA=Number.isFinite(a.mtime),validB=Number.isFinite(b.mtime);
      if(validA!==validB)return validA?-1:1;
      if(validA&&a.mtime!==b.mtime)return (a.mtime-b.mtime)*direction;
      return name(a,b);
    }
    return name(a,b)*direction;
  });
}
export function modifiedLabel(stamp) {
  if(!Number.isFinite(stamp))return "—";
  const date=new Date(stamp),pad=n=>String(n).padStart(2,"0");
  if(!Number.isFinite(date.getTime()))return "—";
  return `${String(date.getFullYear()).slice(-2)}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
