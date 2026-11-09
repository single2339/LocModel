[Console]::OutputEncoding = [Text.Encoding]::UTF8
$vc = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)
$present = @($vc | ForEach-Object { ([string]$_.Name).Trim().ToLower() })
$adapters = @()
$seen = @()
Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
  $desc = if ($p) { ([string]$p.DriverDesc).Trim() } else { '' }
  if ($desc -and ($present.Count -eq 0 -or $present -contains $desc.ToLower())) {
    $seen += $desc.ToLower()
    $mem = $p.'HardwareInformation.qwMemorySize'
    if (-not $mem) {
      $m = $p.'HardwareInformation.MemorySize'
      if ($m -is [byte[]]) { $mem = [BitConverter]::ToUInt32($m, 0) } else { $mem = $m }
    }
    if (-not $mem) { $mem = 0 }
    $adapters += [pscustomobject]@{ name = $desc; vram = [uint64]$mem; driver = [string]$p.DriverVersion; matchingId = [string]$p.MatchingDeviceId }
  }
}
foreach ($v in $vc) {
  $n = ([string]$v.Name).Trim()
  if ($n -and -not ($seen -contains $n.ToLower())) {
    $adapters += [pscustomobject]@{ name = $n; vram = [uint64]([uint32]$v.AdapterRAM); driver = [string]$v.DriverVersion; matchingId = [string]$v.PNPDeviceID }
  }
}
$ram = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue)
$speed = ($ram | Measure-Object -Property ConfiguredClockSpeed -Maximum).Maximum
if (-not $speed) { $speed = ($ram | Measure-Object -Property Speed -Maximum).Maximum }
$type = ($ram | Select-Object -First 1).SMBIOSMemoryType
[pscustomobject]@{ adapters = @($adapters); memSpeed = [int]$speed; memCount = $ram.Count; memType = [int]$type } | ConvertTo-Json -Depth 4 -Compress
