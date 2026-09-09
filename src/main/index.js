'use strict';
/**
 * Torrange - processo principal.
 *
 * Junta as tres pecas: o site (WebContentsView), o qBittorrent embutido
 * (processo filho + WebUI API) e o player mpv (janela nativa acoplada).
 */
const { app, BrowserWindow, Menu, Notification, dialog, ipcMain, shell } = require('electron');
const path = require('path');

const config = require('./config');
const paths = require('./paths');
const library = require('./library');
const player = require('./player');
const qbit = require('./qbit');
const site = require('./site');

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

const podeEmbutirVideo =
    process.platform === 'win32' || X11_NA_LINHA || (!SESSAO_WAYLAND && !!process.env.DISPLAY);

app.setName('Torrange');

let janela = null;
let monitor = null;
let abaAtual = 'site';
let retangulos = { site: null, player: null };
const progressoAnterior = new Map();
let encerrando = false;
let qbitPronto = false;

// --------------------------------------------------------------------------
// Utilidades

function enviar(canal, dados) {
    if (janela && !janela.isDestroyed()) janela.webContents.send(canal, dados);
}

function avisar(texto, tipo = 'info') {
    enviar('aviso', { texto, tipo });
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

    site.criar(janela, config, {
        aoTorrent: receberTorrent,
        aoMagnet: receberMagnet,
        aoNavegar: (dados) => enviar('site:navegou', dados),
        aoErro: (texto) => avisar(texto, 'erro'),
    });
}

function alternarTelaCheia() {
    if (!janela) return;
    janela.setFullScreen(!janela.isFullScreen());
    enviar('player:evento', { tipo: 'tela-cheia', valor: janela.isFullScreen() });
}

/** A interface manda os retangulos; aqui posicionamos as views nativas. */
function aplicarLayout() {
    if (!janela || janela.isDestroyed()) return;

    if (abaAtual === 'site' && retangulos.site) site.definirRetangulo(retangulos.site);
    else site.esconder();

    if (abaAtual === 'player' && retangulos.player && player.aberto) {
        player.definirRetangulo(retangulos.player);
        player.mostrar();
    } else {
        player.esconder();
    }
}

// --------------------------------------------------------------------------
// Entrada de torrents

async function receberTorrent({ dados, nome }) {
    if (!qbitPronto) {
        avisar('O qBittorrent ainda esta iniciando, tente de novo em instantes.', 'erro');
        return;
    }
    try {
        const t = await qbit.adicionar({ dados, nome }, config.ler());
        const titulo = (t && t.name) || (nome || '').replace(/\.torrent$/i, '');
        avisar(`Baixando: ${titulo}`, 'ok');
        notificar('Download iniciado', titulo);
        await atualizar();
    } catch (erro) {
        avisar(erro.message, 'erro');
    }
}

async function receberMagnet(magnet) {
    if (!qbitPronto) {
        avisar('O qBittorrent ainda esta iniciando, tente de novo em instantes.', 'erro');
        return;
    }
    try {
        const t = await qbit.adicionar({ magnet }, config.ler());
        avisar(`Baixando: ${(t && t.name) || 'magnet'}`, 'ok');
        await atualizar();
    } catch (erro) {
        avisar(erro.message, 'erro');
    }
}

// --------------------------------------------------------------------------
// Monitor

async function atualizar() {
    if (!qbitPronto || !janela || janela.isDestroyed()) return;
    try {
        const biblioteca = await library.sincronizar();
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

    ipcMain.on('site:navegar', (_e, acao, url) => site.navegar(acao, url || config.ler().siteUrl));

    ipcMain.handle('site:sair', async () => {
        await site.limparSessao();
        site.navegar('inicio', config.ler().siteUrl);
        return true;
    });

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

    ipcMain.handle('biblioteca:listar', () => library.listar());

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
        dados: app.getPath('userData'),
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
        const novo = config.gravar(parcial);
        if (qbitPronto) await qbit.aplicarPreferencias(novo);
        if (parcial && parcial.siteUrl) site.navegar('inicio', novo.siteUrl);
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

async function subirQbit() {
    try {
        await qbit.iniciar(config.ler(), (linha) => console.log('[qbit]', linha));
        qbitPronto = true;
        enviar('aviso', { texto: 'qBittorrent pronto.', tipo: 'ok' });
        iniciarMonitor();
        await atualizar();
    } catch (erro) {
        console.error(erro);
        avisar(`Nao consegui iniciar o qBittorrent: ${erro.message}`, 'erro');
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
        registrarIpc();
        criarJanela();
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
