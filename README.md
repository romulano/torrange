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
| Windows (instalador) | `Torrange-Setup-1.0.5.exe` |
| Windows (portátil) | `Torrange-1.0.5-win.zip` |
| Linux (Debian/Ubuntu) | `torrange_1.0.5_amd64.deb` |
| Linux (universal) | `Torrange-1.0.5.AppImage` |

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
sudo apt install ./dist/torrange_1.0.5_amd64.deb
torrange                     # ou pelo menu de aplicativos: "Torrange"
```

Instala em `/opt/Torrange/`, cria o atalho no menu e o comando `torrange`.
Para remover: `sudo apt remove torrange`.

**Linux — qualquer distro (AppImage)**

```bash
chmod +x dist/Torrange-1.0.5.AppImage
./dist/Torrange-1.0.5.AppImage
```

**Windows**

Execute `Torrange-Setup-1.0.5.exe` (instalador, cria atalhos) ou descompacte
`Torrange-1.0.5-win.zip` e rode `Torrange.exe` (portátil, não instala nada).

**Primeiro uso**

0. *(Windows)* **Ajustes** → marcar **“Abrir o vídeo em janela separada”** → **Salvar**.
1. Aba **Acervo** → entre com seu e-mail, senha e o código de 6 dígitos. A sessão
   fica salva; é uma vez só.
2. Abra um título → o botão diz **Baixar**.
3. Aba **Downloads** acompanha o progresso. Dá para adicionar por lá também:
   link magnet, endereço de um torrent ou arquivo `.torrent` do disco.
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
| `Torrange-Setup-1.0.5.exe` | Windows — instalador | 154 MB |
| `Torrange-1.0.5-win.zip` | Windows — portátil | 207 MB |
| `Torrange-1.0.5.AppImage` | Linux — universal | 185 MB |
| `torrange_1.0.5_amd64.deb` | Linux — Debian/Ubuntu | 147 MB |

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
npm run teste                                     # site, rótulo "Baixar", entradas da aba Downloads e qBittorrent
npm run teste:qbit                                # espera pelo qBittorrent, falha visível e o .log de diagnóstico
npm run teste:credenciais                         # usuário e senha próprios do qBittorrent
npm run teste:player -- /caminho/video.mkv        # player: faixas, busca, pausa
npm run teste:biblioteca -- /caminho/video.mkv    # pastas, capas e edição
npm run teste:pacote                              # confere os instaladores gerados
```

Eles rodam com uma pasta de dados própria (`--user-data-dir`), então não brigam
pelo lock de instância única nem tocam na configuração, na fila de torrents ou
na biblioteca do app que você já tem instalado.

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

Toda navegação para um endereço de torrent (URL `.torrent` ou `/baixar/<id>`) é
**cancelada** em `will-navigate` / `setWindowOpenHandler`, e o arquivo é buscado
pelo próprio processo principal (`net.request` na sessão do site, então os
cookies do login vão junto) e entregue ao qBittorrent pela WebUI API. O
`.torrent` nunca chega à pasta de Downloads do usuário.

Não passar pelo mecanismo de download do Chromium é proposital: no Windows ele
podia cancelar o arquivo em silêncio — ou, quando o torrent vinha de outro
domínio, mandá-lo para o navegador do sistema. Nos dois casos o site
contabilizava o download e o app não recebia nada.

O `will-download` da sessão continua ativo como rede de segurança, para o caso
de o site montar o arquivo em JavaScript e usar uma URL `blob:`. Nenhuma dessas
camadas depende do HTML do site: se o layout mudar, o download continua
funcionando. Links `magnet:` são capturados nos mesmos dois pontos.

### Outras formas de adicionar um download

A aba **Downloads** aceita, além do que vem do Acervo:

- **link magnet** colado na caixa;
- **endereço web** — tanto o link direto do `.torrent` quanto o endereço da
  página do item no Torrange (nesse caso o app procura o botão de baixar dentro
  da página). A busca sai pela sessão do site, então vale para arquivos que só
  quem está logado enxerga;
- **arquivo `.torrent` do disco**, pelo botão *Arquivo .torrent…* (aceita vários
  de uma vez).

### Quando o qBittorrent ainda não subiu

O qBittorrent leva alguns segundos para responder — na primeira execução no
Windows, com o antivírus varrendo o executável, pode levar bem mais. Clicar em
**Baixar** nesse intervalo **não perde o torrent**: ele fica guardado e entra na
fila sozinho assim que o qBittorrent responde, sem precisar clicar de novo.

A aba **Downloads** mostra em que pé está — e, se ele não subir, mostra o
motivo na própria tela (não num aviso que some), com **Tentar de novo**, **Ver
detalhes** (o que o processo escreveu) e **Gerar .log**. O app ainda tenta
sozinho até três vezes antes de desistir, porque parte das falhas é passageira:
porta tomada no intervalo entre escolher e usar, executável ainda preso no
antivírus.

### Modo diagnóstico

**Ajustes → Gerar arquivo de diagnóstico (.log)** grava um arquivo único com
tudo o que costuma explicar um problema relatado:

- versões (app, Electron, Chrome, Node), sistema e tipo de sessão gráfica;
- caminhos usados e se os binários embutidos existem, com tamanho e permissão;
- configuração e espaço livre na pasta de downloads;
- estado do qBittorrent, o que o processo escreveu, o `qBittorrent.conf`
  (**sem a senha**) e o log que o próprio qBittorrent grava;
- diagnóstico do mpv, a fila e a biblioteca;
- tudo o que o app registrou **desde que abriu** — inclusive erros da interface.

O registro começa a ser gravado na subida do app, não na hora em que se pede o
arquivo, senão a parte mais importante já teria passado. É o arquivo para
anexar ao relatar um problema.

### Usuário e senha do qBittorrent

Em branco (o padrão), o app gera uma senha nova a cada execução e ninguém além
dele entra — a senha nunca sai da máquina. Preenchidos em **Ajustes → Acesso ao
qBittorrent**, os dados passam a valer também para abrir a interface web do
qBittorrent pelo navegador, no endereço que a própria tela mostra. Eles ficam
salvos em `config.json`, em texto puro, e o arquivo de diagnóstico **omite a
senha**.

> O nome do arquivo de configuração muda por plataforma: o qBittorrent lê
> `qBittorrent.ini` no Windows e `qBittorrent.conf` no resto. O app escreve os
> dois. Escrever só o `.conf` fazia o qBittorrent do Windows ignorar tudo o que
> o app configura — subia com os padrões dele, sem o nosso usuário e senha (e
> com a WebUI escutando em todas as interfaces, não só em `127.0.0.1`), o login
> falhava e nada era baixado.
>
> Como segunda rede de segurança, se o qBittorrent recusar as credenciais do
> app, este entra com a senha temporária que o próprio qBittorrent anuncia na
> saída — e diz isso na tela de Ajustes.

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

### Organizando a biblioteca

`src/main/metadados.js` guarda o que você edita — pastas, capas, nomes,
descrições e etiquetas — num arquivo próprio (`organizacao.json`), separado do
catálogo. Isso é proposital: o catálogo é reconstruído a cada segundo a partir
do qBittorrent, e o que você editou não pode ser atropelado por essa
sincronização.

**As pastas são virtuais.** Elas existem só dentro do app: criar, renomear,
mover ou excluir uma pasta nunca toca num arquivo em disco e nunca mexe no
torrent que o alimenta — então nada quebra o seeding. Excluir uma pasta faz o
que estava dentro subir um nível; nada se perde.

| O que dá para fazer | Onde |
| --- | --- |
| Criar pastas e subpastas | Biblioteca → **+ Nova pasta** |
| Trocar o nome de exibição | Editar → **Nome** (o arquivo em disco não é renomeado) |
| Escrever uma descrição | Editar → **Descrição** (em pastas e em títulos) |
| Etiquetas com filtro | Editar → **Etiquetas**; os chips no topo filtram |
| Nomear cada episódio | Editar → **Nome de cada arquivo** (quando há vários vídeos) |
| Mover para uma pasta | Editar → **Pasta** |
| Capa por arquivo ou link | Editar → **Escolher imagem…** ou colar a URL |

As capas são **copiadas** para os dados do app, então a biblioteca não quebra se
você mover ou apagar a imagem original depois. Elas são servidas por um esquema
próprio (`capa://`), que só entrega arquivos de dentro da pasta de capas — um
caminho como `capa://img/../../config.json` é recusado.

A busca e o filtro por etiqueta procuram no acervo inteiro, não só na pasta
aberta.

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
    metadados.js              pastas, capas, nomes, descrições e etiquetas
    diagnostico.js            registro do app e geração do .log de diagnóstico
    config.js, paths.js       ajustes e caminhos
src/preload/
    site-inject.js            roda dentro do site (rótulo do botão)
    app-preload.js            ponte segura para a interface
src/renderer/                 interface (abas, fila, biblioteca, player)
testes/
    e2e.js                    site, rótulo do botão e envio ao qBittorrent
    espera-qbit.js            espera pelo qBittorrent, falha visível e diagnóstico
    credenciais.js            usuário e senha próprios, e os dois nomes do .conf
    interface.js              navegação entre abas e sobreposições
    player.js                 biblioteca e player com um MKV real
    biblioteca.js             pastas, capas e edição
    pacote.js                 verifica os instaladores gerados
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
