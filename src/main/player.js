'use strict';
/**
 * Player: sobe o mpv acoplado a uma janela filha posicionada sobre a area de
 * video da interface (--wid) e conversa com ele por IPC em JSON.
 *
 * O mpv resolve o que o Chromium nao resolve: MKV, H.265, AC3/DTS/TrueHD,
 * multiplas faixas de audio e legendas embutidas (inclusive PGS e ASS).
 */
const { BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { binarioMpv, pastaDados } = require('./paths');

// Propriedades que o mpv nos avisa quando mudam.
const OBSERVADAS = [
    'time-pos', 'duration', 'pause', 'volume', 'mute', 'track-list',
    'media-title', 'eof-reached', 'idle-active', 'demuxer-cache-time',
    'paused-for-cache', 'speed', 'sub-delay', 'audio-delay', 'aid', 'sid',
];

let janelaPrincipal = null;
let janelaHost = null;
let processo = null;
let socket = null;
let buffer = '';
let proximoId = 1;
const pendentes = new Map();
let ultimoRetangulo = null;
let aoAtualizar = () => {};
let embutido = true;
let estado = {};
let ultimoWid = null;

// Ultimas linhas do mpv. Num app empacotado o console do processo principal nao
// esta a vista, e sem isto uma falha de saida de video vira "tela preta" sem
// explicacao. O painel de diagnostico em Ajustes mostra este log.
const LOG_MPV = [];
function anotar(texto) {
    LOG_MPV.push(`${new Date().toLocaleTimeString()}  ${texto}`);
    if (LOG_MPV.length > 80) LOG_MPV.shift();
}

// Definido pelo processo principal, que sabe em qual plataforma de janelas o
// Electron acabou subindo (X11 permite --wid; Wayland puro nao).
let embutirPermitido = process.platform === 'win32';

function idJanelaNativa(janela) {
    const buf = janela.getNativeWindowHandle();
    if (process.platform === 'win32') {
        return buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
    }
    return String(buf.readUInt32LE(0));
}

function caminhoSocket() {
    const id = crypto.randomBytes(6).toString('hex');
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\torrange-mpv-${id}`
        : path.join(os.tmpdir(), `torrange-mpv-${id}.sock`);
}

/** input.conf minimo: o resto dos controles fica na interface do app. */
function escreverInputConf() {
    const arquivo = pastaDados('mpv', 'input.conf');
    fs.writeFileSync(
        arquivo,
        [
            'MBTN_LEFT cycle pause',
            'MBTN_LEFT_DBL script-message torrange tela-cheia',
            'WHEEL_UP add volume 5',
            'WHEEL_DOWN add volume -5',
            '',
        ].join('\n'),
        'utf8'
    );
    return arquivo;
}

function criarJanelaHost() {
    janelaHost = new BrowserWindow({
        parent: janelaPrincipal,
        show: false,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        skipTaskbar: true,
        focusable: false,
        hasShadow: false,
        backgroundColor: '#000000',
        acceptFirstMouse: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    janelaHost.setMenu && janelaHost.setMenu(null);
    janelaHost.loadURL('data:text/html,<body style="margin:0;background:#000"></body>');
    return janelaHost;
}

// --------------------------------------------------------------------------
// IPC com o mpv

function conectar(caminho, proc, tentativas = 60) {
    return new Promise((resolve, reject) => {
        const tentar = (restantes) => {
            const s = net.connect(caminho);
            s.once('connect', () => resolve(s));
            s.once('error', () => {
                s.destroy();
                // se o mpv ja morreu nao adianta insistir
                if (proc && proc.exitCode !== null) {
                    return reject(new Error('o mpv encerrou antes de aceitar comandos'));
                }
                if (restantes <= 0) return reject(new Error('nao consegui falar com o mpv'));
                setTimeout(() => tentar(restantes - 1), 100);
            });
        };
        tentar(tentativas);
    });
}

function tratarLinha(linha) {
    let msg;
    try {
        msg = JSON.parse(linha);
    } catch {
        return;
    }

    if (msg.request_id !== undefined && pendentes.has(msg.request_id)) {
        const { resolve, reject } = pendentes.get(msg.request_id);
        pendentes.delete(msg.request_id);
        if (msg.error === 'success') resolve(msg.data);
        else reject(new Error(msg.error));
        return;
    }

    if (msg.event === 'property-change') {
        estado[msg.name] = msg.data;
        aoAtualizar({ tipo: 'propriedade', nome: msg.name, valor: msg.data });
        return;
    }
    if (msg.event === 'client-message' && msg.args && msg.args[0] === 'torrange') {
        aoAtualizar({ tipo: 'mensagem', nome: msg.args[1] });
        return;
    }
    if (msg.event) aoAtualizar({ tipo: 'evento', nome: msg.event });
}

function comando(...args) {
    if (!socket) return Promise.reject(new Error('player nao esta aberto'));
    const id = proximoId++;
    return new Promise((resolve, reject) => {
        pendentes.set(id, { resolve, reject });
        socket.write(JSON.stringify({ command: args, request_id: id }) + '\n');
        setTimeout(() => {
            if (pendentes.has(id)) {
                pendentes.delete(id);
                reject(new Error('mpv nao respondeu'));
            }
        }, 5000);
    });
}

// --------------------------------------------------------------------------
// Ciclo de vida

function configurar(janela, opcoes, callback) {
    janelaPrincipal = janela;
    embutirPermitido = !!(opcoes && opcoes.podeEmbutir);
    aoAtualizar = callback || (() => {});

    // a janela do mpv acompanha a janela principal
    for (const evento of ['move', 'resize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
        janela.on(evento, () => aplicarRetangulo());
    }
}

/** Argumentos fixos do mpv (tudo menos o --wid, que depende da janela). */
function argumentosMpv({ caminho, posicao, volume, soquete }) {
    return [
        '--no-config',
        `--input-conf=${escreverInputConf()}`,
        `--input-ipc-server=${soquete}`,
        '--idle=yes',
        '--force-window=yes',
        '--keep-open=yes',
        '--no-input-terminal',
        '--msg-level=all=warn,vo=info,ao=info',
        '--osc=no',
        '--osd-level=1',
        '--hwdec=auto-safe',
        // A lista de saidas de video e por plataforma: "x11" so existe no Linux.
        // Passar um VO inexistente faz o mpv ficar sem imagem (audio e relogio
        // continuam correndo) -- foi o que deu tela preta no Windows.
        process.platform === 'win32' ? '--vo=gpu,direct3d' : '--vo=gpu,x11',
        '--sub-auto=fuzzy',
        '--audio-file-auto=fuzzy',
        '--sub-visibility=yes',
        '--alang=pt-BR,pt,por,eng,en',
        '--slang=pt-BR,pt,por,eng,en',
        // arquivo ainda sendo baixado: buffer generoso
        '--cache=yes',
        '--cache-secs=60',
        '--demuxer-max-bytes=400MiB',
        '--demuxer-readahead-secs=30',
        `--volume=${Math.max(0, Math.min(130, volume))}`,
        `--start=${Math.max(0, Math.floor(posicao))}`,
        caminho,
    ];
}

/**
 * Prepara a janela filha e devolve o id nativo dela.
 *
 * A janela PRECISA estar visivel antes de lermos o handle: no X11 a janela
 * nativa so passa a existir quando e exibida, e um --wid invalido faz o mpv
 * morrer na hora com "BadWindow (invalid Window parameter)".
 */
async function prepararHost() {
    if (!janelaHost || janelaHost.isDestroyed()) criarJanelaHost();
    if (ultimoRetangulo) aplicarRetangulo();

    if (!janelaHost.isVisible()) {
        janelaHost.showInactive();
        await new Promise((r) => setTimeout(r, 150));
    }

    const id = idJanelaNativa(janelaHost);
    return id && id !== '0' ? id : null;
}

/** Sobe o mpv e conecta no IPC. Devolve false se nao conseguiu. */
async function subirMpv({ caminho, posicao, volume, comWid }) {
    const soquete = caminhoSocket();
    const args = argumentosMpv({ caminho, posicao, volume, soquete });
    const ambiente = Object.assign({}, process.env);

    if (comWid) {
        const wid = await prepararHost();
        if (!wid) {
            anotar('nao consegui um id de janela valido; abrindo em janela separada');
            return false;
        }
        ultimoWid = wid;
        args.unshift(`--wid=${wid}`);
        // o --wid so existe no X11: se a sessao e Wayland, tira a variavel para
        // o mpv nao tentar falar direto com o compositor
        if (process.platform !== 'win32') delete ambiente.WAYLAND_DISPLAY;
    }

    const proc = spawn(binarioMpv(), args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        env: ambiente,
    });

    anotar(`mpv iniciado ${comWid ? `acoplado (wid=${ultimoWid})` : 'em janela separada'}`);

    let erroMpv = '';
    proc.stderr.on('data', (d) => {
        for (const linha of String(d).split('\n')) {
            const texto = linha.trim();
            if (!texto) continue;
            erroMpv = texto;
            anotar(texto);
            aoAtualizar({ tipo: 'log', texto });
        }
    });

    let s;
    try {
        s = await conectar(soquete, proc);
    } catch (erro) {
        try {
            proc.kill();
        } catch {
            /* ja morreu */
        }
        if (comWid) return false; // deixa o chamador tentar sem acoplar
        throw new Error(erroMpv ? `mpv: ${erroMpv}` : erro.message);
    }

    processo = proc;
    socket = s;
    proc.on('exit', () => {
        processo = null;
        aoAtualizar({ tipo: 'evento', nome: 'encerrado' });
    });
    return true;
}

async function abrir({ caminho, posicao = 0, volume = 100, janelaSeparada = false }) {
    const executavel = binarioMpv();
    if (!fs.existsSync(executavel)) {
        throw new Error(`mpv nao encontrado em ${executavel}. Rode "npm run binaries" antes.`);
    }
    if (!fs.existsSync(caminho)) {
        throw new Error(`Arquivo nao encontrado: ${caminho}`);
    }

    await fechar();
    estado = {};

    // Tenta acoplar a janela; se o sistema de janelas nao permitir, cai para
    // uma janela de video separada em vez de deixar o usuario sem player.
    LOG_MPV.length = 0;
    ultimoWid = null;
    embutido =
        embutirPermitido &&
        !janelaSeparada &&
        (await subirMpv({ caminho, posicao, volume, comWid: true }));
    if (!embutido) {
        if (janelaHost && !janelaHost.isDestroyed()) {
            janelaHost.destroy();
            janelaHost = null;
        }
        await subirMpv({ caminho, posicao, volume, comWid: false });
    }

    buffer = '';
    socket.on('data', (d) => {
        buffer += d.toString('utf8');
        let corte;
        while ((corte = buffer.indexOf('\n')) >= 0) {
            const linha = buffer.slice(0, corte).trim();
            buffer = buffer.slice(corte + 1);
            if (linha) tratarLinha(linha);
        }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
        socket = null;
    });

    for (let i = 0; i < OBSERVADAS.length; i++) {
        comando('observe_property', i + 1, OBSERVADAS[i]).catch(() => {});
    }

    if (embutido) aplicarRetangulo();

    return { embutido };
}

/** Posiciona a janela do mpv sobre a area de video informada pela interface. */
function definirRetangulo(retangulo) {
    ultimoRetangulo = retangulo;
    aplicarRetangulo();
}

function aplicarRetangulo() {
    if (!embutido || !janelaHost || janelaHost.isDestroyed() || !ultimoRetangulo) return;
    if (!janelaPrincipal || janelaPrincipal.isDestroyed()) return;
    const base = janelaPrincipal.getContentBounds();
    const r = ultimoRetangulo;
    janelaHost.setBounds({
        x: Math.round(base.x + r.x),
        y: Math.round(base.y + r.y),
        width: Math.max(1, Math.round(r.width)),
        height: Math.max(1, Math.round(r.height)),
    });
}

function esconder() {
    if (janelaHost && !janelaHost.isDestroyed() && janelaHost.isVisible()) janelaHost.hide();
}

function mostrar() {
    if (janelaHost && !janelaHost.isDestroyed() && processo) {
        aplicarRetangulo();
        janelaHost.showInactive();
    }
}

async function fechar() {
    for (const { reject } of pendentes.values()) reject(new Error('player fechado'));
    pendentes.clear();

    if (socket) {
        try {
            socket.write(JSON.stringify({ command: ['quit'] }) + '\n');
        } catch {
            /* ja caiu */
        }
        socket.end();
        socket = null;
    }
    if (processo) {
        const p = processo;
        setTimeout(() => {
            try {
                if (p.exitCode === null) p.kill();
            } catch {
                /* ja morreu */
            }
        }, 800);
        processo = null;
    }
    if (janelaHost && !janelaHost.isDestroyed()) {
        janelaHost.destroy();
        janelaHost = null;
    }
    estado = {};
}

/** Faixas de audio e legenda disponiveis no arquivo aberto. */
async function faixas() {
    // Nao da para confiar no cache do observe_property: o mpv publica uma lista
    // vazia enquanto ainda esta carregando, e [] e truthy. Perguntamos sempre.
    let lista;
    try {
        lista = await comando('get_property', 'track-list');
    } catch {
        lista = estado['track-list'] || [];
    }
    const mapear = (t) => ({
        id: t.id,
        titulo: t.title || '',
        idioma: t.lang || '',
        codec: t.codec || '',
        canais: t['demux-channel-count'] || null,
        padrao: !!t.default,
        selecionada: !!t.selected,
        externa: !!t.external,
    });
    return {
        audio: (lista || []).filter((t) => t.type === 'audio').map(mapear),
        legenda: (lista || []).filter((t) => t.type === 'sub').map(mapear),
    };
}

/**
 * Retrato do estado do player, para o painel de Ajustes.
 * O campo decisivo e o "vo": vazio significa que o mpv nao conseguiu criar
 * nenhuma saida de video -- e a imagem nao aparece por isso.
 */
async function diagnostico() {
    const perguntar = async (prop) => {
        try {
            return await comando('get_property', prop);
        } catch (erro) {
            return `<erro: ${erro.message}>`;
        }
    };

    const dados = {
        aberto: !!processo,
        embutido,
        wid: ultimoWid,
        plataforma: process.platform,
        binario: binarioMpv(),
        log: LOG_MPV.slice(),
    };

    if (processo && socket) {
        dados.vo = await perguntar('current-vo');
        dados.ao = await perguntar('current-ao');
        dados.hwdec = await perguntar('hwdec-current');
        dados.codec = await perguntar('video-codec');
        dados.resolucao = await perguntar('video-params/w');
        dados.alturaVideo = await perguntar('video-params/h');
        dados.tempo = await perguntar('time-pos');
        dados.pausado = await perguntar('pause');
        dados.tamanhoJanela = await perguntar('osd-dimensions');
    }

    if (janelaHost && !janelaHost.isDestroyed()) {
        dados.janelaMpv = janelaHost.getBounds();
        dados.janelaVisivel = janelaHost.isVisible();
    }
    dados.retanguloPedido = ultimoRetangulo;

    return dados;
}

module.exports = {
    configurar,
    abrir,
    diagnostico,
    fechar,
    comando,
    faixas,
    definirRetangulo,
    esconder,
    mostrar,
    get estado() {
        return estado;
    },
    get aberto() {
        return !!processo;
    },
};
