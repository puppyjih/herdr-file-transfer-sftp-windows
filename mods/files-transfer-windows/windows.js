// Windows port additions, 2026-11-17. Apache-2.0; see LICENSE and NOTICE.
import { exec, appHome, readTextFile } from "herdr";

export const normalize = path => String(path ?? "").replace(/\\/g, "/");
export const psQuote = value => "'" + String(value).replace(/'/g, "''") + "'";
export const isWindowsPath = path => /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/.test(String(path));
// PowerShell -EncodedCommand uses UTF-16LE, including surrogate pairs.
export function encodedCommand(text) {
  const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes=[];
  for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);bytes.push(c&255,c>>>8);}
  let out="";
  for(let i=0;i<bytes.length;i+=3){const a=bytes[i],b=bytes[i+1],c=bytes[i+2];out+=alphabet[a>>>2]+alphabet[((a&3)<<4)|((b??0)>>>4)]+(b===undefined?"=":alphabet[((b&15)<<2)|((c??0)>>>6)])+(c===undefined?"=":alphabet[c&63]);}
  return out;
}
export async function winResult(action, data={}, on=null) {
  const script=normalize(appHome())+"/mods/files-transfer-windows/windows.ps1";
  const payload=JSON.stringify({...data,action,appHome:normalize(appHome()),script});
  // Remote hosts run the same small helper in memory; no server-side installation.
  const command=on?`& { ${await readTextFile(script.replace("windows.ps1","windows-remote.ps1"))} } ${psQuote(payload)}`:
    `& ([scriptblock]::Create([IO.File]::ReadAllText(${psQuote(script)}))) ${psQuote(payload)}`;
  return exec("powershell.exe",["-NoProfile","-NonInteractive","-STA","-EncodedCommand",encodedCommand(command)],{on,timeout:30000});
}
export async function win(action,data={},on=null) {
  const r=await winResult(action,data,on);
  if(r.code!==0)throw new Error((r.stderr||r.stdout||`Windows operation failed (${r.code})`).trim());
  return JSON.parse(r.stdout.trim()||"null");
}
export const jobPath = () => `${normalize(appHome())}/data/files-transfer-windows/win-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
