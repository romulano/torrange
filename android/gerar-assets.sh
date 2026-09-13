#!/usr/bin/env bash
#
# Leva a interface do desktop (src/renderer) para dentro do APK.
#
# A interface e UMA so para as quatro plataformas: nada e reescrito aqui. O que
# este script faz sao tres emendas, e cada uma esta comentada onde acontece --
# se um dia precisar de uma quarta, e sinal de que a diferenca deveria estar em
# android.js ou movel.css, e nao numa emenda de build.
#
set -euo pipefail

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
origem="$raiz/src/renderer"
extras="$raiz/android/assets-extras"
destino="$raiz/android/app/src/main/assets/app"

echo "interface: $origem  ->  $destino"

rm -rf "$destino"
mkdir -p "$destino"
cp "$origem"/index.html "$origem"/app.js "$origem"/styles.css "$destino"/
cp "$extras"/android-preload.js "$extras"/android.js "$extras"/movel.css "$destino"/

# ---------------------------------------------------------------- emenda 1
#
# As capas do acervo.
#
# No desktop o Electron registrava o esquema proprio `acervo://capa/<item>`, e
# o processo principal respondia com o token na mao. Aqui a pagina inteira e
# servida de uma origem so (ver MainActivity.servir), e um caminho relativo
# dentro dela faz o mesmo papel -- sem esquema para registrar e sem afrouxar a
# CSP. O token continua sem aparecer na interface: quem busca a imagem e o
# Kotlin.
sed -i 's|`acervo://capa/|`acervo/capa/|g' "$destino/app.js"

# A conferencia olha o codigo, nao o comentario logo acima dele (que segue
# descrevendo o esquema do desktop, e esta certo assim).
if grep -q '`acervo://' "$destino/app.js"; then
    echo "ERRO: sobrou um endereço acervo:// no código de app.js -- a emenda 1 não pegou." >&2
    exit 1
fi

# ---------------------------------------------------------------- emenda 2
#
# A folha do toque entra depois da do desktop (e so acrescenta).
sed -i 's|<link rel="stylesheet" href="styles.css">|<link rel="stylesheet" href="styles.css">\n    <link rel="stylesheet" href="movel.css">|' "$destino/index.html"

# ---------------------------------------------------------------- emenda 3
#
# A ponte tem de existir ANTES de app.js, que le `window.torrange` na primeira
# linha; os ajustes de Android, depois, quando a tela ja esta montada.
sed -i 's|<script src="app.js"></script>|<script src="android-preload.js"></script>\n<script src="app.js"></script>\n<script src="android.js"></script>|' "$destino/index.html"

for marca in movel.css android-preload.js android.js; do
    grep -q "$marca" "$destino/index.html" || {
        echo "ERRO: $marca não entrou no index.html." >&2
        exit 1
    }
done

echo "pronto: $(ls -1 "$destino" | tr '\n' ' ')"
