# Torrange

Aplicativo desktop (Electron) que junta três coisas numa janela só:

- **o acervo do [torrange.com](https://torrange.com/)**, que chega pela API do
  aplicativo — **por token, sem login**;
- **o qBittorrent embutido**, que recebe o torrent automaticamente — sem
  instalar nada à parte;
- **um player mpv**, que toca MKV com todas as faixas de áudio e legendas.

Empacotado para **Windows** (`.exe`), **Linux** (AppImage e `.deb`) e
**macOS** (`.dmg` e `.zip`).

---

## Download

Os instaladores estão publicados em
**[Releases](https://github.com/romulano/torrange/releases/latest)**.

| Sistema | Arquivo |
| --- | --- |
| Windows (instalador) | `Torrange-Setup-1.1.0.exe` |
| Windows (portátil) | `Torrange-1.1.0-win.zip` |
| Linux (Debian/Ubuntu) | `torrange_1.1.0_amd64.deb` |
| Linux (universal) | `Torrange-1.1.0.AppImage` |
| macOS (Apple Silicon) | `Torrange-1.1.0-arm64.dmg` |
| macOS (Intel) | `Torrange-1.1.0-x64.dmg` |

Nos pacotes de Windows e Linux o Electron, o qBittorrent e o mpv vão dentro:
não é preciso instalar Node, npm nem o qBittorrent à parte. **No macOS é
diferente** — veja a seção [macOS](#macos) abaixo.

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
> No macOS o app já abre em janela separada por conta própria.

## Primeiro uso

Não existe tela de login. O aplicativo se identifica por um **token de 100
caracteres**, que é seu e fica só neste computador.

1. Abra **[torrange.com/aplicativos](https://torrange.com/aplicativos)** e copie
   o token (se ainda não houver um, gere ali mesmo).
2. Abra o Torrange. Na aba **Acervo**, cole o token e clique em **Conectar**.
3. Volte ao site e clique em **Permitir** para este aparelho. O app fica na tela
   de espera e entra sozinho assim que a autorização sai.
4. Abra um título → escolha a opção → **Baixar**. O que custa gema pede
   confirmação com preço e saldo antes de cobrar.
5. Aba **Downloads** acompanha o progresso. Aba **Biblioteca** → **Assistir**.

Os arquivos vão para `~/Vídeos/Torrange` (Linux e macOS) ou `Vídeos\Torrange`
(Windows), configurável em **Ajustes**.

---

## Como funciona

### Comunicação por token

O app conversa com `https://torrange.com/api/aplicativo`. Dois cabeçalhos vão em
toda chamada:

| Cabeçalho | O que é |
| --- | --- |
| `X-Aplicativo-Token` | o token de 100 caracteres, a credencial da conta |
| `X-Aplicativo-Instalacao` | o identificador **deste aparelho**, criado na primeira execução e estável para sempre |

Quatro regras explicam quase todo o comportamento:

- **Token não é permissão.** Todo aparelho nasce *pendente*; só fala depois que
  o dono clicar em **Permitir**, no site. Por isso `aguardando_aprovacao` é
  tratado como **estado** (a tela de espera), nunca como erro.
- **Três aparelhos por conta**, contando os pendentes. Por isso o identificador
  da instalação é gravado em disco e nunca muda: um id novo a cada abertura
  gastaria as três vagas em três execuções.
- **Girar o token derruba tudo.** Quando o dono gera um token novo, o anterior
  morre na hora. O app trata `401 token_invalido` como *“peça o token de novo ao
  usuário”* — volta para a tela do token e apaga o que estava guardado, em vez
  de falhar calado.
- **Assinatura manda.** Assinatura vencida ou conta removida desligam o token,
  mesmo válido e mesmo autorizado — e essas duas levam a uma tela de erro
  própria, não à do token: trocar de token não resolveria nada.

> **O identificador do aparelho tem 64 caracteres, não 100.** A API aceita de
> **8 a 64** em `[A-Za-z0-9._:-]` e recusa o que passar disso com
> `400 instalacao_ausente`; o app usa o máximo que ela aceita. O *token*, esse
> sim, tem 100. Se um dia o limite subir, é a constante `TAMANHO_INSTALACAO` em
> `src/main/credenciais.js`.

### Onde o token fica guardado

O token é uma senha: quem o tem pede acesso à conta inteira. Por isso ele:

- é gravado **cifrado pelo cofre do sistema** (Keychain no macOS, DPAPI no
  Windows, libsecret/kwallet no Linux), num arquivo próprio — nunca no
  `config.json`;
- **nunca chega à interface**: a ponte do renderer só sabe *escrever* o token e
  ler a forma mascarada (`4kP9…c2Za`);
- **nunca entra no arquivo de diagnóstico**, em log, em URL ou em mensagem de
  erro.

Em máquinas sem cofre de credenciais (Linux sem chaveiro) ele cai para um
arquivo com permissão `600`, e a tela de **Ajustes** diz isso em vez de fingir
que está protegido.

### Do clique ao download

A ficha de um título lista as opções com tamanho, seeders e preço. Ao clicar em
**Baixar**:

- `GET /baixar/{item}` — **nunca debita**. Se a opção é free, o `.torrent` vem
  na hora e vai direto para o qBittorrent.
- Se custa gema, a API responde `402 confirmacao_necessaria` com **preço e
  saldo**, e nada foi cobrado. O app mostra a confirmação com quanto sobra.
- Confirmado, `POST /baixar/{item}` é o **único** caminho que cobra. Ele **não é
  repetido sozinho**: cada chamada entrega e cobra por si, então um retry cego
  depois de um timeout debitaria duas vezes.
- Se o preço mudar entre a confirmação e o POST, a API responde `preco_mudou`
  sem cobrar, e o app repergunta com o valor novo.

O `.torrent` nunca chega à pasta de Downloads do usuário: ele vai da API para a
memória e da memória para a WebUI API do qBittorrent.

> **Histórico não é posse.** Estar na aba *Já baixados* não dá direito a baixar
> de novo sem pagar — o preço continua aparecendo.

### Outras formas de adicionar um download

A aba **Downloads** aceita, além do que vem do Acervo:

- **link magnet** colado na caixa;
- **endereço web** — tanto o link direto de um `.torrent` quanto o de uma página
  que tenha o link dentro (o app procura). Segue redirecionamento, que é o caso
  de quem serve o arquivo por CDN;
- **arquivo `.torrent` do disco**, pelo botão *Arquivo .torrent…* (aceita vários
  de uma vez). O conteúdo é conferido como bencode antes de entrar na fila, para
  uma página de erro com HTTP 200 não virar “torrent”.

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
- caminhos usados e se os binários existem, com tamanho e permissão;
- configuração e espaço livre na pasta de downloads;
- estado da conexão com o site — fase, gemas, aparelho autorizado e o token
  **mascarado**;
- estado do qBittorrent, o que o processo escreveu, o `qBittorrent.conf`
  (**sem a senha**) e o log que o próprio qBittorrent grava;
- diagnóstico do mpv, a fila e a biblioteca;
- tudo o que o app registrou **desde que abriu** — inclusive erros da interface.

O registro começa na subida do app, não na hora em que se pede o arquivo, senão
a parte mais importante já teria passado.

### Usuário e senha do qBittorrent

Em branco (o padrão), o app gera uma senha nova a cada execução e ninguém além
dele entra — a senha nunca sai da máquina. Preenchidos em **Ajustes → Acesso ao
qBittorrent**, os dados passam a valer também para abrir a interface web do
qBittorrent pelo navegador, no endereço que a própria tela mostra.

> O nome do arquivo de configuração muda por plataforma: o qBittorrent lê
> `qBittorrent.ini` no Windows e `qBittorrent.conf` no resto. O app escreve os
> dois. Escrever só o `.conf` fazia o qBittorrent do Windows ignorar tudo o que
> o app configura — subia com os padrões dele, o login falhava e nada era
> baixado.
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
posicionada sobre a área de vídeo da interface. A comunicação é por IPC em JSON.

O mpv resolve o que o Chromium não resolve: MKV, H.265, AC3/DTS/TrueHD, múltiplas
faixas de áudio e legendas embutidas (inclusive PGS e ASS), além de legendas
externas na mesma pasta.

**Wayland:** o `--wid` só funciona no X11 — sob Wayland o
`getNativeWindowHandle()` devolve um id interno do Ozone, não um XID, e o mpv
morre com `BadWindow`. Numa sessão Wayland com XWayland disponível o app **se
relança uma vez** já com `--ozone-platform=x11`. Sem XWayland, cai sozinho para
uma janela de vídeo separada, ainda controlada pela interface. Para desligar:
`TORRANGE_OZONE=1`.

**macOS:** o vídeo abre sempre em janela separada. Acoplar dependeria de uma
`NSView` que o Electron não promete manter estável, e a falha é silenciosa —
áudio toca, relógio corre, tela preta: exatamente o sintoma que o Windows já
deu.

### Biblioteca

`src/main/library.js` cruza a fila do qBittorrent com os arquivos em disco,
guarda o catálogo e a posição de reprodução de cada arquivo. Um título continua
disponível para assistir mesmo se o torrent for removido da fila com os arquivos
mantidos.

`src/main/metadados.js` guarda o que você edita — pastas, capas, nomes,
descrições e etiquetas — num arquivo próprio (`organizacao.json`), separado do
catálogo, que é reconstruído a cada segundo a partir do qBittorrent.

**As pastas são virtuais.** Criar, renomear, mover ou excluir uma pasta nunca
toca num arquivo em disco e nunca mexe no torrent que o alimenta — então nada
quebra o seeding. Excluir uma pasta faz o que estava dentro subir um nível.

| O que dá para fazer | Onde |
| --- | --- |
| Criar pastas e subpastas | Biblioteca → **+ Nova pasta** |
| Trocar o nome de exibição | Editar → **Nome** (o arquivo em disco não é renomeado) |
| Escrever uma descrição | Editar → **Descrição** |
| Etiquetas com filtro | Editar → **Etiquetas**; os chips no topo filtram |
| Nomear cada episódio | Editar → **Nome de cada arquivo** |
| Mover para uma pasta | Editar → **Pasta** |
| Capa por arquivo ou link | Editar → **Escolher imagem…** ou colar a URL |

As capas são **copiadas** para os dados do app, e servidas por um esquema
próprio (`capa://`), que só entrega arquivos de dentro da pasta de capas. As
capas do acervo vêm por outro esquema (`acervo://capa/<item>`), buscado pelo
processo principal — o renderer nunca vê o token nem monta URL de bucket.

---

## <a id="macos"></a>macOS

O app roda e é empacotado normalmente (`.dmg` e `.zip`, Intel e Apple Silicon),
mas **os binários de terceiros não vão dentro**: não existe build pronto de
`qbittorrent-nox` para Mac, e o `mpv` que circula empacotado está parado há
anos. Em vez de fingir que funciona, o app **procura os dois no sistema**:

```
/opt/homebrew/bin    (Homebrew em Apple Silicon)
/usr/local/bin       (Homebrew em Intel)
/opt/local/bin       (MacPorts)
~/.nix-profile/bin   (Nix)
```

Para o app funcionar por completo no macOS:

```bash
brew install mpv                              # player
sudo port install qbittorrent-nox             # MacPorts
# ou:
nix profile install nixpkgs#qbittorrent-nox   # Nix
```

Se algum deles faltar, o app abre e diz exatamente o que instalar — na aba
**Downloads**, para o qBittorrent, e ao tentar assistir, para o mpv.

Quem tiver builds próprios é só colocá-los antes de empacotar, que eles entram
no pacote e o app passa a preferi-los:

```
resources/bin/mac/qbittorrent/qbittorrent-nox
resources/bin/mac/mpv/mpv.app/Contents/MacOS/mpv
```

O pacote **não é assinado nem notarizado** (isso exige um certificado de
desenvolvedor da Apple): na primeira abertura o macOS avisa — clique com o botão
direito no app → **Abrir** → **Abrir**.

## Como buildar

**Windows e Linux** — só precisa de Docker:

```bash
./build.sh
```

Os instaladores saem em `dist/`:

| Arquivo | Plataforma |
|---|---|
| `Torrange-Setup-1.1.0.exe` | Windows — instalador |
| `Torrange-1.1.0-win.zip` | Windows — portátil |
| `Torrange-1.1.0.AppImage` | Linux — universal |
| `torrange_1.1.0_amd64.deb` | Linux — Debian/Ubuntu |

Para gerar só uma plataforma: `ALVOS="--linux" ./build.sh` ou `ALVOS="--win" ./build.sh`.

**macOS** — precisa rodar **num Mac**: o `.dmg` é montado com o `hdiutil`, que
só existe lá, e não há como gerar de dentro do Docker.

```bash
npm run dist:mac
```

> O instalador do Windows não é assinado. Na primeira execução o SmartScreen
> mostra um aviso — "Mais informações" → "Executar assim mesmo".

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
Não dependem do site real nem de credenciais: um servidor local **fala a API do
aplicativo inteira**, com token, autorização pendente, gemas e as recusas todas.

```bash
npm run teste                                     # token, acervo, download free e pago, entradas da aba Downloads
npm run teste:token                               # a tabela de erros: token girado, assinatura, conta, sem vaga
npm run teste:qbit                                # espera pelo qBittorrent, falha visível e o .log de diagnóstico
npm run teste:credenciais                         # usuário e senha próprios do qBittorrent
npm run teste:interface                           # navegação entre abas e sobreposições
npm run teste:player -- /caminho/video.mkv        # player: faixas, busca, pausa
npm run teste:biblioteca -- /caminho/video.mkv    # pastas, capas e edição
npm run teste:pacote                              # confere os instaladores gerados
```

Eles rodam com uma pasta de dados própria (`--user-data-dir`), então não brigam
pelo lock de instância única nem tocam na configuração, no token, na fila de
torrents ou na biblioteca do app que você já tem instalado.

O teste do player gera um `.torrent` do arquivo que você indicar, manda pelo
app, espera o qBittorrent conferir os pedaços, abre o player e verifica faixas
de áudio, legendas, reprodução, busca e pausa. O arquivo indicado **nunca é
apagado** (a remoção usa `deleteFiles=false`).

## Estrutura

```
build.sh                      build de Windows e Linux no Docker
scripts/build-mac.sh          build do macOS (roda num Mac)
docker/Dockerfile             imagem com Node + Wine
scripts/fetch-binaries.sh     baixa e verifica qbittorrent-nox e mpv
scripts/binaries.manifest     URLs e SHA256 dos binários
src/main/
    index.js                  orquestra tudo, IPC, ciclo de vida
    api.js                    cliente da API do aplicativo (token + acervo)
    conexao.js                estado da conexão: token, pendente, aprovado, erro
    credenciais.js            token cifrado e id estável da instalação
    qbit.js                   qBittorrent embutido + WebUI API
    torrent.js                entrada de torrent por endereço web
    player.js                 mpv acoplado + IPC
    library.js                catálogo e posições de reprodução
    metadados.js              pastas, capas, nomes, descrições e etiquetas
    diagnostico.js            registro do app e geração do .log
    config.js, paths.js       ajustes e caminhos (inclusive os do macOS)
src/preload/app-preload.js    ponte segura para a interface
src/renderer/                 interface (token, acervo, fila, biblioteca, player)
testes/
    e2e.js                    token, acervo, download free e pago
    token.js                  a tabela de recusas da API
    espera-qbit.js            espera pelo qBittorrent, falha visível e diagnóstico
    credenciais.js            usuário e senha próprios, e os dois nomes do .conf
    interface.js              navegação entre abas e sobreposições
    player.js                 biblioteca e player com um MKV real
    biblioteca.js             pastas, capas e edição
    pacote.js                 verifica os instaladores gerados
    cdp.js                    utilidades de DevTools Protocol
    servidor-falso.js         a API do aplicativo, inteira, para os testes
```

## Terceiros

O app empacota dois programas livres, executados como **processos independentes**
(o Torrange fala com eles por HTTP e por socket, sem linkar código):

- [qBittorrent](https://github.com/qbittorrent/qBittorrent) — GPLv3
- [mpv](https://github.com/mpv-player/mpv) — LGPLv2.1+

As versões e URLs exatas estão em `scripts/binaries.manifest`.

## Licença

MIT. Veja também a seção **Terceiros** acima.
