#!/usr/bin/env bash
# Build do Torrange para macOS.
#
# PRECISA RODAR NUM MAC. O .dmg e montado com o hdiutil, que so existe no
# macOS -- nao da para gerar de dentro do Docker como as outras plataformas.
#
# Os binarios de terceiros no macOS vem do sistema (nao ha build pronto de
# qbittorrent-nox para Mac, e o mpv que circula esta parado ha anos). Quem
# tiver os seus e so coloca-los em resources/bin/mac/ que entram no pacote:
#
#     resources/bin/mac/qbittorrent/qbittorrent-nox
#     resources/bin/mac/mpv/mpv.app/Contents/MacOS/mpv
#
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"

if [ "$(uname -s)" != "Darwin" ]; then
    echo "!! Este script precisa rodar num Mac."
    echo "   O .dmg depende do hdiutil, que so existe no macOS; um build"
    echo "   cruzado a partir do Linux nao gera instalador valido."
    echo
    echo "   Para Windows e Linux use: ./build.sh"
    exit 1
fi

echo ">> Dependencias do projeto..."
npm install

mkdir -p resources/bin/mac

echo ">> Binarios de terceiros para macOS"
achar() { command -v "$1" 2>/dev/null || true; }

QBIT_EMPACOTADO="resources/bin/mac/qbittorrent/qbittorrent-nox"
MPV_EMPACOTADO="resources/bin/mac/mpv/mpv.app/Contents/MacOS/mpv"

if [ -x "$QBIT_EMPACOTADO" ]; then
    echo "   qbittorrent-nox: empacotado ($QBIT_EMPACOTADO)"
else
    QBIT_SISTEMA="$(achar qbittorrent-nox)"
    if [ -n "$QBIT_SISTEMA" ]; then
        echo "   qbittorrent-nox: nao empacotado; o app usara o do sistema ($QBIT_SISTEMA)"
    else
        echo "   AVISO: qbittorrent-nox nao encontrado."
        echo "          O app abre, mas nao baixa ate haver um. Instale com"
        echo "          'sudo port install qbittorrent-nox' ou"
        echo "          'nix profile install nixpkgs#qbittorrent-nox',"
        echo "          ou coloque o binario em $QBIT_EMPACOTADO."
    fi
fi

if [ -x "$MPV_EMPACOTADO" ]; then
    echo "   mpv: empacotado ($MPV_EMPACOTADO)"
else
    MPV_SISTEMA="$(achar mpv)"
    if [ -n "$MPV_SISTEMA" ]; then
        echo "   mpv: nao empacotado; o app usara o do sistema ($MPV_SISTEMA)"
    else
        echo "   AVISO: mpv nao encontrado. Instale com 'brew install mpv'."
    fi
fi

echo ">> Gerando os pacotes..."
npx electron-builder --mac --publish never

echo
echo ">> Artefatos gerados em dist/:"
ls -lh dist/*.dmg dist/*mac*.zip 2>/dev/null || true
echo
echo "   O pacote nao e assinado nem notarizado: na primeira abertura o macOS"
echo "   avisa. Clique com o botao direito no app -> Abrir -> Abrir."
