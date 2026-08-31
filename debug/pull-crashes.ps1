# List + pull recent crash reports (epoch-prefixed names).
$ErrorActionPreference = 'Continue'
$dest = 'C:\Users\sergi\GitHub\fx-embedded\debug\mtp\crash_reports'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$shell = New-Object -ComObject Shell.Application
$root = $shell.NameSpace(0x11)
$dev = $null
foreach ($item in $root.Items()) { if ($item.Name -like '*Switch*') { $dev = $item; break } }
$sd = $null
foreach ($sub in $dev.GetFolder.Items()) { if ($sub.Name -like '*SD Card') { $sd = $sub.GetFolder; break } }
function SubF($p,$n) { foreach ($i in $p.Items()) { if ($i.IsFolder -and $i.Name -eq $n) { return $i.GetFolder } } }
function FileI($p,$n) { foreach ($i in $p.Items()) { if (-not $i.IsFolder -and $i.Name -eq $n) { return $i } } }
$atm = SubF $sd 'atmosphere'
$cr = SubF $atm 'crash_reports'
if (-not $cr) { Write-Output 'NO crash_reports'; exit 1 }
foreach ($i in $cr.Items()) {
  if ($i.IsFolder) { continue }
  Write-Output ("LIST: " + $i.Name + "  " + $i.Size + "B")
  if ($i.Name -match '^0178787' -or $i.Name -match '^0178788' -or $i.Name -match '^0178789') {
    $local = Join-Path $dest $i.Name
    Remove-Item -ErrorAction SilentlyContinue $local
    $shell.NameSpace($dest).CopyHere($i)
    $t=0; while (-not (Test-Path $local) -and $t -lt 120) { Start-Sleep -Milliseconds 500; $t++ }
    if (Test-Path $local) { Write-Output ("  pulled: " + (Get-Item $local).Length + "B") } else { Write-Output '  COPY FAILED' }
  }
}
Write-Output 'DONE'
