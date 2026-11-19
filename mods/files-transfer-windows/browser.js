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
export function folderAddress(text, windows) {
  const path=text.trim();
  if(/[\x00-\x1f]/.test(path))return null;
  if(windows){
    const normalized=path.replace(/\\/g,"/");
    return /^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+)/.test(normalized)?browserPath(normalized):null;
  }
  return path.startsWith("/")?browserPath(path):null;
}

export function sortedEntries(entries, field="name", direction=1) {
  const name=(a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"});
  return [...entries].sort((a,b)=>{
    const kind=Number(b.dir)-Number(a.dir);
    if(kind)return kind;
    if(field==="mtime" || field==="size"){
      const validA=Number.isFinite(a[field]),validB=Number.isFinite(b[field]);
      if(validA!==validB)return validA?-1:1;
      if(validA&&a[field]!==b[field])return (a[field]-b[field])*direction;
      return name(a,b);
    }
    return name(a,b)*direction;
  });
}

export function matchesName(name, query) {
  const term=query.trim().toLowerCase();
  const value=name.toLowerCase();
  if(!term.includes("*")&&!term.includes("?"))return value.includes(term);
  // Wildcards match the whole name. Backtrack only to the most recent star.
  let i=0,j=0,star=-1,matched=0;
  while(i<value.length){
    if(term[j]==="?" || term[j]===value[i]){i++;j++;}
    else if(term[j]==="*"){star=j++;matched=i;}
    else if(star>=0){j=star+1;i=++matched;}
    else return false;
  }
  while(term[j]==="*")j++;
  return j===term.length;
}

export function selectRows(selection, anchor, name, orderedNames, {toggle=false, range=false}={}) {
  const next=new Set(selection);
  if(range && orderedNames.includes(anchor)){
    const first=orderedNames.indexOf(anchor), last=orderedNames.indexOf(name);
    for(const item of orderedNames.slice(Math.min(first,last),Math.max(first,last)+1))next.add(item);
    return {selection:next,anchor};
  }
  if(toggle){
    if(next.has(name))next.delete(name);else next.add(name);
    return {selection:next,anchor:name};
  }
  return {selection:new Set([name]),anchor:name};
}
export function modifiedLabel(stamp) {
  if(!Number.isFinite(stamp))return "—";
  const date=new Date(stamp),pad=n=>String(n).padStart(2,"0");
  if(!Number.isFinite(date.getTime()))return "—";
  return `${String(date.getFullYear()).slice(-2)}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
