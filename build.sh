#!/usr/bin/env bash
# Build completo dentro do Docker: gera .exe (Windows) e AppImage/.deb (Linux).
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGEM="torrange-builder"

echo ">> Construindo a imagem de build ($IMAGEM)..."
docker build -t "$IMAGEM" "$RAIZ/docker"

echo ">> Rodando o build..."
docker run --rm \
    -v "$RAIZ":/project \
    -v torrange-npm:/root/.npm \
    -v torrange-electron:/root/.cache/electron \
    -v torrange-electron-builder:/root/.cache/electron-builder \
    -e HOST_UID="$(id -u)" \
    -e HOST_GID="$(id -g)" \
    -e ALVOS="${ALVOS:---linux --win}" \
    "$IMAGEM" \
    bash /project/scripts/build-no-docker.sh

echo
echo ">> Artefatos gerados em dist/:"
ls -lh "$RAIZ/dist" 2>/dev/null | grep -vE '^total|builder-|\.blockmap|latest' || true
