# Windows adaptation, 2026-11-17. Apache-2.0; see LICENSE and NOTICE.
param([string]$LayoutName='pixel-hq-files-transfer-windows')
$ErrorActionPreference='Stop'
if($LayoutName -notmatch '^[a-zA-Z0-9_-]+$'){throw 'Invalid layout name'}
$appHome=if($env:HERDR_APP_HOME){$env:HERDR_APP_HOME}else{Join-Path $env:USERPROFILE '.config\herdr-app'}
$exe=Join-Path $env:LOCALAPPDATA 'Programs\herdr-app\herdr-app.exe'
if(!(Test-Path -LiteralPath $exe)){$exe=(Get-Command herdr-app -ErrorAction Stop).Source}
$target=Join-Path $appHome 'mods\files-transfer-windows'
$layoutPath=Join-Path $appHome ('layouts\'+$LayoutName+'.json')
if((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $layoutPath)){throw 'Installation already exists. No files were overwritten; update it explicitly.'}
$status=(& $exe status | Out-String | ConvertFrom-Json)
if(!$status.layout){throw 'Start Herdr before installing'}
$source=Join-Path $PSScriptRoot 'mods\files-transfer-windows'
$check=(& $exe check $source 2>&1 | Out-String)
if($LASTEXITCODE -ne 0){throw $check}
Write-Output $check
Copy-Item -LiteralPath $source -Destination $target -Recurse
$clone=(& $exe do layout.clone --name $status.layout --as $LayoutName 2>&1 | Out-String)
if($LASTEXITCODE -ne 0){throw $clone}
$layout=Get-Content -LiteralPath $layoutPath -Raw -Encoding UTF8 | ConvertFrom-Json
$script:changed=$false
function ConnectFiles($node){
  if($node.id -eq 'files' -and $node.content.mod -eq 'files'){$node.content.mod='files-transfer-windows';$script:changed=$true}
  foreach($child in $node.children){ConnectFiles $child}
}
ConnectFiles $layout
if(!$script:changed){throw 'No standard Files block found. The clone is available for manual connection.'}
$json=$layout | ConvertTo-Json -Depth 60
[IO.File]::WriteAllText($layoutPath,$json,[Text.UTF8Encoding]::new($false))
& $exe do layout.switch --name $LayoutName | Out-String | Write-Output
Write-Output "Installed. Original layout: $($status.layout); selected: $LayoutName"
