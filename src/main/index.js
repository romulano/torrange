'use strict';
/**
 * Torrange - processo principal.
 *
 * Junta quatro pecas: a API do site (token + acervo), o qBittorrent embutido
 * (processo filho + WebUI API) e o player mpv (janela nativa acoplada).
 *
 * A conversa com o site e por TOKEN, nao por login: o dono copia o token de
 * 100 caracteres em torrange.com/aplicativos, cola aqui, autoriza o aparelho
 * no site e pronto -- nao existe tela de login, nem sessao de navegador, nem
 * senha viajando para dentro do app.
 */
const { app, BrowserWindow, Menu, Notification, dialog, ipcMain, protocol, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const api = require('./api');
const conexao = require('./conexao');
const config = require('./config');
const credenciais = require('./credenciais');
const diagnostico = require('./diagnostico');
const paths = require('./paths');
const library = require('./library');
const metadados = require('./metadados');
const player = require('./player');
const qbit = require('./qbit');
const torrent = require('./torrent');

// Comeca a registrar antes de tudo: o que interessa no diagnostico e
// justamente a subida do app, que acontece bem antes de alguem pedir o log.
diagnostico.capturarConsole();

/**
 * Acoplar o video a janela (--wid do mpv) so funciona no X11: sob Wayland o
 * getNativeWindowHandle() devolve um id interno do Ozone, nao um XID, e o mpv
 * morre com "BadWindow".
 *
 * A plataforma do Ozone e escolhida ANTES deste script rodar, entao
 * app.commandLine.appendSwitch('ozone-platform', ...) chega tarde demais. O
 * jeito de valer e a flag estar na linha de comando -- por isso, numa sessao
 * Wayland que tenha XWayland (DISPLAY definido), o app se relanca uma vez ja
 * com a flag. Defina TORRANGE_OZONE=1 para desligar esse comportamento.
 */
const X11_NA_LINHA = process.argv.includes('--ozone-platform=x11');
const SESSAO_WAYLAND = !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland');

if (
    process.platform === 'linux' &&
    !process.env.TORRANGE_OZONE &&
    !process.env.TORRANGE_RELANCADO && // trava dupla contra laco de relancamento
    !X11_NA_LINHA &&
    SESSAO_WAYLAND &&
    process.env.DISPLAY
) {
    process.env.TORRANGE_RELANCADO = '1'; // o ambiente e herdado pelo novo processo
    const args = process.argv.slice(1).concat(['--ozone-platform=x11']);

    // Num AppImage o executavel real fica dentro do pacote montado; relancar
    // por ele nao funciona, e preciso chamar o proprio .AppImage.
    if (process.env.APPIMAGE) app.relaunch({ execPath: process.env.APPIMAGE, args });
    else app.relaunch({ args });

    app.exit(0);
    // eslint-disable-next-line no-restricted-syntax -- modulo CommonJS aceita return
    return;
}

/**
 * No macOS o --wid do mpv depende de uma NSView que o Electron nao promete
 * manter estavel, e a falha e silenciosa: audio toca, relogio corre, tela
 * preta -- exatamente o sintoma que o Windows ja deu. Por isso o padrao la e
 * a janela de video separada, ainda controlada pela interface daqui.
 */
const podeEmbutirVideo =
    process.platform === 'win32' || X11_NA_LINHA || (process.platform === 'linux' && !SESSAO_WAYLAND && !!process.env.DISPLAY);

app.setName('Torrange');

/**
 * Dois esquemas proprios, os dois servidos so pelo processo principal:
 *
 *   capa://img/<arquivo>  as capas que o usuario escolheu, guardadas nos dados
 *                         do app (fora do alcance do file:// do renderer);
 *   acervo://capa/<item>  as capas do acervo, que so a API entrega e so com o
 *                         token nos cabecalhos -- o renderer nunca ve o token.
 */
protocol.registerSchemesAsPrivileged([
    { scheme: 'capa', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: 'acervo', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let janela = null;
let monitor = null;
let abaAtual = 'acervo';
let retangulos = { player: null };
const progressoAnterior = new Map();
let encerrando = false;
let qbitPronto = false;
// Enquanto o qBittorrent nao sobe, o que o usuario pediu fica guardado aqui e
// entra na fila assim que ele responde -- perder o torrent capturado seria o
// mesmo que o clique nao ter funcionado.
const pendentes = [];
let estadoQbit = { fase: 'iniciando', motivo: '', tentativa: 0 };

// --------------------------------------------------------------------------
// Utilidades

function enviar(canal, dados) {
    if (janela && !janela.isDestroyed()) janela.webContents.send(canal, dados);
}

function avisar(texto, tipo = 'info') {
    enviar('aviso', { texto, tipo });
}

function publicarEstadoQbit(fase, motivo = '') {
    estadoQbit = { fase, motivo, tentativa: estadoQbit.tentativa, pendentes: pendentes.length };
    enviar('qbit:estado', estadoQbit);
}

function notificar(titulo, corpo) {
    if (!Notification.isSupported()) return;
    try {
        new Notification({ title: titulo, body: corpo }).show();
    } catch {
        /* ambiente sem notificacao */
    }
}

// --------------------------------------------------------------------------
// Janela

function criarJanela() {
    janela = new BrowserWindow({
        width: 1360,
        height: 860,
        minWidth: 1024,
        minHeight: 640,
        backgroundColor: '#0e1013',
        show: false,
        title: 'Torrange',
        icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'app-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    Menu.setApplicationMenu(null);
    janela.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    janela.once('ready-to-show', () => janela.show());

    janela.on('closed', () => {
        janela = null;
    });

    janela.on('resize', () => aplicarLayout());
    janela.on('maximize', () => aplicarLayout());
    janela.on('unmaximize', () => aplicarLayout());

    player.configurar(janela, { podeEmbutir: podeEmbutirVideo }, (evento) => {
        if (evento.tipo === 'mensagem' && evento.nome === 'tela-cheia') {
            alternarTelaCheia();
            return;
        }
        if (evento.tipo === 'log') {
            console.log('[mpv]', evento.texto);
            return;
        }
        enviar('player:evento', evento);
    });
}

function alternarTelaCheia() {
    if (!janela) return;
    janela.setFullScreen(!janela.isFullScreen());
    enviar('player:evento', { tipo: 'tela-cheia', valor: janela.isFullScreen() });
}

/** A interface manda o retangulo do video; aqui posicionamos a janela nativa. */
function aplicarLayout() {
    if (!janela || janela.isDestroyed()) return;

    if (abaAtual === 'player' && retangulos.player && player.aberto) {
        player.definirRetangulo(retangulos.player);
        player.mostrar();
    } else {
        player.esconder();
    }
}

// --------------------------------------------------------------------------
// Conexao com o site

function publicarConexao(estado) {
    enviar('conexao:estado', estado);
}

// --------------------------------------------------------------------------
// Entrada de torrents

/** Guarda o pedido para quando o qBittorrent responder. */
function enfileirar(pedido, titulo) {
    pendentes.push(pedido);
    publicarEstadoQbit(estadoQbit.fase, estadoQbit.motivo);
    if (estadoQbit.fase === 'erro') {
        avisar(
            `O qBittorrent não subiu, então "${titulo}" está esperando. Veja o motivo na aba Downloads.`,
            'erro'
        );
        return;
    }
    avisar(`O qBittorrent ainda está subindo. "${titulo}" entra na fila assim que ele responder.`, 'info');
}

/** Manda para a fila tudo o que ficou esperando o qBittorrent. */
async function despejarPendentes() {
    if (!qbitPronto || !pendentes.length) return;
    const lista = pendentes.splice(0, pendentes.length);
    publicarEstadoQbit(estadoQbit.fase, estadoQbit.motivo);
    for (const pedido of lista) {
        if (pedido.magnet) await receberMagnet(pedido.magnet);
        else await receberTorrent(pedido);
    }
}

async function receberTorrent({ dados, nome }) {
    if (!qbitPronto) {
        enfileirar({ dados, nome }, (nome || 'torrent').replace(/\.torrent$/i, ''));
        return { esperando: true };
    }
    try {
        const t = await qbit.adicionar({ dados, nome }, config.ler());
        const titulo = (t && t.name) || (nome || '').replace(/\.torrent$/i, '');
        avisar(`Baixando: ${titulo}`, 'ok');
        notificar('Download iniciado', titulo);
        await atualizar();
        return { ok: true, titulo };
    } catch (erro) {
        avisar(erro.message, 'erro');
        return { erro: erro.message };
    }
}

async function receberMagnet(magnet) {
    if (!qbitPronto) {
        enfileirar({ magnet }, 'o link magnet');
        return { esperando: true };
    }
    try {
        const t = await qbit.adicionar({ magnet }, config.ler());
        avisar(`Baixando: ${(t && t.name) || 'magnet'}`, 'ok');
        await atualizar();
        return { ok: true };
    } catch (erro) {
        avisar(erro.message, 'erro');
        return { erro: erro.message };
    }
}

/**
 * Entrada por endereco web: aceita o link direto do .torrent e tambem o
 * endereco de uma pagina que tenha o link dentro dela.
 */
async function receberUrl(endereco) {
    const texto = String(endereco || '').trim();
    if (texto.startsWith('magnet:')) return receberMagnet(texto);
    if (!/^https?:\/\//i.test(texto)) {
        avisar('Cole um link magnet ou um endereço que comece com http:// ou https://', 'erro');
        return { erro: 'endereço inválido' };
    }
    try {
        const arquivo = await torrent.pegar(texto, { seguirPagina: true });
        if (!arquivo) {
            avisar('Esse endereço não devolveu um arquivo .torrent.', 'erro');
            return { erro: 'sem torrent' };
        }
        return await receberTorrent(arquivo);
    } catch (erro) {
        avisar(`Não consegui baixar o torrent: ${erro.message}`, 'erro');
        return { erro: erro.message };
    }
}

/** Entrada por arquivo: o usuario escolhe um ou mais .torrent do disco. */
async function escolherTorrents() {
    const r = await dialog.showOpenDialog(janela, {
        title: 'Escolher arquivos .torrent',
        buttonLabel: 'Adicionar',
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Arquivos .torrent', extensions: ['torrent'] },
            { name: 'Todos os arquivos', extensions: ['*'] },
        ],
    });
    if (r.canceled || !r.filePaths.length) return { cancelado: true };

    let adicionados = 0;
    for (const arquivo of r.filePaths) {
        try {
            const dados = fs.readFileSync(arquivo);
            if (!torrent.ehBytesTorrent(dados)) {
                avisar(`${path.basename(arquivo)} não parece um arquivo .torrent.`, 'erro');
                continue;
            }
            await receberTorrent({ dados, nome: path.basename(arquivo) });
            adicionados++;
        } catch (erro) {
            avisar(`Falha ao ler ${path.basename(arquivo)}: ${erro.message}`, 'erro');
        }
    }
    return { adicionados };
}

// --------------------------------------------------------------------------
// Acervo (API do site)

/**
 * Envelopa uma chamada da API: o renderer recebe sempre { ok } ou
 * { erro, mensagem }, e a maquina de estados da conexao fica sabendo quando a
 * recusa foi de autorizacao (token trocado, aparelho removido, assinatura).
 */
async function chamarApi(fn) {
    try {
        return { ok: true, dados: await fn() };
    } catch (erro) {
        await conexao.registrarFalha(erro, config.ler());
        return {
            ok: false,
            erro: erro.erro || 'falha',
            mensagem: erro.message || 'Não consegui falar com o site.',
            retryAfter: erro.retryAfter || 0,
            // O corpo da recusa vai junto: e nele que vem o preco novo do
            // preco_mudou e o saldo do sem_saldo, que a tela precisa mostrar.
            dados: erro.dados || null,
        };
    }
}

// As capas vem dezenas por tela; guardamos as ultimas para nao bater na API
// a cada rolagem (o teto da rota e de 300 por minuto).
const capasEmCache = new Map();
const MAX_CAPAS = 240;

async function capaDoAcervo(item) {
    if (capasEmCache.has(item)) return capasEmCache.get(item);
    let resultado = null;
    try {
        resultado = await api.capa(item);
    } catch {
        resultado = null; // capa que falha e um quadrado vazio, nao um erro na tela
    }
    if (capasEmCache.size >= MAX_CAPAS) {
        capasEmCache.delete(capasEmCache.keys().next().value);
    }
    capasEmCache.set(item, resultado);
    return resultado;
}

/**
 * Baixar uma opcao do acervo.
 *
 * O GET nunca debita: se a opcao for free o arquivo vem na hora. Se custar
 * gema, a API responde 402 com preco e saldo e NADA acontece -- a confirmacao
 * volta para a tela, e so o POST (em confirmarDownload) cobra.
 */
async function baixarDoAcervo(item) {
    const r = await chamarApi(() => api.baixar(item));
    if (!r.ok) return r;

    if (r.dados.confirmacao) return { ok: true, confirmacao: r.dados.confirmacao };

    const entrada = await receberTorrent(r.dados.torrent);
    return Object.assign({ ok: true, baixando: true }, entrada);
}

/**
 * Confirma um download pago. Sem retry, de proposito: o servidor entrega e
 * cobra cada chamada por si, entao repetir depois de um timeout debitaria
 * duas vezes. Se a resposta nao chegar, o saldo e conferido em /conta.
 */
async function confirmarDownload(item, preco) {
    const r = await chamarApi(() => api.confirmarBaixar(item, preco));
    if (!r.ok) {
        // "o preco virou entre a confirmacao e o POST": nada foi debitado e a
        // resposta ja traz o valor de agora, entao a tela pode reperguntar.
        if (r.erro === 'preco_mudou' || r.erro === 'sem_saldo') return r;
        return r;
    }
    const entrada = await receberTorrent(r.dados.torrent);
    await conexao.atualizarConta(config.ler()); // o saldo mudou
    return Object.assign({ ok: true, baixando: true }, entrada);
}

// --------------------------------------------------------------------------
// Monitor

async function atualizar() {
    if (!qbitPronto || !janela || janela.isDestroyed()) return;
    try {
        const biblioteca = metadados.aplicar(await library.sincronizar());
        const fila = library.snapshot();

        // avisa quando um download termina
        for (const t of fila) {
            const antes = progressoAnterior.get(t.hash);
            if (antes !== undefined && antes < 1 && t.progress >= 1) {
                notificar('Download concluido', t.name);
                avisar(`Pronto para assistir: ${t.name}`, 'ok');
            }
            progressoAnterior.set(t.hash, t.progress);
        }

        enviar('fila:atualizou', fila);
        enviar('biblioteca:atualizou', biblioteca);
    } catch (erro) {
        console.error('monitor:', erro.message);
    }
}

function iniciarMonitor() {
    clearInterval(monitor);
    monitor = setInterval(atualizar, 1000);
}

// --------------------------------------------------------------------------
// IPC

function registrarIpc() {
    ipcMain.on('ui:aba', (_e, nome) => {
        abaAtual = nome;
        aplicarLayout();
    });

    ipcMain.on('ui:layout', (_e, dados) => {
        retangulos = Object.assign(retangulos, dados || {});
        aplicarLayout();
    });

    ipcMain.on('ui:tela-cheia', (_e, ligar) => {
        if (!janela) return;
        janela.setFullScreen(!!ligar);
        enviar('player:evento', { tipo: 'tela-cheia', valor: janela.isFullScreen() });
    });

    // ------------------------------------------------------------ conexao
    ipcMain.handle('conexao:estado', () => conexao.estado());

    ipcMain.handle('conexao:definir-token', async (_e, texto) => {
        const r = await conexao.definirToken(texto, config.ler());
        if (!r.ok) return r;
        capasEmCache.clear(); // outra conta enxerga outro acervo
        return r;
    });

    ipcMain.handle('conexao:esquecer', () => {
        capasEmCache.clear();
        return conexao.esquecerToken();
    });

    ipcMain.handle('conexao:verificar', () => conexao.reverificar(config.ler()));

    ipcMain.handle('conexao:abrir-site', async () => {
        await shell.openExternal(conexao.paginaAplicativos());
        return true;
    });

    // ------------------------------------------------------------- acervo
    ipcMain.handle('acervo:listar', (_e, filtros) => chamarApi(() => api.acervo(filtros || {})));
    ipcMain.handle('acervo:titulo', (_e, chave) => chamarApi(() => api.titulo(chave)));
    ipcMain.handle('acervo:favoritos', (_e, pagina) => chamarApi(() => api.favoritos(pagina || 1)));
    ipcMain.handle('acervo:baixados', (_e, pagina) => chamarApi(() => api.baixados(pagina || 1)));
    ipcMain.handle('acervo:favoritar', (_e, chave, item) =>
        chamarApi(() => api.alternarFavorito(chave, item))
    );
    ipcMain.handle('acervo:baixar', (_e, item) => baixarDoAcervo(item));
    ipcMain.handle('acervo:confirmar', (_e, item, preco) => confirmarDownload(item, preco));

    // --------------------------------------------------------------- fila
    ipcMain.handle('fila:listar', () => library.snapshot());
    ipcMain.handle('fila:pausar', (_e, hash) => qbit.pausar(hash).then(atualizar));
    ipcMain.handle('fila:retomar', (_e, hash) => qbit.retomar(hash).then(atualizar));
    ipcMain.handle('fila:remover', async (_e, hash, apagar) => {
        await qbit.remover(hash, apagar);
        progressoAnterior.delete(hash);
        await atualizar();
        return true;
    });
    ipcMain.handle('fila:magnet', (_e, magnet) => receberMagnet(magnet));
    ipcMain.handle('fila:url', (_e, endereco) => receberUrl(endereco));
    ipcMain.handle('fila:arquivo', () => escolherTorrents());

    ipcMain.handle('qbit:estado', () => estadoQbit);
    ipcMain.handle('qbit:tentar', async () => {
        await subirQbit();
        return estadoQbit;
    });
    // ---------------------------------------------- modo diagnostico (.log)
    ipcMain.on('app:log', (_e, dados) => {
        diagnostico.anotar((dados && dados.origem) || 'interface', dados && dados.texto);
    });

    ipcMain.handle('app:diagnostico', async (_e, opcoes = {}) => {
        try {
            const nome = diagnostico.nomeSugerido();
            let destino = path.join(app.getPath('userData'), 'diagnosticos', nome);

            if (opcoes.escolher !== false) {
                let padrao;
                try {
                    padrao = path.join(app.getPath('desktop'), nome);
                } catch {
                    padrao = destino;
                }
                const r = await dialog.showSaveDialog(janela, {
                    title: 'Salvar o diagnóstico',
                    defaultPath: padrao,
                    filters: [{ name: 'Registro', extensions: ['log'] }],
                });
                if (r.canceled || !r.filePath) return { cancelado: true };
                destino = r.filePath;
            }

            const fontes = await reunirDiagnostico();
            const r = await diagnostico.salvar(destino, fontes);
            avisar(`Diagnóstico salvo em ${r.caminho}`, 'ok');
            return r;
        } catch (erro) {
            console.error('diagnostico:', erro);
            return { erro: erro.message };
        }
    });

    ipcMain.handle('app:abrir-arquivo', async (_e, caminho) => {
        if (!caminho) return false;
        const erro = await shell.openPath(caminho);
        if (erro) shell.showItemInFolder(caminho);
        return true;
    });

    ipcMain.handle('qbit:registro', () => ({
        estado: estadoQbit,
        binario: paths.binarioQbit(),
        porta: qbit.porta || null,
        ultimoErro: qbit.ultimoErro(),
        linhas: qbit.registro(),
    }));

    ipcMain.handle('biblioteca:listar', () => metadados.aplicar(library.listar()));

    // -------------------------------------------------- pastas e metadados
    ipcMain.handle('biblioteca:pastas', () => metadados.pastasParaInterface());

    ipcMain.handle('biblioteca:criar-pasta', (_e, dados) => metadados.criarPasta(dados || {}));

    ipcMain.handle('biblioteca:editar-pasta', (_e, id, campos) => metadados.editarPasta(id, campos || {}));

    ipcMain.handle('biblioteca:remover-pasta', (_e, id) => metadados.removerPasta(id));

    ipcMain.handle('biblioteca:editar-titulo', async (_e, hash, campos) => {
        metadados.editarTitulo(hash, campos || {});
        await atualizar();
        return true;
    });

    ipcMain.handle('biblioteca:editar-arquivo', async (_e, hash, caminho, nome) => {
        metadados.editarArquivo(hash, caminho, nome);
        await atualizar();
        return true;
    });

    ipcMain.handle('biblioteca:capa', async (_e, alvo, origem) => {
        try {
            if (origem && origem.escolher) {
                const r = await dialog.showOpenDialog(janela, {
                    title: 'Escolher a imagem',
                    properties: ['openFile'],
                    filters: [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'] }],
                });
                if (r.canceled || !r.filePaths.length) return { cancelado: true };
                origem = { arquivo: r.filePaths[0] };
            }
            await metadados.definirCapa(alvo, origem);
            await atualizar();
            return { ok: true };
        } catch (erro) {
            return { erro: erro.message };
        }
    });

    ipcMain.handle('biblioteca:remover-capa', async (_e, alvo) => {
        metadados.removerCapa(alvo);
        await atualizar();
        return true;
    });

    ipcMain.handle('app:abrir-pasta', (_e, caminho) => {
        if (!caminho) return false;
        shell.showItemInFolder(caminho);
        return true;
    });

    ipcMain.handle('app:info', () => ({
        versao: app.getVersion(),
        electron: process.versions.electron,
        plataforma: process.platform,
        empacotado: app.isPackaged,
        qbit: qbit.ativo ? `127.0.0.1:${qbit.porta}` : 'parado',
        webui: qbitPronto ? `http://127.0.0.1:${qbit.porta}` : null,
        qbitUsuario: qbit.usuario(),
        qbitCredencialTemporaria: qbit.usandoCredencialTemporaria(),
        dados: app.getPath('userData'),
        api: api.base(),
        // o token nunca sai daqui: so a forma mascarada e o id da instalacao
        conexao: credenciais.resumo(),
        // caminhos dos binarios embutidos: a primeira coisa a conferir quando
        // o qBittorrent ou o player nao sobem
        binarios: { qbit: paths.binarioQbit(), mpv: paths.binarioMpv() },
        videoAcoplado: podeEmbutirVideo,
    }));

    // ------------------------------------------------------------- player
    ipcMain.handle('player:abrir', async (_e, { hash, caminho }) => {
        const cfg = config.ler();
        const posicao = hash ? library.posicaoDe(hash, caminho) : 0;
        const r = await player.abrir({
            caminho,
            posicao,
            volume: cfg.volume,
            janelaSeparada: cfg.videoEmJanelaSeparada,
        });
        abaAtual = 'player';
        aplicarLayout();
        return Object.assign({ posicao }, r);
    });

    ipcMain.handle('player:comando', async (_e, args) => {
        try {
            return await player.comando(...args);
        } catch (erro) {
            return { erro: erro.message };
        }
    });

    ipcMain.handle('player:faixas', () => player.faixas());

    ipcMain.handle('player:diagnostico', async () => {
        const d = await player.diagnostico();
        d.videoAcoplavel = podeEmbutirVideo;
        d.areaDeVideoPedida = retangulos.player;
        d.janelaPrincipal = janela && !janela.isDestroyed() ? janela.getContentBounds() : null;
        return d;
    });

    ipcMain.handle('player:fechar', async () => {
        await player.fechar();
        return true;
    });

    ipcMain.on('player:posicao', (_e, { hash, caminho, segundos, duracao }) => {
        if (hash && caminho) library.salvarPosicao(hash, caminho, segundos, duracao);
    });

    // ------------------------------------------------------------- config
    ipcMain.handle('config:ler', () => config.ler());

    ipcMain.handle('config:gravar', async (_e, parcial) => {
        const antes = config.ler();
        const trocouCredencial =
            parcial &&
            (('qbitUsuario' in parcial && parcial.qbitUsuario !== antes.qbitUsuario) ||
                ('qbitSenha' in parcial && parcial.qbitSenha !== antes.qbitSenha));

        const novo = config.gravar(parcial);
        if (parcial && parcial.apiUrl) {
            api.configurar(novo.apiUrl);
            capasEmCache.clear();
        }
        conexao.configurar({ config: novo, aoEstado: publicarConexao });

        // As credenciais entram no qBittorrent.conf, que so e lido na subida:
        // sem religar, o que o usuario acabou de digitar nao valeria nada.
        if (trocouCredencial) {
            avisar('Religando o qBittorrent com as novas credenciais…', 'info');
            await reiniciarQbit();
            return novo;
        }

        if (qbitPronto) await qbit.aplicarPreferencias(novo);
        return novo;
    });

    ipcMain.handle('config:escolher-pasta', async () => {
        const r = await dialog.showOpenDialog(janela, {
            title: 'Onde salvar os downloads',
            properties: ['openDirectory', 'createDirectory'],
            defaultPath: config.ler().pastaDownloads,
        });
        if (r.canceled || !r.filePaths.length) return null;
        const novo = config.gravar({ pastaDownloads: r.filePaths[0] });
        if (qbitPronto) await qbit.aplicarPreferencias(novo);
        return novo;
    });
}

// --------------------------------------------------------------------------
// Ciclo de vida

/** Junta o que o modulo de diagnostico precisa das outras pecas do app. */
async function reunirDiagnostico() {
    let dadosPlayer = null;
    try {
        dadosPlayer = await player.diagnostico();
    } catch (erro) {
        dadosPlayer = { erro: erro.message };
    }

    const estadoConexao = conexao.estado();

    return {
        config: config.ler(),
        estadoQbit,
        // O token JAMAIS entra aqui: este arquivo nasceu para ser anexado num
        // relato de problema. Vai so a forma mascarada e o id da instalacao.
        conexao: {
            fase: estadoConexao.fase,
            erro: estadoConexao.erro,
            mensagem: estadoConexao.mensagem,
            verificadoEm: estadoConexao.verificadoEm,
            aplicativo: estadoConexao.aplicativo,
            gemas: estadoConexao.gemas,
            temPasskey: estadoConexao.conta ? estadoConexao.conta.tem_passkey : null,
            api: api.base(),
            credenciais: credenciais.resumo(),
        },
        qbit: {
            ativo: qbit.ativo,
            porta: qbit.porta,
            ultimoErro: qbit.ultimoErro(),
            registro: qbit.registro(),
        },
        player: dadosPlayer,
        fila: library.snapshot(),
        biblioteca: library.listar(),
        caminhos: {
            binarioQbit: paths.binarioQbit(),
            binarioMpv: paths.binarioMpv(),
            perfilQbit: path.join(app.getPath('userData'), 'qbittorrent'),
        },
        janela:
            janela && !janela.isDestroyed()
                ? {
                      limites: janela.getContentBounds(),
                      telaCheia: janela.isFullScreen(),
                      abaAtual,
                      retangulos,
                  }
                : null,
        video: { podeEmbutir: podeEmbutirVideo },
    };
}

let subindoQbit = false;

/** Religa o qBittorrent do zero (o subir() derruba a instancia anterior). */
async function reiniciarQbit() {
    qbitPronto = false;
    subindoQbit = false;
    estadoQbit.tentativa = 0;
    await subirQbit();
}

async function subirQbit() {
    if (subindoQbit || qbitPronto) return;
    subindoQbit = true;
    estadoQbit.tentativa++;
    publicarEstadoQbit('iniciando');
    try {
        await qbit.iniciar(config.ler(), (linha) => console.log('[qbit]', linha));
        qbitPronto = true;
        publicarEstadoQbit('pronto');
        avisar('qBittorrent pronto.', 'ok');
        iniciarMonitor();
        await atualizar();
        await despejarPendentes();
    } catch (erro) {
        console.error(erro);
        publicarEstadoQbit('erro', erro.message);
        avisar(`Não consegui iniciar o qBittorrent: ${erro.message}`, 'erro');
        // Falha transitoria (porta tomada no intervalo entre escolher e usar,
        // executavel ainda preso no antivirus) costuma passar na segunda.
        if (estadoQbit.tentativa < 3 && !encerrando) {
            setTimeout(() => {
                subindoQbit = false;
                subirQbit();
            }, 5000);
        }
    } finally {
        subindoQbit = false;
    }
}

const instanciaUnica = app.requestSingleInstanceLock();
if (!instanciaUnica) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (janela) {
            if (janela.isMinimized()) janela.restore();
            janela.focus();
        }
    });

    app.whenReady().then(() => {
        protocol.handle('capa', (requisicao) => {
            const nome = decodeURIComponent(new URL(requisicao.url).pathname.replace(/^\//, ''));
            const capa = metadados.lerCapa(nome);
            if (!capa) return new Response('', { status: 404 });
            return new Response(capa.buffer, {
                headers: { 'content-type': capa.mime, 'cache-control': 'no-cache' },
            });
        });

        protocol.handle('acervo', async (requisicao) => {
            const url = new URL(requisicao.url);
            if (url.hostname !== 'capa') return new Response('', { status: 404 });
            const item = decodeURIComponent(url.pathname.replace(/^\//, ''));
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(item)) return new Response('', { status: 400 });
            const capa = await capaDoAcervo(item);
            if (!capa) return new Response('', { status: 404 });
            return new Response(capa.bytes, {
                headers: { 'content-type': capa.tipo, 'cache-control': 'no-cache' },
            });
        });

        registrarIpc();
        criarJanela();

        const cfg = config.ler();
        api.configurar(cfg.apiUrl);
        conexao.configurar({ config: cfg, aoEstado: publicarConexao });
        conexao.iniciar(cfg).then(publicarConexao);

        subirQbit();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) criarJanela();
        });
    });
}

app.on('window-all-closed', () => app.quit());

app.on('before-quit', (evento) => {
    if (encerrando) return;
    evento.preventDefault();
    encerrando = true;
    clearInterval(monitor);
    conexao.encerrar();
    (async () => {
        try {
            await player.fechar();
        } catch {
            /* segue */
        }
        try {
            await qbit.encerrar();
        } catch {
            /* segue */
        }
        app.exit(0);
    })();
});
