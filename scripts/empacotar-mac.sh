#!/usr/bin/env bash
# Gera os .zip de macOS a partir do Linux.
#
# POR QUE ESTE SCRIPT EXISTE
#
# O electron-builder monta o Torrange.app certinho fora do macOS, mas os dois
# ultimos passos ele nao consegue fazer sozinho aqui:
#
#   1. O zip dele DESREFERENCIA os links simbolicos. Um .framework do macOS e
#      feito de symlinks ("Electron Framework" -> "Versions/Current/..."), e sem
#      eles o pacote deixa de ser um framework valido -- alem de guardar o
#      binario de 200 MB tres vezes (353 MB contra 122 MB).
#
#   2. Ele nao assina fora do macOS ("skipped macOS application code signing").
#      Um binario arm64 SEM NENHUMA assinatura e morto pelo kernel na hora de
#      abrir: no Apple Silicon, nem ad-hoc e opcional.
#
# Entao aqui: assinamos ad-hoc com o rcodesign (que roda no Linux) e zipamos
# com "zip -y", que guarda symlink como symlink.
#
# O .dmg continua sendo so no macOS -- ele depende do hdiutil.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$RAIZ/dist"
CACHE="$RAIZ/.cache"
VERSAO="$(grep -oP '"version":\s*"\K[^"]+' "$RAIZ/package.json")"

RCODESIGN_VERSAO="0.29.0"
RCODESIGN_URL="https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/${RCODESIGN_VERSAO}/apple-codesign-${RCODESIGN_VERSAO}-x86_64-unknown-linux-musl.tar.gz"
RCODESIGN_SHA="dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002"

# ------------------------------------------------------------ 1. empacotar
if [ "${PULAR_BUILD:-}" != "1" ]; then
    echo ">> Montando o Torrange.app (x64 e arm64) no Docker..."
    docker build -q -t torrange-builder "$RAIZ/docker" >/dev/null
    docker run --rm \
        -v "$RAIZ":/project \
        -v torrange-npm:/root/.npm \
        -v torrange-electron:/root/.cache/electron \
        -v torrange-electron-builder:/root/.cache/electron-builder \
        -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
        -e CSC_IDENTITY_AUTO_DISCOVERY=false \
        torrange-builder bash -c '
            set -e
            cd /project
            npx electron-builder --mac zip --x64 --arm64 --publish never
            chown -R $HOST_UID:$HOST_GID dist node_modules resources/bin .cache 2>/dev/null || true
        '
fi

[ -d "$DIST/mac" ] || { echo "!! $DIST/mac nao existe -- rode sem PULAR_BUILD=1"; exit 1; }

# ------------------------------------------------------- 2. pegar o rcodesign
mkdir -p "$CACHE"
RCODESIGN="$CACHE/apple-codesign-$RCODESIGN_VERSAO/rcodesign"
if [ ! -x "$RCODESIGN" ]; then
    echo ">> Baixando o rcodesign $RCODESIGN_VERSAO..."
    curl -fL --retry 3 -o "$CACHE/rcodesign.tar.gz" "$RCODESIGN_URL"
    obtido="$(sha256sum "$CACHE/rcodesign.tar.gz" | cut -d' ' -f1)"
    if [ "$obtido" != "$RCODESIGN_SHA" ]; then
        echo "!! sha256 do rcodesign nao confere"
        echo "   esperado: $RCODESIGN_SHA"
        echo "   obtido:   $obtido"
        rm -f "$CACHE/rcodesign.tar.gz"
        exit 1
    fi
    rm -rf "$CACHE/apple-codesign-$RCODESIGN_VERSAO"
    mkdir -p "$CACHE/apple-codesign-$RCODESIGN_VERSAO"
    tar xzf "$CACHE/rcodesign.tar.gz" -C "$CACHE/apple-codesign-$RCODESIGN_VERSAO" --strip-components=1
    chmod +x "$RCODESIGN"
fi

# ------------------------------------------- 3. assinar ad-hoc e zipar direito
empacotar() { # empacotar <pasta-do-app> <nome-do-zip>
    local pasta="$1" zip="$2"
    [ -d "$DIST/$pasta/Torrange.app" ] || { echo "   (sem $pasta, pulando)"; return 0; }

    echo ">> $zip"
    echo "   assinando ad-hoc..."
    "$RCODESIGN" sign "$DIST/$pasta/Torrange.app" >/dev/null

    echo "   zipando com os symlinks preservados..."
    rm -f "$DIST/$zip" "$DIST/$zip.blockmap"
    ( cd "$DIST/$pasta" && zip -q -y -r -9 "../$zip" Torrange.app )

    local links tamanho
    links="$(zipinfo "$DIST/$zip" | awk '{print substr($1,1,1)}' | grep -c '^l' || true)"
    tamanho="$(du -h "$DIST/$zip" | cut -f1)"
    echo "   $tamanho, $links links simbolicos preservados"
    [ "$links" -gt 0 ] || { echo "!! nenhum symlink no zip -- o .app nao vai abrir"; exit 1; }
}

empacotar mac       "Torrange-$VERSAO-mac.zip"
empacotar mac-arm64 "Torrange-$VERSAO-arm64-mac.zip"

echo
echo ">> Pronto:"
ls -lh "$DIST"/*mac*.zip 2>/dev/null || true
echo
echo "   Os pacotes sao assinados ad-hoc, nao notarizados: na primeira abertura"
echo "   o macOS avisa. Clique com o botao direito no app -> Abrir -> Abrir."
echo "   E lembre: no macOS o qbittorrent-nox e o mpv vem do sistema."
