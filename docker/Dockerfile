# Imagem de build: traz Node + Wine (necessario para gerar o instalador NSIS do
# Windows a partir do Linux) + as dependencias do electron-builder.
FROM electronuserland/builder:wine

RUN apt-get update && apt-get install -y --no-install-recommends \
        p7zip-full \
        unzip \
        curl \
        ca-certificates \
        file \
        desktop-file-utils \
        fakeroot \
    && rm -rf /var/lib/apt/lists/*

ENV ELECTRON_CACHE=/root/.cache/electron \
    ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder \
    npm_config_cache=/root/.npm

WORKDIR /project
