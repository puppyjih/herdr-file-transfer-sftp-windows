# Windows port additions, 2026-11-17. Apache-2.0; see LICENSE and NOTICE.
# Sent in memory to remote Windows hosts; no server-side installation.
param([string]$RequestJson)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$q=$RequestJson | ConvertFrom-Json
function Json($value){ConvertTo-Json -InputObject $value -Depth 8 -Compress}
function Full([string]$p){
  if(!$p -or $p -match '[\x00-\x1f]'){throw 'Invalid path'}
  [IO.Path]::GetFullPath($p)
}
function Name([string]$n){
  if(!$n -or $n -in @('.','..') -or $n -match '[<>:"/\\|?*\x00-\x1f]' -or $n -match '[. ]$' -or $n -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)'){throw 'Invalid Windows file name'}
}
function NoLink([string]$p){
  if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Links/junctions are not supported'}
}
function Publish([string]$src,[string]$dir,[string]$n){
  Name $n
  $isDir=[IO.Directory]::Exists($src)
  $ext=if($isDir -or $n.StartsWith('.')){''}else{[IO.Path]::GetExtension($n)}
  $stem=$n.Substring(0,$n.Length-$ext.Length)
  for($i=0;$i -lt 10000;$i++){
    $dest=Join-Path $dir $(if($i -eq 0){$n}else{"$stem ($i)$ext"})
    try{
      if($isDir){[IO.Directory]::Move($src,$dest)}else{[IO.File]::Move($src,$dest)}
      return [IO.Path]::GetFileName($dest)
    }catch [IO.IOException]{if(!(Test-Path -LiteralPath $dest)){throw}}
  }
  throw 'Too many names already exist'
}
try{
  switch($q.action){
    'list'{
      Json @(Get-ChildItem -LiteralPath (Full $q.path) -Force | Where-Object {$_.Name -ne '.git' -and $_.Name -notmatch '^\.herdr-(upload|download)\.'} | Select-Object -First 501 | ForEach-Object {@{name=$_.Name;dir=$_.PSIsContainer;mtime=([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeMilliseconds();size=$_.Length}})
      break
    }
    'size'{Json (Get-Item -LiteralPath (Full $q.path)).Length;break}
    'tree-bytes'{
      $path=Full $q.path
      if(!(Test-Path -LiteralPath $path)){Json 0;break}
      $sizes=@(Get-ChildItem -LiteralPath $path -File -Recurse -Force -ErrorAction SilentlyContinue | Select-Object -First 5001 -ExpandProperty Length)
      if($sizes.Count -gt 5000){Json $null}else{Json ([long]($sizes | Measure-Object -Sum).Sum)}
      break
    }
    'new-file'{$p=Full $q.path;Name ([IO.Path]::GetFileName($p));[IO.File]::Open($p,[IO.FileMode]::CreateNew).Dispose();Json $true;break}
    'new-folder'{$p=Full $q.path;Name ([IO.Path]::GetFileName($p));if(Test-Path -LiteralPath $p){throw 'Name already exists'};New-Item -ItemType Directory -Path $p | Out-Null;Json $true;break}
    'rename'{$p=Full $q.path;$to=Full $q.to;Name ([IO.Path]::GetFileName($to));if([IO.Directory]::Exists($p)){[IO.Directory]::Move($p,$to)}else{[IO.File]::Move($p,$to)};Json $true;break}
    'stage-create'{
      $dir=Full $q.path
      if(![IO.Directory]::Exists($dir)){throw 'Upload folder does not exist'}
      $stage=Join-Path $dir ('.herdr-upload.'+[Guid]::NewGuid().ToString('N'))
      [IO.Directory]::CreateDirectory($stage) | Out-Null
      Json ($stage -replace '\\','/');break
    }
    {$_ -in 'stage-place','stage-remove'}{
      $dir=(Full $q.destination).TrimEnd('\');$stage=Full $q.path
      if([IO.Path]::GetDirectoryName($stage).TrimEnd('\') -ne $dir -or [IO.Path]::GetFileName($stage) -notmatch '^\.herdr-upload\.[a-f0-9]{32}$'){throw 'Invalid staging path'}
      NoLink $stage
      $names=@()
      if($q.action -eq 'stage-place'){
        foreach($item in Get-ChildItem -LiteralPath $stage -Force){NoLink $item.FullName;$names+=Publish $item.FullName $dir $item.Name}
      }
      Remove-Item -LiteralPath $stage -Recurse -Force
      Json @($names);break
    }
    'remove'{
      $p=Full $q.path
      if($p -eq (Full $q.root) -or $p -eq [IO.Path]::GetPathRoot($p) -or $p -eq $env:USERPROFILE){throw 'Refusing to remove root/home/current folder'}
      NoLink $p
      Remove-Item -LiteralPath $p -Recurse -Force
      Json $true;break
    }
    default{throw 'Unsupported remote Windows operation'}
  }
}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}
