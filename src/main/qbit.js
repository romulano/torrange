'use strict';
/**
 * Gerencia o qbittorrent-nox embutido:
 *  - escolhe uma porta livre e gera uma senha nova a cada execucao
 *  - escreve/atualiza o qBittorrent.conf num perfil proprio do app
 *  - sobe o processo em background e fala com ele pela WebUI API (v2)
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const { binarioQbit, pastaDados, garantirPasta } = require('./paths');

const CATEGORIA = 'torrange';
const USUARIO = 'torrange';

let processo = null;
let porta = 0;
let senha = '';
// O qBittorrent 5.x nomeia o cookie de sessao como QBT_SID_<porta> (antes era
// so SID), entao guardamos o par "nome=valor" inteiro em vez de so o valor.
let cookieSessao = '';
let encerrando = false;

// --------------------------------------------------------------------------
// Infra

function portaLivre() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.unref();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
    });
}

/** Hash no formato que o qBittorrent grava no .conf: PBKDF2-HMAC-SHA512, 100k iteracoes. */
function hashSenha(texto) {
    const sal = crypto.randomBytes(16);
    const chave = crypto.pbkdf2Sync(texto, sal, 100000, 64, 'sha512');
    return `@ByteArray(${sal.toString('base64')}:${chave.toString('base64')})`;
}

/**
 * Atualiza chaves de um INI preservando tudo o que ja existe
 * (o usuario pode ter mexido nas preferencias pelo proprio qBittorrent).
 */
function ajustarIni(texto, mudancas) {
    const linhas = texto ? texto.split(/\r?\n/) : [];
    const pendentes = new Map();
    for (const [secao, pares] of Object.entries(mudancas)) {
        pendentes.set(secao, new Map(Object.entries(pares)));
    }

    let secaoAtual = null;
    const saida = [];

    const despejar = (secao) => {
        const restantes = pendentes.get(secao);
        if (!restantes) return;
        for (const [chave, valor] of restantes) saida.push(`${chave}=${valor}`);
        pendentes.delete(secao);
    };

    for (const linha of linhas) {
        const cabecalho = linha.match(/^\s*\[([^\]]+)\]\s*$/);
        if (cabecalho) {
            if (secaoAtual) despejar(secaoAtual);
            secaoAtual = cabecalho[1];
            saida.push(linha);
            continue;
        }
        const par = linha.match(/^([^=]+)=(.*)$/);
        const restantes = secaoAtual ? pendentes.get(secaoAtual) : null;
        if (par && restantes && restantes.has(par[1].trim())) {
            const chave = par[1].trim();
            saida.push(`${chave}=${restantes.get(chave)}`);
            restantes.delete(chave);
            continue;
        }
        saida.push(linha);
    }
    if (secaoAtual) despejar(secaoAtual);

    // secoes que ainda nao existiam no arquivo
    for (const [secao, pares] of pendentes) {
        if (!pares.size) continue;
        saida.push('', `[${secao}]`);
        for (const [chave, valor] of pares) saida.push(`${chave}=${valor}`);
    }

    return saida.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function escreverConfig(pastaPerfil, pastaDownloads) {
    const arquivo = path.join(pastaPerfil, 'qBittorrent', 'config', 'qBittorrent.conf');
    garantirPasta(path.dirname(arquivo));

    let atual = '';
    try {
        atual = fs.readFileSync(arquivo, 'utf8');
    } catch {
        atual = '';
    }

    const caminho = pastaDownloads.replace(/\\/g, '/');
    const novo = ajustarIni(atual, {
        LegalNotice: { Accepted: 'true' },
        Preferences: {
            'WebUI\\Enabled': 'true',
            'WebUI\\Address': '127.0.0.1',
            'WebUI\\Port': String(porta),
            'WebUI\\Username': USUARIO,
            'WebUI\\Password_PBKDF2': `"${hashSenha(senha)}"`,
            'WebUI\\LocalHostAuth': 'true',
            'WebUI\\CSRFProtection': 'false',
            'WebUI\\ClickjackingProtection': 'false',
            'WebUI\\HostHeaderValidation': 'false',
            'WebUI\\UseUPnP': 'false',
            'General\\Locale': 'pt_BR',
            'Downloads\\SavePath': caminho,
            'Downloads\\StartInPause': 'false',
        },
        BitTorrent: {
            'Session\\DefaultSavePath': caminho,
            'Session\\QueueingSystemEnabled': 'false',
            'Session\\GlobalMaxRatio': '-1',
        },
        Application: {
            'FileLogger\\Enabled': 'true',
        },
    });

    fs.writeFileSync(arquivo, novo, 'utf8');
}

// --------------------------------------------------------------------------
// Cliente HTTP da WebUI API

function requisicao(caminho, { metodo = 'GET', corpo = null, tipo = null } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port: porta,
                path: caminho,
                method: metodo,
                headers: Object.assign(
                    {
                        Referer: `http://127.0.0.1:${porta}`,
                        Origin: `http://127.0.0.1:${porta}`,
                    },
                    cookieSessao ? { Cookie: cookieSessao } : {},
                    tipo ? { 'Content-Type': tipo } : {},
                    corpo ? { 'Content-Length': Buffer.byteLength(corpo) } : {}
                ),
            },
            (res) => {
                const pedacos = [];
                res.on('data', (d) => pedacos.push(d));
                res.on('end', () => {
                    const texto = Buffer.concat(pedacos).toString('utf8');
                    for (const bruto of res.headers['set-cookie'] || []) {
                        const par = bruto.split(';')[0].trim();
                        if (/^(QBT_SID_\d+|SID)=/.test(par)) {
                            cookieSessao = par;
                            break;
                        }
                    }
                    resolve({ status: res.statusCode, texto });
                });
            }
        );
        req.on('error', reject);
        if (corpo) req.write(corpo);
        req.end();
    });
}

/** Chamada autenticada: se a sessao expirou (403), refaz o login e tenta de novo. */
async function api(caminho, opcoes = {}) {
    let r = await requisicao(caminho, opcoes);
    if (r.status === 403) {
        await login();
        r = await requisicao(caminho, opcoes);
    }
    if (r.status >= 400) {
        throw new Error(`qBittorrent ${caminho} -> HTTP ${r.status} ${r.texto.slice(0, 200)}`);
    }
    return r.texto;
}

async function apiJson(caminho, opcoes) {
    const texto = await api(caminho, opcoes);
    return texto ? JSON.parse(texto) : null;
}

function formulario(campos) {
    return new URLSearchParams(campos).toString();
}

function postForm(caminho, campos) {
    return api(caminho, {
        metodo: 'POST',
        corpo: formulario(campos),
        tipo: 'application/x-www-form-urlencoded',
    });
}

/** Monta um corpo multipart/form-data (usado para enviar o .torrent). */
function multipart(campos, arquivo) {
    const limite = '----torrange' + crypto.randomBytes(12).toString('hex');
    const partes = [];
    for (const [chave, valor] of Object.entries(campos)) {
        if (valor === undefined || valor === null) continue;
        partes.push(
            Buffer.from(
                `--${limite}\r\nContent-Disposition: form-data; name="${chave}"\r\n\r\n${valor}\r\n`
            )
        );
    }
    if (arquivo) {
        partes.push(
            Buffer.from(
                `--${limite}\r\n` +
                    `Content-Disposition: form-data; name="torrents"; filename="${arquivo.nome}"\r\n` +
                    'Content-Type: application/x-bittorrent\r\n\r\n'
            ),
            arquivo.dados,
            Buffer.from('\r\n')
        );
    }
    partes.push(Buffer.from(`--${limite}--\r\n`));
    return { corpo: Buffer.concat(partes), tipo: `multipart/form-data; boundary=${limite}` };
}

async function login() {
    cookieSessao = '';
    const r = await requisicao('/api/v2/auth/login', {
        metodo: 'POST',
        corpo: formulario({ username: USUARIO, password: senha }),
        tipo: 'application/x-www-form-urlencoded',
    });
    // 5.x responde 204 (sem corpo) com o cookie de sessao; 4.x respondia
    // 200 "Ok.". Senha errada da 401 nas duas.
    const autenticou = r.status === 204 || (r.status === 200 && /Ok/i.test(r.texto));
    if (!autenticou) {
        const motivo = r.status === 401 || /Fails/i.test(r.texto) ? 'usuario ou senha recusados' : `HTTP ${r.status}`;
        throw new Error(`Falha ao autenticar no qBittorrent: ${motivo}`);
    }
    if (!cookieSessao) {
        throw new Error('O qBittorrent aceitou o login mas nao enviou o cookie de sessao.');
    }

    // confirma que a sessao realmente vale para as demais chamadas
    const teste = await requisicao('/api/v2/app/version');
    if (teste.status !== 200) {
        throw new Error(`A WebUI recusou a sessao (HTTP ${teste.status}).`);
    }
}

function esperar(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function aguardarWebUI(tentativas = 120) {
    for (let i = 0; i < tentativas; i++) {
        try {
            const r = await requisicao('/api/v2/app/version');
            if (r.status === 200 || r.status === 403) return;
        } catch {
            /* ainda subindo */
        }
        if (processo && processo.exitCode !== null) {
            throw new Error(`qbittorrent-nox encerrou antes de subir (codigo ${processo.exitCode})`);
        }
        await esperar(250);
    }
    throw new Error('qbittorrent-nox nao respondeu a tempo');
}

// --------------------------------------------------------------------------
// Ciclo de vida

async function iniciar(config, aoLog = () => {}) {
    const executavel = binarioQbit();
    if (!fs.existsSync(executavel)) {
        throw new Error(
            `qbittorrent-nox nao encontrado em ${executavel}. Rode "npm run binaries" antes.`
        );
    }

    const perfil = garantirPasta(pastaDados('qbittorrent'));
    garantirPasta(config.pastaDownloads);

    porta = await portaLivre();
    senha = crypto.randomBytes(24).toString('base64url');
    escreverConfig(perfil, config.pastaDownloads);

    if (process.platform !== 'win32') {
        try {
            fs.chmodSync(executavel, 0o755);
        } catch {
            /* ja pode estar executavel */
        }
    }

    processo = spawn(
        executavel,
        [`--profile=${perfil}`, `--webui-port=${porta}`, '--confirm-legal-notice'],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );

    processo.stdout.on('data', (d) => aoLog(String(d).trim()));
    processo.stderr.on('data', (d) => aoLog(String(d).trim()));
    processo.on('exit', (codigo) => {
        if (!encerrando) aoLog(`qbittorrent-nox saiu inesperadamente (codigo ${codigo})`);
        processo = null;
    });

    await aguardarWebUI();
    await login();

    // categoria propria para nao misturar com torrents que o usuario ja tenha
    try {
        await postForm('/api/v2/torrents/createCategory', {
            category: CATEGORIA,
            savePath: config.pastaDownloads,
        });
    } catch {
        /* ja existe */
    }

    await aplicarPreferencias(config);
    aoLog(`qBittorrent no ar em 127.0.0.1:${porta}`);
    return { porta };
}

async function aplicarPreferencias(config) {
    const prefs = {
        save_path: config.pastaDownloads,
        dl_limit: Number(config.limiteDownload) * 1024 || 0,
        up_limit: Number(config.limiteUpload) * 1024 || 0,
        queueing_enabled: false,
    };
    try {
        await postForm('/api/v2/app/setPreferences', { json: JSON.stringify(prefs) });
    } catch (e) {
        /* nao e fatal */
    }
}

async function encerrar() {
    encerrando = true;
    try {
        if (porta && cookieSessao) await requisicao('/api/v2/app/shutdown', { metodo: 'POST' });
    } catch {
        /* segue para o kill */
    }
    if (processo) {
        const p = processo;
        await esperar(700);
        if (p.exitCode === null) {
            try {
                p.kill('SIGTERM');
            } catch {
                /* ja morreu */
            }
            await esperar(1500);
            if (p.exitCode === null) {
                try {
                    p.kill('SIGKILL');
                } catch {
                    /* ja morreu */
                }
            }
        }
        processo = null;
    }
}

// --------------------------------------------------------------------------
// Operacoes

/** Adiciona um .torrent (Buffer) ou um magnet. Devolve o hash quando consegue identificar. */
async function adicionar({ dados, nome, magnet }, config) {
    const campos = {
        category: CATEGORIA,
        savepath: config.pastaDownloads,
        autoTMM: 'false',
        paused: 'false',
        sequentialDownload: config.downloadSequencial ? 'true' : 'false',
        firstLastPiecePrio: config.downloadSequencial ? 'true' : 'false',
    };
    if (magnet) campos.urls = magnet;

    const antes = new Set((await listar()).map((t) => t.hash));

    const { corpo, tipo } = multipart(campos, dados ? { nome: nome || 'arquivo.torrent', dados } : null);
    const resposta = await api('/api/v2/torrents/add', { metodo: 'POST', corpo, tipo });
    if (/Fails/i.test(resposta)) {
        throw new Error('O qBittorrent recusou o torrent (arquivo invalido ou ja existente).');
    }

    // o endpoint /add nao devolve o hash; descobre comparando a lista
    for (let i = 0; i < 20; i++) {
        await esperar(200);
        const agora = await listar();
        const novo = agora.find((t) => !antes.has(t.hash));
        if (novo) return novo;
    }
    return null;
}

async function listar() {
    try {
        return (await apiJson(`/api/v2/torrents/info?category=${CATEGORIA}`)) || [];
    } catch {
        return [];
    }
}

function arquivosDe(hash) {
    return apiJson(`/api/v2/torrents/files?hash=${hash}`);
}

async function pausar(hash) {
    try {
        await postForm('/api/v2/torrents/stop', { hashes: hash });
    } catch {
        await postForm('/api/v2/torrents/pause', { hashes: hash }); // qBittorrent < 5.0
    }
}

async function retomar(hash) {
    try {
        await postForm('/api/v2/torrents/start', { hashes: hash });
    } catch {
        await postForm('/api/v2/torrents/resume', { hashes: hash });
    }
}

function remover(hash, apagarArquivos) {
    return postForm('/api/v2/torrents/delete', {
        hashes: hash,
        deleteFiles: apagarArquivos ? 'true' : 'false',
    });
}

function sequencial(hash) {
    return postForm('/api/v2/torrents/toggleSequentialDownload', { hashes: hash });
}

module.exports = {
    iniciar,
    encerrar,
    adicionar,
    listar,
    arquivosDe,
    pausar,
    retomar,
    remover,
    sequencial,
    aplicarPreferencias,
    CATEGORIA,
    get porta() {
        return porta;
    },
    get ativo() {
        return !!processo;
    },
};
