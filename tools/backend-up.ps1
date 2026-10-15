# KsuNiMeet - bring the backend up and re-point the public site at it.
#
# ASCII ONLY, deliberately. Windows PowerShell reads a .ps1 as ANSI unless the
# file carries a UTF-8 BOM, and the em dash in UTF-8 is the three bytes E2 80 94
# - whose last byte is 0x94, which ANSI reads as a closing curly double quote.
# One em dash inside a double-quoted string silently ends the string and the
# whole script fails to parse. Keep this file to plain 7-bit characters.
#
# WHY THIS EXISTS. PocketBase runs as a process on this PC and is publicised
# through a cloudflared quick tunnel. A quick tunnel gets a NEW random hostname
# every time it starts, and the GitHub Pages build bakes the backend address
# into config.js. So a reboot does not just stop the backend - it leaves the
# public site calling an address that no longer exists. This script closes that
# loop: start, read the new address, write it into the repository variable, and
# rebuild the site.
#
# Run it after a reboot, or whenever the site cannot reach the backend:
#     powershell -ExecutionPolicy Bypass -File backend-up.ps1
#
# WHAT THIS IS. The data lives on this PC, in pb_data. A home PC is not a
# server and the tunnel address is not stable; this is a working stopgap. The
# VPS installer in vps/ is the intended resting place once there is a server we
# can actually log into.

param(
  [string]$Root = "C:\Users\Admin\ksunimeet-backend",
  [string]$Cloudflared = "C:\Users\Admin\cloudflared\cloudflared.exe",
  [string]$Repo = "barnisan43329-commits/ksunimeet-web",
  [switch]$NoRebuild
)

$ErrorActionPreference = "Stop"

function Say($m) { Write-Host "  $m" }

# ------------------------------------------------------------------ PocketBase
Write-Host ""
Write-Host "=== PocketBase ==="
$pb = Get-Process pocketbase -ErrorAction SilentlyContinue
if ($pb) {
  Say "already running (pid $($pb.Id))"
} else {
  Say "starting..."
  Start-Process -FilePath (Join-Path $Root "pocketbase.exe") `
    -ArgumentList "serve", "--http=127.0.0.1:8090" `
    -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Root "pb.out.log") `
    -RedirectStandardError  (Join-Path $Root "pb.err.log")
  Start-Sleep -Seconds 4
}

$healthy = $false
foreach ($i in 1..15) {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:8090/api/health" -TimeoutSec 4
    if ($r.code -eq 200) { $healthy = $true; break }
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $healthy) {
  throw "PocketBase is not answering on 127.0.0.1:8090. Check $Root\pb.err.log"
}
Say "healthy on 127.0.0.1:8090"

# ------------------------------------------------------------------ the tunnel
Write-Host ""
Write-Host "=== public tunnel ==="
$log = Join-Path $Root "tunnel.log"
$urlFile = Join-Path $Root "PUBLIC-URL.txt"

if (Get-Process cloudflared -ErrorAction SilentlyContinue) {
  Say "already running - reusing its address"
} else {
  Say "starting cloudflared..."
  Remove-Item $log -ErrorAction SilentlyContinue
  Start-Process -FilePath $Cloudflared `
    -ArgumentList "tunnel", "--url", "http://127.0.0.1:8090", "--no-autoupdate" `
    -RedirectStandardError $log `
    -RedirectStandardOutput (Join-Path $Root "tunnel.out.log") -WindowStyle Hidden
}

# The address is read from the log. If the log is missing but the process is
# alive, it was started by an earlier run, so the last recorded address still
# stands.
$url = $null
foreach ($i in 1..30) {
  if ((Test-Path $log) -and (Test-Path $urlFile)) {
    $seen = Select-String -Path $log -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -AllMatches
    if ($seen) { $url = $seen.Matches[0].Value; break }
  }
  if ((-not (Test-Path $log)) -and (Test-Path $urlFile)) {
    $url = (Get-Content $urlFile -Raw).Trim(); break
  }
  Start-Sleep -Seconds 2
}
if (-not $url) { throw "could not read a tunnel address. Check $log" }
Set-Content -Path $urlFile -Value $url -NoNewline
Say "public address: $url"

# Prove it before publishing it. A tunnel that is up but not forwarding would
# otherwise be baked into the site and look exactly like the backend being down.
try {
  $h = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 20
  if ($h.code -ne 200) { throw "health returned $($h.code)" }
  Say "reachable from the public internet"
} catch {
  throw "the tunnel address did not answer /api/health: $($_.Exception.Message)"
}

if ($NoRebuild) { Write-Host ""; Write-Host "(NoRebuild set - not touching GitHub)"; Write-Host ""; exit 0 }

# ------------------------------------------------------- publish it to GitHub
Write-Host ""
Write-Host "=== GitHub ==="
$cred = ("protocol=https`nhost=github.com`n`n" | git credential fill) | ConvertFrom-StringData
$token = $cred.password
if (-not $token) { throw "no GitHub credential available to git" }

$headers = @{
  Authorization = "token $token"
  Accept        = "application/vnd.github+json"
  "User-Agent"  = "ksunimeet-backend-up"
}
$api = "https://api.github.com/repos/$Repo"

# Ask what already exists instead of guessing. Creating a variable that is
# already there returns 409, and with $ErrorActionPreference = "Stop" that is a
# TERMINATING error which -ErrorAction SilentlyContinue does not suppress. That
# killed this script at the create call and left POCKETBASE_URL pointing at the
# previous tunnel, so the site called an address that no longer existed - the
# exact failure this script is meant to prevent.
$existing = (Invoke-RestMethod -Uri "$api/actions/variables?per_page=100" -Headers $headers).variables

function Set-RepoVariable($name, $value) {
  $payload = @{ name = $name; value = $value } | ConvertTo-Json
  if ($existing | Where-Object { $_.name -eq $name }) {
    Invoke-RestMethod -Method Patch -Uri "$api/actions/variables/$name" -Headers $headers `
      -Body $payload -ContentType "application/json" | Out-Null
    Say "$name updated"
  } else {
    Invoke-RestMethod -Method Post -Uri "$api/actions/variables" -Headers $headers `
      -Body $payload -ContentType "application/json" | Out-Null
    Say "$name created"
  }
}

Set-RepoVariable "KSU_BACKEND" "pocketbase"
Set-RepoVariable "POCKETBASE_URL" $url

# Read it back. A write that only appears to succeed is how the site ends up
# quietly calling a dead address, so success is never assumed here.
$after = (Invoke-RestMethod -Uri "$api/actions/variables?per_page=100" -Headers $headers).variables
$readback = ($after | Where-Object { $_.name -eq "POCKETBASE_URL" }).value
if ($readback -ne $url) {
  throw "POCKETBASE_URL did not take: wrote $url but reads back $readback"
}
Say "verified POCKETBASE_URL"

# This workflow was once left disabled, and a disabled workflow accepts no
# dispatch at all - the rebuild would then never happen and nothing would say so.
$wf = (Invoke-RestMethod -Uri "$api/actions/workflows" -Headers $headers).workflows |
      Where-Object { $_.path -like "*pages.yml" }
if (-not $wf) { throw "no pages.yml workflow found in $Repo" }
Invoke-RestMethod -Method Put -Uri "$api/actions/workflows/$($wf.id)/enable" -Headers $headers | Out-Null
Invoke-RestMethod -Method Post -Uri "$api/actions/workflows/$($wf.id)/dispatches" -Headers $headers `
  -Body (@{ ref = "main" } | ConvertTo-Json) -ContentType "application/json" | Out-Null
Say "rebuild dispatched"

Write-Host ""
Write-Host "=== waiting for the site rebuild ==="
foreach ($i in 1..40) {
  Start-Sleep -Seconds 6
  $runs = (Invoke-RestMethod -Uri "$api/actions/runs?per_page=5" -Headers $headers).workflow_runs
  $run = $runs | Where-Object { $_.path -like "*pages.yml" } | Select-Object -First 1
  if ($run -and $run.status -eq "completed") {
    Say ("run #{0}: {1}" -f $run.run_number, $run.conclusion)
    if ($run.conclusion -ne "success") { throw "the Pages build failed. See $api/actions" }
    break
  }
}

Write-Host ""
Write-Host "  DONE"
Write-Host "  site    : https://ksunimeet.b4rn1.com/"
Write-Host "  backend : $url"
Write-Host "  admin   : $Root\ADMIN-PASSWORD.txt"
Write-Host ""
