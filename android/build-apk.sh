#!/usr/bin/env bash
#
# Gera o APK do Torrange. Só precisa de Docker, como o build.sh das outras
# plataformas -- nada de instalar JDK, SDK do Android ou Gradle na máquina.
#
#   ./android/build-apk.sh            # release assinado, sai em dist/
#   ./android/build-apk.sh debug      # build de depuração
#
set -euo pipefail

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
alvo="${1:-release}"
imagem="torrange-android"
chave="$raiz/android/chave/torrange.jks"
cache="$raiz/.cache/gradle"

cd "$raiz"

# ---------------------------------------------------------------- a imagem
if ! docker image inspect "$imagem" >/dev/null 2>&1; then
    echo "== montando a imagem de build (JDK 17 + SDK do Android + Gradle)"
    docker build -f docker/Dockerfile.android -t "$imagem" .
fi

# ------------------------------------------------------------- a interface
echo "== levando a interface do desktop para os assets"
bash android/gerar-assets.sh

# ----------------------------------------------------------------- a chave
#
# O Android recusa instalar um APK sem assinatura. Esta chave é do projeto, fica
# FORA do git (ver .gitignore) e não muda: um APK assinado com outra chave não
# atualiza o que já está instalado -- o usuário teria de desinstalar e perder a
# biblioteca. Se você distribui o aplicativo, guarde este arquivo.
if [ ! -f "$chave" ]; then
    echo "== gerando a chave de assinatura (primeira vez)"
    mkdir -p "$(dirname "$chave")"
    docker run --rm -v "$raiz/android/chave:/chave" "$imagem" \
        keytool -genkeypair -v \
            -keystore /chave/torrange.jks \
            -storepass torrange -keypass torrange \
            -alias torrange -keyalg RSA -keysize 4096 -validity 10950 \
            -dname "CN=Torrange, OU=Aplicativos, O=Torrange, L=-, S=-, C=BR"
fi

# ------------------------------------------------------------------ o build
# O container roda com o SEU usuario, para o APK nao sair com dono root. Isso
# deixa o HOME apontando para "/", que nao e gravavel -- e o plugin do Android
# desiste na primeira linha tentando escrever ~/.android. Por isso o HOME (e o
# cache do Gradle) moram junto, dentro de .cache/.
mkdir -p "$cache" "$raiz/.cache/android-home" dist

tarefa="assembleRelease"
saida="android/app/build/outputs/apk/release/app-release.apk"
nome="Torrange-$(grep -oP '(?<=val versaoDoApp = ")[^"]+' android/app/build.gradle.kts).apk"

if [ "$alvo" = "debug" ]; then
    tarefa="assembleDebug"
    saida="android/app/build/outputs/apk/debug/app-debug.apk"
    nome="Torrange-debug.apk"
fi

echo "== gradle $tarefa"
docker run --rm \
    -v "$raiz":/app \
    -v "$cache":/cache/gradle \
    -v "$raiz/.cache/android-home":/cache/home \
    -w /app/android \
    -e GRADLE_USER_HOME=/cache/gradle \
    -e HOME=/cache/home \
    -e ANDROID_USER_HOME=/cache/home/.android \
    -u "$(id -u):$(id -g)" \
    "$imagem" \
    gradle --no-daemon "$tarefa"

cp "$saida" "dist/$nome"
echo
echo "== pronto: dist/$nome ($(du -h "dist/$nome" | cut -f1))"
