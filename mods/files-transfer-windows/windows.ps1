# Windows port additions, 2026-11-17. Apache-2.0; see LICENSE and NOTICE.
param([Parameter(Mandatory=$true)][string]$RequestJson)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$utf8=[Text.UTF8Encoding]::new($false)
$q=$RequestJson | ConvertFrom-Json
function Json($value) { ConvertTo-Json -InputObject $value -Depth 12 -Compress }
function Full([string]$p) {
  if([string]::IsNullOrWhiteSpace($p) -or $p -match '[\x00-\x1f]'){throw 'Invalid path'}
  [IO.Path]::GetFullPath($p)
}
function Name([string]$n) {
  if(!$n -or $n -in @('.','..') -or $n -match '[<>:"/\\|?*\x00-\x1f]' -or $n -match '[. ]$' -or $n -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)'){throw 'Invalid Windows file name'}
  $n
}
function Within([string]$p,[string]$root) {
  $p=Full $p; $root=(Full $root).TrimEnd('\')+'\'
  if(!$p.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'Path is outside its temporary directory'}
  $p
}
function NoLink([string]$p) {
  if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Copying links/junctions is not supported'}
}
function Clone([string]$src,[string]$dst) {
  NoLink $src
  if([IO.Directory]::Exists($src)) {
    [IO.Directory]::CreateDirectory($dst) | Out-Null
    foreach($child in Get-ChildItem -LiteralPath $src -Force){ Clone $child.FullName (Join-Path $dst $child.Name) }
  } else { [IO.File]::Copy($src,$dst,$false) }
}
function Publish([string]$src,[string]$dir,[string]$n) {
  $n=Name $n; $isDir=[IO.Directory]::Exists($src)
  $ext=if($isDir -or $n.StartsWith('.')){''}else{[IO.Path]::GetExtension($n)}
  $stem=$n.Substring(0,$n.Length-$ext.Length)
  for($i=0;$i -lt 10000;$i++) {
    $candidate=Join-Path $dir $(if($i -eq 0){$n}else{"$stem ($i)$ext"})
    try {
      if($isDir){[IO.Directory]::Move($src,$candidate)}else{[IO.File]::Move($src,$candidate)}
      return $candidate
    } catch [IO.IOException] { if(!(Test-Path -LiteralPath $candidate)){throw} }
  }
  throw 'Too many names already exist'
}
function JobPath([string]$p) {
  $root=Join-Path $q.appHome 'data\files-transfer-windows'
  $p=Within $p $root
  if([IO.Path]::GetFileName($p) -notmatch '^win-[a-zA-Z0-9-]+$'){throw 'Invalid transfer ID'}
  $p
}
function RemoveStage([string]$p,[string]$dir) {
  $p=Within $p $dir
  if([IO.Path]::GetFileName($p) -notmatch '^\.herdr-(upload|download)\.[a-f0-9]{32}$'){throw 'Invalid staging path'}
  if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Recurse -Force}
}
function Scp([string[]]$items) {
  $exe=(Get-Command scp.exe -ErrorAction Stop).Source
  # Native stderr is diagnostic output, not a PowerShell terminating error.
  $old=$ErrorActionPreference; $ErrorActionPreference='Continue'
  try { $result=& $exe @items 2>&1; $code=$LASTEXITCODE }
  finally { $ErrorActionPreference=$old }
  if($code -ne 0){throw "SCP exit ${code}: $($result -join [Environment]::NewLine)"}
}
function Worker {
  $status=JobPath $q.status; $stage=$null; $dir=$null; $dest=@()
  try {
    if($q.kind -eq 'download') {
      $dir=Full $q.destination; [IO.Directory]::CreateDirectory($dir) | Out-Null
      $stage=Join-Path $dir ('.herdr-download.'+[Guid]::NewGuid().ToString('N'))
      [IO.Directory]::CreateDirectory($stage) | Out-Null
      $n=Name $q.name; $staged=Join-Path $stage $n
      if($q.remote){Scp @('-r','-p','-B','-o','BatchMode=yes','-o','ConnectTimeout=15','--',[string]$q.source,($staged -replace '\\','/'))}
      else {Clone (Full $q.source) $staged}
      $dest=@(Publish $staged $dir $n)
    } elseif($q.kind -eq 'upload-local') {
      $dir=Full $q.destination
      if(![IO.Directory]::Exists($dir)){throw 'Destination folder does not exist'}
      $stage=Join-Path $dir ('.herdr-upload.'+[Guid]::NewGuid().ToString('N'))
      [IO.Directory]::CreateDirectory($stage) | Out-Null
      foreach($source in $q.sources) {
        $src=Full $source; $n=Name ([IO.Path]::GetFileName($src.TrimEnd('\')))
        $unit=Join-Path $stage ([Guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($unit) | Out-Null
        $item=Join-Path $unit $n
        Clone $src $item
        $dest+=Publish $item $dir $n
      }
    } elseif($q.kind -eq 'upload-remote') {
      $scpArgs=@('-r','-p','-B','-o','BatchMode=yes','-o','ConnectTimeout=15','--')
      foreach($source in $q.sources){$src=Full $source;NoLink $src;$scpArgs+=($src -replace '\\','/')}
      $scpArgs+=[string]$q.destination
      Scp $scpArgs
    } else {throw 'Unknown transfer kind'}
    [IO.File]::WriteAllText($status+'.dest',(Json @($dest)),$utf8)
    [IO.File]::WriteAllText($status+'.tmp','0',$utf8)
  } catch {
    [IO.File]::WriteAllText($status+'.log',($_.Exception.Message),$utf8)
    [IO.File]::WriteAllText($status+'.tmp','1',$utf8)
  } finally {
    if($stage){try{RemoveStage $stage $dir}catch{}}
    if(Test-Path -LiteralPath ($status+'.tmp')){Move-Item -LiteralPath ($status+'.tmp') -Destination $status -Force}
  }
}
try {
  switch($q.action) {
    'worker-file' { $q=Get-Content -LiteralPath $q.requestFile -Raw -Encoding UTF8 | ConvertFrom-Json; Worker; break }
    'start' {
      $status=JobPath $q.status
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($status)) | Out-Null
      if(Test-Path -LiteralPath ($status+'.request.json')){throw 'Transfer ID already used'}
      [IO.File]::WriteAllText($status+'.request.json',($q | ConvertTo-Json -Depth 12 -Compress),$utf8)
      $body=Json @{action='worker-file';requestFile=$status+'.request.json'}
      $script=Full $q.script
      $command="& ([scriptblock]::Create([IO.File]::ReadAllText('"+$script.Replace("'","''")+"'))) '"+$body.Replace("'","''")+"'"
      $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
      Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-NonInteractive','-STA','-EncodedCommand',$encoded) -WindowStyle Hidden | Out-Null
      Json @{started=$true}; break
    }
    'status' {
      $status=JobPath $q.status
      if(!(Test-Path -LiteralPath $status)){Json @{code=$null};break}
      $code=[IO.File]::ReadAllText($status).Trim()
      $log=if(Test-Path -LiteralPath ($status+'.log')){[IO.File]::ReadAllText($status+'.log')}else{''}
      $dest=if(Test-Path -LiteralPath ($status+'.dest')){[IO.File]::ReadAllText($status+'.dest') | ConvertFrom-Json}else{@()}
      Json @{code=$code;log=$log;dest=@($dest)};break
    }
    'status-clean' {
      $status=JobPath $q.status
      foreach($suffix in @('','.log','.dest','.request.json')){if(Test-Path -LiteralPath ($status+$suffix)){Remove-Item -LiteralPath ($status+$suffix) -Force}}
      Json $true;break
    }
    'list' {
      $items=@(Get-ChildItem -LiteralPath (Full $q.path) -Force | Where-Object {$_.Name -ne '.git' -and $_.Name -notmatch '^\.herdr-(upload|download)\.'} | Select-Object -First 501 | ForEach-Object {@{name=$_.Name;dir=$_.PSIsContainer;mtime=([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeMilliseconds()}})
      Json @($items);break
    }
    'size' { Json (Get-Item -LiteralPath (Full $q.path)).Length;break }
    'stage-create' {
      $dir=Full $q.path
      if(![IO.Directory]::Exists($dir)){throw 'Upload folder does not exist'}
      $p=Join-Path $dir ('.herdr-upload.'+[Guid]::NewGuid().ToString('N'))
      [IO.Directory]::CreateDirectory($p) | Out-Null
      Json ($p -replace '\\','/');break
    }
    'stage-place' {
      $dir=Full $q.destination; $stage=Within $q.path $dir
      if([IO.Path]::GetFileName($stage) -notmatch '^\.herdr-upload\.[a-f0-9]{32}$'){throw 'Invalid remote staging path'}
      $names=@()
      foreach($item in Get-ChildItem -LiteralPath $stage -Force){$names+=[IO.Path]::GetFileName((Publish $item.FullName $dir $item.Name))}
      RemoveStage $stage $dir
      Json @($names);break
    }
    'stage-remove' { RemoveStage (Full $q.path) (Full $q.destination); Json $true;break }
    'clipboard-files' { Add-Type -AssemblyName System.Windows.Forms; Json @([Windows.Forms.Clipboard]::GetFileDropList());break }
    'copy-path' { Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::SetText([string]$q.path); Json $true;break }
    'reveal' { Start-Process explorer.exe -ArgumentList ('/select,"'+(Full $q.path)+'"') -WindowStyle Hidden; Json $true;break }
    'open' { Start-Process -FilePath (Full $q.path) -WindowStyle Hidden; Json $true;break }
    'downloads' {
      $key=Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
      $p=$key.'{374DE290-123F-4565-9164-39C4925E467B}'
      if(!$p){$p=Join-Path $env:USERPROFILE 'Downloads'}
      Json ([Environment]::ExpandEnvironmentVariables($p) -replace '\\','/');break
    }
    'new-file' { $p=Full $q.path;Name ([IO.Path]::GetFileName($p)) | Out-Null; [IO.File]::Open($p,[IO.FileMode]::CreateNew).Dispose(); Json $true;break }
    'new-folder' { $p=Full $q.path;Name ([IO.Path]::GetFileName($p)) | Out-Null; if(Test-Path -LiteralPath $p){throw 'Name already exists'}; New-Item -ItemType Directory -Path $p -ErrorAction Stop | Out-Null;Json $true;break }
    'rename' {
      $p=Full $q.path;$to=Full $q.to;Name ([IO.Path]::GetFileName($to)) | Out-Null
      if([IO.Directory]::Exists($p)){[IO.Directory]::Move($p,$to)}else{[IO.File]::Move($p,$to)}
      Json $true;break
    }
    'trash' {
      $p=Full $q.path; $root=Full $q.root
      if($p -eq $root -or $p -eq [IO.Path]::GetPathRoot($p) -or $p -eq $env:USERPROFILE){throw 'Refusing to remove root/home/current folder'}
      Add-Type -AssemblyName Microsoft.VisualBasic
      if([IO.Directory]::Exists($p)){[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin')}
      else{[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin')}
      Json $true;break
    }
    'remove' {
      $p=Full $q.path; $root=Full $q.root
      if($p -eq $root -or $p -eq [IO.Path]::GetPathRoot($p) -or $p -eq $env:USERPROFILE){throw 'Refusing to remove root/home/current folder'}
      NoLink $p
      Remove-Item -LiteralPath $p -Recurse -Force
      Json $true;break
    }
    'image' {
      $file=Full $q.path; $ext=[IO.Path]::GetExtension($file).ToLowerInvariant()
      if($ext -eq '.svg'){Json @{file=($file -replace '\\','/');w=$null;h=$null};break}
      Add-Type -AssemblyName System.Drawing
      $img=[Drawing.Image]::FromFile($file)
      try {
        $w=$img.Width;$h=$img.Height
        if($ext -in @('.tif','.tiff','.ico')){$out=$file+'.png';$img.Save($out,[Drawing.Imaging.ImageFormat]::Png);$file=$out}
      } finally {$img.Dispose()}
      Json @{file=($file -replace '\\','/');w=$w;h=$h};break
    }
    'preview-clean' {
      $p=Within $q.path (Join-Path $q.appHome 'data\files-transfer-windows\preview')
      if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Recurse -Force}
      Json $true;break
    }
    'stage' {
      $dir=Within $q.destination (Join-Path $q.appHome 'data\files-transfer-windows\preview')
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dir)) | Out-Null
      if($q.remote){Scp @('-p','-B','-o','BatchMode=yes','-o','ConnectTimeout=15','--',[string]$q.source,($dir -replace '\\','/'))}
      else{[IO.File]::Copy((Full $q.source),$dir,$false)}
      $length=(Get-Item -LiteralPath $dir).Length
      if($length -gt 52428800){Remove-Item -LiteralPath $dir -Force;throw 'Image exceeds 50 MB preview limit'}
      Json @{file=($dir -replace '\\','/');bytes=$length};break
    }
    default {throw 'Unknown Windows operation'}
  }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
