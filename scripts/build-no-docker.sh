#!/usr/bin/env bash
# Executado DENTRO do container pelo build.sh.
set -euo pipefail
cd /project

# O container roda como root; devolve a posse ao usuario do host ao terminar,
# inclusive se o build falhar no meio (senao dist/ fica inacessivel no host).
corrigir_dono() {
    if [ -n "${HOST_UID:-}" ] && [ -n "${HOST_GID:-}" ]; then
        chown -R "$HOST_UID:$HOST_GID" dist node_modules resources/bin .cache 2>/dev/null || true
    fi
}
trap corrigir_dono EXIT

echo "== 1/3 Baixando binarios de terceiros (qbittorrent-nox e mpv) =="
bash scripts/fetch-binaries.sh

echo "== 2/3 Instalando dependencias do Node =="
if [ -f package-lock.json ]; then npm ci; else npm install; fi

echo "== 3/3 Empacotando com electron-builder =="
# shellcheck disable=SC2086
npx electron-builder ${ALVOS:---linux --win} --publish never

echo "== Build concluido =="
