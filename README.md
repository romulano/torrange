# Torrange

Aplicativo desktop (Electron) que junta três coisas numa janela só:

- **o site** [torrange.com](https://torrange.com/), com o botão de download reescrito para **"Baixar"**;
- **o qBittorrent embutido**, que recebe o torrent automaticamente — sem instalar nada à parte;
- **um player mpv**, que toca MKV com todas as faixas de áudio e legendas.

Empacotado para **Windows** (`.exe`) e **Linux** (AppImage e `.deb`), tudo gerado dentro do Docker.

---

## Download

Os instaladores estão publicados em
**[Releases](https://github.com/romulano/torrange/releases/latest)**.

| Sistema | Arquivo |
| --- | --- |
| Windows (instalador) | `Torrange-Setup-1.0.1.exe` |
| Windows (portátil) | `Torrange-1.0.1-win.zip` |
| Linux (Debian/Ubuntu) | `torrange_1.0.1_amd64.deb` |
| Linux (universal) | `Torrange-1.0.1.AppImage` |

Os pacotes são autocontidos: trazem o Electron, o qBittorrent e o mpv dentro.
Não é preciso instalar Node, npm nem o qBittorrent à parte.

> ### ⚠️ No Windows, faça isto antes de assistir
>
> Abra **Ajustes** → marque **“Abrir o vídeo em janela separada”** → **Salvar**.
>
> Sem isso a área do vídeo fica **preta**: o áudio toca, o tempo corre e as
> faixas aparecem, mas não há imagem. Marcada a opção, o mpv abre numa janela
> própria e continua sendo controlado pelos botões do app (play, busca, volume,
> áudio e legenda).
>
> No Linux não é necessário — lá o vídeo aparece acoplado à janela normalmente.

## Instalando e usando (sem Node, sem npm)

Os pacotes são autocontidos: trazem o Electron, o qBittorrent e o mpv dentro.
Nada precisa ser instalado à parte.

**Linux — Debian/Ubuntu**

```bash
sudo apt install ./dist/torrange_1.0.1_amd64.deb
torrange                     # ou pelo menu de aplicativos: "Torrange"
```

Instala em `/opt/Torrange/`, cria o atalho no menu e o comando `torrange`.
Para remover: `sudo apt remove torrange`.

**Linux — qualquer distro (AppImage)**

```bash
chmod +x dist/Torrange-1.0.1.AppImage
./dist/Torrange-1.0.1.AppImage
```

**Windows**

Execute `Torrange-Setup-1.0.1.exe` (instalador, cria atalhos) ou descompacte
`Torrange-1.0.1-win.zip` e rode `Torrange.exe` (portátil, não instala nada).

**Primeiro uso**

0. *(Windows)* **Ajustes** → marcar **“Abrir o vídeo em janela separada”** → **Salvar**.
1. Aba **Acervo** → entre com seu e-mail, senha e o código de 6 dígitos. A sessão
   fica salva; é uma vez só.
2. Abra um título → o botão diz **Baixar**.
3. Aba **Downloads** acompanha o progresso.
4. Aba **Biblioteca** → **Assistir**. O menu de áudio e legenda fica na barra do
   player.

Os arquivos vão para `~/Vídeos/Torrange` (Linux) ou `Vídeos\Torrange` (Windows),
configurável em **Ajustes**.

## Como buildar

Só precisa de Docker instalado:

```bash
./build.sh
```

Os instaladores saem em `dist/`:

| Arquivo | Plataforma | Tamanho |
|---|---|---|
| `Torrange-Setup-1.0.1.exe` | Windows — instalador | 154 MB |
| `Torrange-1.0.1-win.zip` | Windows — portátil | 207 MB |
| `Torrange-1.0.1.AppImage` | Linux — universal | 185 MB |
| `torrange_1.0.1_amd64.deb` | Linux — Debian/Ubuntu | 147 MB |

Para gerar só uma plataforma:

```bash
ALVOS="--linux" ./build.sh
ALVOS="--win"   ./build.sh
```

> O instalador do Windows não é assinado. Na primeira execução o SmartScreen mostra
> um aviso — "Mais informações" → "Executar assim mesmo". Some com um certificado
> de assinatura de código.

## Rodando em modo de desenvolvimento

```bash
npm install
npm run binaries   # baixa qbittorrent-nox e mpv para resources/bin/
npm start
```

> Terminais embutidos em editores Electron (VS Code) exportam
> `ELECTRON_RUN_AS_NODE=1`, o que faz o Electron rodar como Node puro e o app
> quebrar na primeira linha. O `npm start` passa por `scripts/start.js`, que
> remove essa variável antes de subir.

## Testes

Os testes dirigem o app de verdade pelo DevTools Protocol — nada é simulado.
Não dependem do site real nem de credenciais: um servidor local reproduz o mesmo
HTML do botão do torrange e serve um `.torrent` válido.

```bash
npm run teste                          # site, rótulo "Baixar" e envio ao qBittorrent
npm run teste:player -- /caminho/video.mkv   # biblioteca e player
```

O teste do player gera um `.torrent` do arquivo que você indicar, manda pelo
app, espera o qBittorrent conferir os pedaços e marcar como concluído, abre o
player e verifica faixas de áudio, legendas, reprodução, busca e pausa. O
arquivo indicado **nunca é apagado** (a remoção usa `deleteFiles=false`).

---

## Como funciona

### O botão "Baixar"

No site, o rótulo é assim:

```html
<a href="/baixar/4079200" class="botao-baixar">
    ↓ Baixar<span class="sufixo"> .torrent</span>
</a>
```

O `.torrent` está isolado num `span.sufixo`, então uma regra de CSS injetada
(`src/main/site.js`) esconde só esse trecho — o resto do site fica intacto. O
preload `src/preload/site-inject.js` é a rede de segurança: se aparecer
"Baixar .torrent" escrito de outro jeito em outra página, ele limpa o texto.

### Do clique ao download

O `will-download` da sessão intercepta **qualquer** resposta
`application/x-bittorrent` (ou URL `.torrent` / `/baixar/<id>`), desvia o arquivo
para a pasta temporária e o entrega ao qBittorrent pela WebUI API. O `.torrent`
nunca chega à pasta de Downloads do usuário.

Essa camada não depende do HTML do site: se o layout mudar, o download continua
funcionando. Links `magnet:` são capturados em `will-navigate` e no
`setWindowOpenHandler`.

### qBittorrent embutido

`src/main/qbit.js` sobe o `qbittorrent-nox` como processo filho, num perfil
próprio dentro dos dados do app:

- escolhe uma **porta livre** e gera uma **senha nova a cada execução**
  (PBKDF2-HMAC-SHA512, 100k iterações — o mesmo formato do `qBittorrent.conf`);
- a WebUI escuta só em `127.0.0.1`;
- os torrents entram na categoria `torrange`, com download sequencial e
  prioridade nas primeiras/últimas peças, que é o que permite assistir antes do
  fim;
- ao fechar o app, chama `/api/v2/app/shutdown` e só então encerra o processo.

### Player

`src/main/player.js` sobe o **mpv** e o acopla (`--wid`) a uma janela filha
posicionada sobre a área de vídeo da interface. A comunicação é por IPC em JSON:
o app observa `time-pos`, `duration`, `pause`, `track-list` e companhia, e envia
comandos de seek, volume e troca de faixa.

O mpv resolve o que o Chromium não resolve: MKV, H.265, AC3/DTS/TrueHD, múltiplas
faixas de áudio e legendas embutidas (inclusive PGS e ASS), além de legendas
externas na mesma pasta.

**Wayland:** o `--wid` só funciona no X11 — sob Wayland o
`getNativeWindowHandle()` devolve um id interno do Ozone, não um XID, e o mpv
morre com `BadWindow`. A escolha da plataforma acontece antes do código do app
rodar, então `app.commandLine.appendSwitch` chega tarde demais: numa sessão
Wayland com XWayland disponível o app **se relança uma vez** já com
`--ozone-platform=x11`. Sem XWayland, ele cai sozinho para uma janela de vídeo
separada, ainda controlada pela interface. Para desligar esse comportamento:
`TORRANGE_OZONE=1`.

### Biblioteca

`src/main/library.js` cruza a fila do qBittorrent com os arquivos em disco,
guarda o catálogo e a posição de reprodução de cada arquivo. Um título continua
disponível para assistir mesmo se o torrent for removido da fila com os arquivos
mantidos.

---

## Quando o vídeo não aparece

Em **Ajustes → Diagnóstico do player**, com um vídeo aberto, o app mostra o que o
mpv conseguiu fazer. A linha decisiva é `saida de video (vo)`:

| `vo` | O que significa | O que fazer |
|---|---|---|
| vazio | O mpv não criou nenhuma saída de vídeo | Marcar “Abrir o vídeo em janela separada” |
| `gpu` / `direct3d` | O mpv está desenhando, mas algo cobre a janela | Marcar “Abrir o vídeo em janela separada” |

O painel também traz o log do mpv, o codec, a decodificação em uso e as
coordenadas das janelas, com um botão **Copiar**.

## Estrutura

```
build.sh                      build completo no Docker
docker/Dockerfile             imagem com Node + Wine
scripts/fetch-binaries.sh     baixa e verifica qbittorrent-nox e mpv
scripts/binaries.manifest     URLs e SHA256 dos binários
src/main/
    index.js                  orquestra tudo, IPC, ciclo de vida
    qbit.js                   qBittorrent embutido + WebUI API
    site.js                   WebContentsView do site + interceptação
    player.js                 mpv acoplado + IPC
    library.js                catálogo e posições de reprodução
    config.js, paths.js       ajustes e caminhos
src/preload/
    site-inject.js            roda dentro do site (rótulo do botão)
    app-preload.js            ponte segura para a interface
src/renderer/                 interface (abas, fila, biblioteca, player)
testes/
    e2e.js                    site, rótulo do botão e envio ao qBittorrent
    player.js                 biblioteca e player com um MKV real
    cdp.js                    utilidades de DevTools Protocol
    servidor-falso.js         página e .torrent de teste
```

## Terceiros

O app empacota dois programas livres, executados como **processos independentes**
(o Torrange fala com eles por HTTP e por socket, sem linkar código):

- [qBittorrent](https://github.com/qbittorrent/qBittorrent) — GPLv3
- [mpv](https://github.com/mpv-player/mpv) — LGPLv2.1+

As versões e URLs exatas estão em `scripts/binaries.manifest`.

## Licença

MIT. Veja também a seção **Terceiros** acima.
