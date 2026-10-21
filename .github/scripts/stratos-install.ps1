# Locate the Stratos installation that the NSIS installer just created.
# Dot-source this file in a workflow step, then call Get-StratosInstall.

function Get-StratosInstall {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
      $props = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
      # electron-builder's uninstallDisplayName defaults to "<productName> <version>",
      # so an installed Stratos is listed as "Stratos 2.1.14" and an exact match on
      # "Stratos" never finds it. DisplayVersion is still the plain version.
      if ($props.DisplayName -eq 'Stratos' -or $props.DisplayName -like 'Stratos ?*') { return $props }
    }
  }
  return $null
}

function Get-StratosExe {
  param([Parameter(Mandatory = $true)] $App)
  $candidates = @()
  if ($App.InstallLocation) { $candidates += (Join-Path $App.InstallLocation 'Stratos.exe') }
  if ($App.UninstallString) {
    $uninstaller = ($App.UninstallString -replace '"', '').Trim()
    $candidates += (Join-Path (Split-Path -Parent $uninstaller) 'Stratos.exe')
  }
  $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\stratos\Stratos.exe')
  $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Stratos\Stratos.exe')
  # The name comes from the app id used by electron-builder, so accept both.
  $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\stratos-desktop\Stratos.exe')
  $candidates += (Join-Path $env:ProgramFiles 'Stratos\Stratos.exe')
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  throw "Could not find the installed Stratos.exe (tried: $($candidates -join ', '))"
}
