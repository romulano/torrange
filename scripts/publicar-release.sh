#!/usr/bin/env bash
# Publica os instaladores do Torrange como assets de uma GitHub Release.
# Uso: bash scripts/publicar-release.sh [versao]   (padrão: versão do package.json)
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$RAIZ/dist"
GH="$(command -v gh || echo "$HOME/.local/bin/gh")"

[ -x "$GH" ] || { echo "gh não encontrado. Instale em https://cli.github.com"; exit 1; }

VERSAO="${1:-$(grep -oP '"version":\s*"\K[^"]+' "$RAIZ/package.json")}"
TAG="v$VERSAO"

# 1. Autenticação (abre o navegador na primeira vez)
"$GH" auth status >/dev/null 2>&1 || "$GH" auth login --hostname github.com --git-protocol https --web

# 2. Envia o código para o GitHub
# (o repositório agora é a raiz do projeto, não a pasta dist/)
cd "$RAIZ"
git push --set-upstream origin main

# 3. Reúne os instaladores existentes
ARQUIVOS=()
for f in "Torrange-Setup-$VERSAO.exe" "Torrange-$VERSAO-win.zip" \
         "torrange_${VERSAO}_amd64.deb" "Torrange-$VERSAO.AppImage"; do
  [ -f "$DIST/$f" ] && ARQUIVOS+=("$DIST/$f")
done
[ ${#ARQUIVOS[@]} -gt 0 ] || { echo "Nenhum instalador da versão $VERSAO encontrado em $DIST"; exit 1; }

printf 'Enviando para a release %s:\n' "$TAG"
printf '  - %s\n' "${ARQUIVOS[@]##*/}"

# 4. Cria a release (ou anexa os arquivos, se ela já existir)
if "$GH" release view "$TAG" >/dev/null 2>&1; then
  "$GH" release upload "$TAG" "${ARQUIVOS[@]}" --clobber
else
  "$GH" release create "$TAG" "${ARQUIVOS[@]}" \
    --title "Torrange $VERSAO" \
    --notes "Instaladores do Torrange $VERSAO. Autocontidos: trazem o Electron, o
qBittorrent e o mpv dentro. Não é preciso instalar Node, npm nem o qBittorrent à parte.

| Sistema | Arquivo |
| --- | --- |
| Windows (instalador) | \`Torrange-Setup-$VERSAO.exe\` |
| Windows (portátil) | \`Torrange-$VERSAO-win.zip\` |
| Linux (Debian/Ubuntu) | \`torrange_${VERSAO}_amd64.deb\` |
| Linux (universal) | \`Torrange-$VERSAO.AppImage\` |

### ⚠️ No Windows, faça isto antes de assistir

Abra **Ajustes** → marque **\"Abrir o vídeo em janela separada\"** → **Salvar**.

Sem isso a área do vídeo fica **preta**: o áudio toca, o tempo corre e as faixas
aparecem, mas não há imagem. Marcada a opção, o mpv abre numa janela própria e
continua sendo controlado pelos botões do app.

No Linux não é necessário."
fi

echo
echo "Pronto: https://github.com/romulano/torrange/releases/tag/$TAG"
