#!/usr/bin/env bash
# Baixa e desempacota qbittorrent-nox e mpv para resources/bin/{win,linux}.
# Idempotente: se o binario ja existe, pula.
#
# macOS nao entra aqui de proposito: nao existe build pronto de qbittorrent-nox
# para Mac e o mpv que circula esta parado ha anos, entao la o app usa o que
# estiver instalado no sistema (ver src/main/paths.js). Quem tiver os seus
# binarios coloca em resources/bin/mac/ e eles vao para dentro do pacote.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$RAIZ/.cache/binarios"
BIN="$RAIZ/resources/bin"
MANIFESTO="$RAIZ/scripts/binaries.manifest"

ALVO="${1:-todos}"   # win | linux | mac | todos
quer() { [ "$ALVO" = "todos" ] || [ "$ALVO" = "$1" ]; }

mkdir -p "$CACHE" "$BIN/win" "$BIN/linux" "$BIN/mac"

# O .7z do mpv para Windows precisa de um extrator; no Docker vem o p7zip-full.
extrator_7z() {
    for cmd in 7z 7za 7zr bsdtar; do
        command -v "$cmd" >/dev/null && { echo "$cmd"; return 0; }
    done
    return 1
}

url_de()  { grep -E "^$1\|" "$MANIFESTO" | cut -d'|' -f2; }
hash_de() { grep -E "^$1\|" "$MANIFESTO" | cut -d'|' -f3; }

baixar() { # baixar <chave> <arquivo-destino>
    local chave="$1" destino="$2" url esperado obtido
    url="$(url_de "$chave")"
    esperado="$(hash_de "$chave")"

    if [ ! -f "$destino" ]; then
        echo "   baixando $chave..."
        curl -fL --retry 3 --progress-bar -o "$destino.parcial" "$url"
        mv "$destino.parcial" "$destino"
    fi

    obtido="$(sha256sum "$destino" | cut -d' ' -f1)"
    if [ "$esperado" = "-" ]; then
        echo "   $chave sha256=$obtido (nao fixado no manifesto)"
    elif [ "$obtido" != "$esperado" ]; then
        echo "!! ERRO: sha256 de $chave nao confere."
        echo "   esperado: $esperado"
        echo "   obtido:   $obtido"
        rm -f "$destino"
        exit 1
    else
        echo "   $chave sha256 ok"
    fi
}

precisa() { # precisa <caminho> -> 0 se falta
    [ ! -e "$1" ]
}

# ---------------------------------------------------------------- qBittorrent
if quer win && precisa "$BIN/win/qbittorrent/qbittorrent-nox.exe"; then
    echo ">> qbittorrent-nox (Windows)"
    baixar qbt_win "$CACHE/qbt-win.zip"
    rm -rf "$CACHE/qbt-win" && mkdir -p "$CACHE/qbt-win"
    unzip -q -o "$CACHE/qbt-win.zip" -d "$CACHE/qbt-win"
    exe="$(find "$CACHE/qbt-win" -name 'qbittorrent-nox.exe' -print -quit)"
    [ -n "$exe" ] || { echo "!! qbittorrent-nox.exe nao encontrado no zip"; exit 1; }
    mkdir -p "$BIN/win/qbittorrent"
    cp "$exe" "$BIN/win/qbittorrent/qbittorrent-nox.exe"
    # leva junto qualquer dll que acompanhe o executavel
    find "$(dirname "$exe")" -maxdepth 1 -name '*.dll' -exec cp {} "$BIN/win/qbittorrent/" \; 2>/dev/null || true
elif quer win; then
    echo ">> qbittorrent-nox (Windows) ja presente"
fi

if quer linux && precisa "$BIN/linux/qbittorrent/qbittorrent-nox"; then
    echo ">> qbittorrent-nox (Linux)"
    baixar qbt_linux "$CACHE/qbt-linux"
    mkdir -p "$BIN/linux/qbittorrent"
    cp "$CACHE/qbt-linux" "$BIN/linux/qbittorrent/qbittorrent-nox"
    chmod +x "$BIN/linux/qbittorrent/qbittorrent-nox"
elif quer linux; then
    echo ">> qbittorrent-nox (Linux) ja presente"
fi

# ----------------------------------------------------------------------- mpv
if quer win && precisa "$BIN/win/mpv/mpv.exe"; then
    echo ">> mpv (Windows)"
    baixar mpv_win "$CACHE/mpv-win.7z"
    rm -rf "$CACHE/mpv-win" && mkdir -p "$CACHE/mpv-win"
    if ! ferramenta="$(extrator_7z)"; then
        echo "!! Nenhum extrator de .7z encontrado (instale p7zip-full ou libarchive-tools)."
        echo "   Dica: o build oficial roda no Docker, que ja traz o p7zip. Use ./build.sh."
        exit 1
    fi
    if [ "$ferramenta" = "bsdtar" ]; then
        bsdtar -xf "$CACHE/mpv-win.7z" -C "$CACHE/mpv-win"
    else
        "$ferramenta" x -bso0 -bsp0 -y -o"$CACHE/mpv-win" "$CACHE/mpv-win.7z"
    fi
    exe="$(find "$CACHE/mpv-win" -name 'mpv.exe' -print -quit)"
    [ -n "$exe" ] || { echo "!! mpv.exe nao encontrado no 7z"; exit 1; }
    mkdir -p "$BIN/win/mpv"
    cp -r "$(dirname "$exe")/." "$BIN/win/mpv/"
    # o mpv.com so serve para linha de comando, nao vai no pacote
    rm -f "$BIN/win/mpv/mpv.com"
elif quer win; then
    echo ">> mpv (Windows) ja presente"
fi

if quer linux && precisa "$BIN/linux/mpv/AppRun"; then
    echo ">> mpv (Linux)"
    baixar mpv_linux "$CACHE/mpv-linux.AppImage"
    chmod +x "$CACHE/mpv-linux.AppImage"
    rm -rf "$CACHE/mpv-extract" && mkdir -p "$CACHE/mpv-extract"
    # Extrai o AppImage: o app final nao pode depender de FUSE no sistema do usuario.
    ( cd "$CACHE/mpv-extract" && "$CACHE/mpv-linux.AppImage" --appimage-extract >/dev/null )
    # Runtimes de AppImage variam: uns extraem para squashfs-root, outros para
    # AppDir (deixando squashfs-root como symlink). Resolve o diretorio real.
    extraido=""
    for cand in "$CACHE/mpv-extract/squashfs-root" "$CACHE/mpv-extract/AppDir"; do
        if [ -f "$cand/AppRun" ]; then
            extraido="$(cd "$cand" && pwd -P)"
            break
        fi
    done
    [ -n "$extraido" ] || { echo "!! falha ao extrair o AppImage do mpv"; exit 1; }
    rm -rf "$BIN/linux/mpv"
    mkdir -p "$BIN/linux/mpv"
    cp -a "$extraido/." "$BIN/linux/mpv/"
    chmod +x "$BIN/linux/mpv/AppRun"
    find "$BIN/linux/mpv" -name 'mpv' -type f -exec chmod +x {} \; 2>/dev/null || true
    # A AppImage do mpv traz hooks que baixam o yt-dlp e se auto-atualizam pela
    # rede no primeiro uso. Num app empacotado isso nao faz sentido: fora.
    rm -f "$BIN/linux/mpv/bin/05-get-yt-dlp.hook" \
          "$BIN/linux/mpv/bin/10-self-updater.hook"
elif quer linux; then
    echo ">> mpv (Linux) ja presente"
fi

# ----------------------------------------------------------------- macOS
if quer mac; then
    faltando=""
    [ -x "$BIN/mac/qbittorrent/qbittorrent-nox" ] || faltando="qbittorrent-nox"
    [ -e "$BIN/mac/mpv/mpv.app/Contents/MacOS/mpv" ] || faltando="$faltando mpv"
    if [ -n "$faltando" ]; then
        echo ">> macOS: nao ha binario pronto para baixar ($faltando)."
        echo "   O app procura no sistema (Homebrew, MacPorts, Nix). Para empacotar"
        echo "   os seus, coloque em:"
        echo "     $BIN/mac/qbittorrent/qbittorrent-nox"
        echo "     $BIN/mac/mpv/mpv.app/Contents/MacOS/mpv"
    else
        echo ">> macOS: binarios ja presentes"
    fi
fi

echo ">> Binarios prontos:"
du -sh "$BIN/win" "$BIN/linux" "$BIN/mac" 2>/dev/null || true
