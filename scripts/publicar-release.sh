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
cd "$RAIZ"
git push --set-upstream origin main

# 3. Reúne os instaladores existentes.
#    Os .zip do macOS saem do Linux (npm run dist:mac-zip); o .dmg, só num Mac.
ARQUIVOS=()
for f in "Torrange-Setup-$VERSAO.exe" "Torrange-$VERSAO-win.zip" \
         "torrange_${VERSAO}_amd64.deb" "Torrange-$VERSAO.AppImage" \
         "Torrange-$VERSAO-arm64.dmg" "Torrange-$VERSAO-x64.dmg" \
         "Torrange-$VERSAO-arm64-mac.zip" "Torrange-$VERSAO-mac.zip"; do
  [ -f "$DIST/$f" ] && ARQUIVOS+=("$DIST/$f")
done
[ ${#ARQUIVOS[@]} -gt 0 ] || { echo "Nenhum instalador da versão $VERSAO encontrado em $DIST"; exit 1; }

printf 'Enviando para a release %s:\n' "$TAG"
printf '  - %s\n' "${ARQUIVOS[@]##*/}"

NOTAS="$(cat <<NOTAS_FIM
Instaladores do Torrange $VERSAO.

## O que mudou nesta versão

**A conversa com o site passou a ser por token.** Não existe mais tela de
login: o app se identifica por um token de 100 caracteres, copiado de
[torrange.com/aplicativos](https://torrange.com/aplicativos), e por um
identificador próprio deste aparelho. Quem já tem o token cadastrado entra
direto.

- **Tela do token** e **tela de espera** no lugar da tela de login. O aparelho
  nasce pendente e passa a funcionar sozinho assim que o dono clica em
  **Permitir**, no site.
- **O acervo agora é nativo**: busca, filtros, ficha do título com ficha
  técnica e opções, favoritos e histórico — tudo pela API, sem navegador
  embutido.
- **Download pago pede confirmação** com preço e saldo antes de gastar gema.
  O verbo que cobra nunca é repetido sozinho.
- **O token é guardado cifrado pelo cofre do sistema** e não aparece na
  interface, em log nem no arquivo de diagnóstico — só mascarado.
- **Versão para macOS** (Intel e Apple Silicon).

## Download

| Sistema | Arquivo |
| --- | --- |
| Windows (instalador) | \`Torrange-Setup-$VERSAO.exe\` |
| Windows (portátil) | \`Torrange-$VERSAO-win.zip\` |
| Linux (Debian/Ubuntu) | \`torrange_${VERSAO}_amd64.deb\` |
| Linux (universal) | \`Torrange-$VERSAO.AppImage\` |
| macOS (Apple Silicon) | \`Torrange-$VERSAO-arm64-mac.zip\` |
| macOS (Intel) | \`Torrange-$VERSAO-mac.zip\` |

Os pacotes de Windows e Linux são autocontidos: trazem o Electron, o
qBittorrent e o mpv dentro.

### ⚠️ No Windows, faça isto antes de assistir

Abra **Ajustes** → marque **"Abrir o vídeo em janela separada"** → **Salvar**.
Sem isso a área do vídeo fica preta: o áudio toca e o tempo corre, mas não há
imagem. No Linux não é necessário; no macOS o app já faz isso sozinho.

### No macOS, instale os dois programas de terceiros

Não existe build pronto de \`qbittorrent-nox\` para Mac, então o app usa o que
estiver instalado no sistema:

\`\`\`
brew install mpv
sudo port install qbittorrent-nox     # ou: nix profile install nixpkgs#qbittorrent-nox
\`\`\`

O pacote é assinado ad-hoc, mas não notarizado: descompacte o \`.zip\`, arraste
o \`Torrange.app\` para *Aplicativos* e, na primeira abertura, clique nele com o
botão direito → **Abrir** → **Abrir**.
NOTAS_FIM
)"

# 4. Cria a release (ou anexa os arquivos, se ela já existir)
if "$GH" release view "$TAG" >/dev/null 2>&1; then
  "$GH" release upload "$TAG" "${ARQUIVOS[@]}" --clobber
else
  "$GH" release create "$TAG" "${ARQUIVOS[@]}" --title "Torrange $VERSAO" --notes "$NOTAS"
fi

echo
echo "Pronto: https://github.com/romulano/torrange/releases/tag/$TAG"
