#!/usr/bin/env bash
# Warpmail fork: build the Windows NSIS installer from WSL using Windows' own Node.
# Syncs this repo to a Windows-native folder, then installs, builds and packages there.
# Usage: scripts/build-windows.sh [--sync-only]
set -euo pipefail
cd "$(dirname "$0")/.."

# Keep Electron from starting as plain Node (VS Code exports this and WSLENV forwards it).
unset ELECTRON_RUN_AS_NODE

WIN_PROFILE="$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')"
WIN_DIR="${WIN_PROFILE}\\warpmail-build"
WSL_DIR="$(wslpath -u "$WIN_DIR")"

echo "Syncing to $WIN_DIR"
mkdir -p "$WSL_DIR"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude out --exclude release \
  --exclude dist --exclude .turbo --exclude .pnpm-store \
  ./ "$WSL_DIR/"

[[ "${1:-}" == --sync-only ]] && exit 0

# Run from a Windows directory so cmd/powershell don't complain about a UNC cwd.
cd "$WSL_DIR"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
  \$ErrorActionPreference = 'Stop'
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  \$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  \$env:CI = 'true'
  \$env:PSExecutionPolicyPreference = 'Bypass'
  # electron-builder calls 'pnpm' by name, so put user-local corepack shims on PATH for this session only.
  \$shims = Join-Path \$env:LOCALAPPDATA 'warpmail-build-tools'
  New-Item -ItemType Directory -Force \$shims | Out-Null
  corepack enable --install-directory \$shims pnpm
  \$env:PATH = \$shims + ';' + \$env:PATH
  Set-Location '$WIN_DIR'
  function Run { & \$args[0] \$args[1..(\$args.Length - 1)]; if (\$LASTEXITCODE) { throw \"failed (\$LASTEXITCODE): \$args\" } }
  Run corepack pnpm install --frozen-lockfile
  Run corepack pnpm --filter @inlark/desktop build
  Set-Location apps\\desktop
  if (Test-Path release) { Remove-Item -Recurse -Force release }
  Run corepack pnpm exec electron-builder --win nsis --x64 --publish never '-c.win.forceCodeSigning=false'
  Get-ChildItem release\\*.exe | Format-Table FullName, Length
"
