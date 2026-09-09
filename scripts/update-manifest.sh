#!/usr/bin/env bash
# Recalcula os sha256 do manifesto a partir dos arquivos ja baixados em .cache/binarios.
set -euo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
declare -A ARQ=( [qbt_win]=qbt-win.zip [qbt_linux]=qbt-linux [mpv_win]=mpv-win.7z [mpv_linux]=mpv-linux.AppImage )
for chave in "${!ARQ[@]}"; do
    f="$RAIZ/.cache/binarios/${ARQ[$chave]}"
    [ -f "$f" ] || { echo "pulando $chave (nao baixado)"; continue; }
    h="$(sha256sum "$f" | cut -d' ' -f1)"
    sed -i -E "s|^($chave\|[^|]*\|).*$|\1$h|" "$RAIZ/scripts/binaries.manifest"
    echo "$chave -> $h"
done
