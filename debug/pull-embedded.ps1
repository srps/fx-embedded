# Pull fx-embedded evidence over MTP (DBI -> USB File Transfer).
# Usage: powershell -File pull-embedded.ps1
# Note: MTP metadata lies about sizes/dates and listings can be stale —
# re-list or restart DBI for a clean view (see fx-switch JOURNAL).
$ErrorActionPreference = 'Continue'
$dest = 'C:\Users\sergi\GitHub\fx-embedded\debug\mtp'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$crashDest = Join-Path $dest 'crash_reports'
New-Item -ItemType Directory -Force -Path $crashDest | Out-Null

$shell = New-Object -ComObject Shell.Application
$root = $shell.NameSpace(0x11)
$dev = $null
foreach ($item in $root.Items()) { if ($item.Name -like '*Switch*') { $dev = $item; break } }
if (-not $dev) { Write-Output 'NO DEVICE'; exit 1 }
$sd = $null
foreach ($sub in $dev.GetFolder.Items()) { if ($sub.Name -like '*SD Card') { $sd = $sub.GetFolder; break } }
if (-not $sd) { Write-Output 'NO SD'; exit 1 }

function SubF($p,$n) { foreach ($i in $p.Items()) { if ($i.IsFolder -and $i.Name -eq $n) { return $i.GetFolder } } }
function FileI($p,$n) { foreach ($i in $p.Items()) { if (-not $i.IsFolder -and $i.Name -eq $n) { return $i } } }

function Pull($parent,$name,$dir) {
  $f = FileI $parent $name
  if (-not $f) { Write-Output "MISSING: $name"; return }
  Write-Output "FOUND: $name  size=$($f.Size)B  modified=$($f.ModifyDate)"
  $local = Join-Path $dir $name
  Remove-Item -ErrorAction SilentlyContinue $local
  $shell.NameSpace($dir).CopyHere($f)
  $t=0; while (-not (Test-Path $local) -and $t -lt 120) { Start-Sleep -Milliseconds 500; $t++ }
  if (Test-Path $local) { Write-Output "  local copy: $((Get-Item $local).Length)B" } else { Write-Output '  COPY FAILED' }
}

$switchDir = SubF $sd 'switch'
$embDir = SubF $switchDir 'fx-embedded'
$nxjs = SubF $sd 'nx.js'

# 1) the app log — TLS canary + [net] breadcrumbs
Pull $switchDir 'fx-embedded.log' $dest
# 2) app dir artifacts (config presence only — do NOT print its contents: API key)
Pull $embDir 'config.json' $dest
# 3) all per-boot runtime stderr logs (beta.10+ names: nxjs-debug-<ver>-<epoch>.log)
if ($nxjs) {
  foreach ($i in $nxjs.Items()) {
    if (-not $i.IsFolder -and $i.Name -like 'nxjs-debug-*.log') { Pull $nxjs $i.Name $dest }
  }
}
# 4) crash reports — pull everything from the last two days (epoch prefixes)
$crash = SubF $sd 'atmosphere'
if ($crash) { $crash = SubF $crash 'crash_reports' }
if ($crash) {
  foreach ($i in $crash.Items()) {
    if (-not $i.IsFolder -and $i.Name -match '^0178(79|8\d{5})') { Pull $crash $i.Name $crashDest }
  }
}
Write-Output 'DONE'
