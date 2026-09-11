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
const USUARIO_PADRAO = 'torrange';

/**
 * O NOME DO ARQUIVO DE CONFIGURACAO MUDA POR PLATAFORMA: o qBittorrent le
 * qBittorrent.ini no Windows e qBittorrent.conf no resto. Escrever so o .conf
 * fazia o qBittorrent do Windows ignorar TUDO o que o app configura -- subia
 * com os padroes dele, sem usuario nem senha nossos (gerava uma senha
 * temporaria para o usuario "admin") e com a WebUI escutando em todas as
 * interfaces em vez de so em 127.0.0.1. O login falhava, o app achava que o
 * qBittorrent nao tinha subido, e nada era baixado.
 *
 * Escrevemos os dois nomes: custa nada e funciona em qualquer combinacao.
 */
const NOMES_CONFIG =
    process.platform === 'win32'
        ? ['qBittorrent.ini', 'qBittorrent.conf']
        : ['qBittorrent.conf', 'qBittorrent.ini'];

let processo = null;
let porta = 0;
let senha = '';
// Ultimas linhas do qbittorrent-nox e o motivo da ultima falha. Quando ele nao
// sobe, isto e a unica pista que o usuario tem -- por isso fica guardado e vai
// para a tela, em vez de sumir num aviso de 4 segundos.
const registro = [];
const MAX_REGISTRO = 200;
let ultimoErro = '';
// O qBittorrent 5.x nomeia o cookie de sessao como QBT_SID_<porta> (antes era
// so SID), entao guardamos o par "nome=valor" inteiro em vez de so o valor.
let cookieSessao = '';
let encerrando = false;
let trocandoProcesso = false;
let usuario = USUARIO_PADRAO;
// Credenciais que o proprio qBittorrent anuncia na saida quando nao encontra
// as nossas -- rede de seguranca para nao ficarmos trancados do lado de fora.
let credencialTemporaria = null;
let usandoCredencialTemporaria = false;

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
    const pasta = path.join(pastaPerfil, 'qBittorrent', 'config');
    garantirPasta(pasta);
    const arquivos = NOMES_CONFIG.map((nome) => path.join(pasta, nome));

    // preserva o que o usuario ja tenha mexido, venha do arquivo que vier
    let atual = '';
    for (const arquivo of arquivos) {
        try {
            atual = fs.readFileSync(arquivo, 'utf8');
            break;
        } catch {
            /* tenta o proximo nome */
        }
    }

    const caminho = pastaDownloads.replace(/\\/g, '/');
    const novo = ajustarIni(atual, {
        LegalNotice: { Accepted: 'true' },
        Preferences: {
            'WebUI\\Enabled': 'true',
            'WebUI\\Address': '127.0.0.1',
            'WebUI\\Port': String(porta),
            'WebUI\\Username': usuario,
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

    for (const arquivo of arquivos) fs.writeFileSync(arquivo, novo, 'utf8');
    return arquivos;
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

/** Uma tentativa de login. Devolve o motivo da recusa, ou null se entrou. */
async function tentarLogin(nome, chave) {
    cookieSessao = '';
    const r = await requisicao('/api/v2/auth/login', {
        metodo: 'POST',
        corpo: formulario({ username: nome, password: chave }),
        tipo: 'application/x-www-form-urlencoded',
    });
    // 5.x responde 204 (sem corpo) com o cookie de sessao; 4.x respondia
    // 200 "Ok.". Senha errada da 401 nas duas.
    const autenticou = r.status === 204 || (r.status === 200 && /Ok/i.test(r.texto));
    if (!autenticou) {
        return r.status === 401 || /Fails/i.test(r.texto)
            ? 'usuario ou senha recusados'
            : `HTTP ${r.status}`;
    }
    if (!cookieSessao) return 'o qBittorrent aceitou o login mas nao enviou o cookie de sessao';
    return null;
}

async function login() {
    let motivo = await tentarLogin(usuario, senha);

    // Se ele nao leu a nossa configuracao, ainda assim anuncia na saida um
    // usuario e uma senha temporaria -- entramos por ali em vez de desistir.
    if (motivo && credencialTemporaria) {
        const alternativo = await tentarLogin(
            credencialTemporaria.usuario,
            credencialTemporaria.senha
        );
        if (!alternativo) {
            usuario = credencialTemporaria.usuario;
            senha = credencialTemporaria.senha;
            usandoCredencialTemporaria = true;
            anotar(
                `o qBittorrent nao aceitou as credenciais do app; entrei com a senha temporaria ` +
                    `que ele anunciou (usuario "${usuario}")`
            );
            motivo = null;
        }
    }

    if (motivo) throw new Error(`Falha ao autenticar no qBittorrent: ${motivo}`);

    // confirma que a sessao realmente vale para as demais chamadas
    const teste = await requisicao('/api/v2/app/version');
    if (teste.status !== 200) {
        throw new Error(`A WebUI recusou a sessao (HTTP ${teste.status}).`);
    }
}

/**
 * Le da saida do qbittorrent-nox o usuario e a senha temporaria que ele
 * anuncia quando sobe sem senha configurada. O texto sai traduzido, entao
 * casamos as duas formas e tambem uma bem frouxa.
 */
function lerCredencialAnunciada(texto) {
    const senhaAchada =
        /senha tempor[áa]ria[^:]*:\s*(\S+)/i.exec(texto) ||
        /temporary password[^:]*:\s*(\S+)/i.exec(texto) ||
        /password is[^:]*:\s*(\S+)/i.exec(texto);
    if (!senhaAchada) return;

    const nomeAchado =
        /nome de usu[áa]rio[^:]*:\s*(\S+)/i.exec(texto) ||
        /username is[^:]*:\s*(\S+)/i.exec(texto);

    credencialTemporaria = {
        usuario: nomeAchado ? nomeAchado[1].trim() : 'admin',
        senha: senhaAchada[1].trim(),
    };
}

function esperar(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function ultimasLinhas(quantas) {
    return registro.slice(-quantas).join(' | ');
}

function anotar(linha) {
    const texto = String(linha || '').trim();
    if (!texto) return;
    registro.push(`${new Date().toISOString().slice(11, 19)} ${texto}`);
    if (registro.length > MAX_REGISTRO) registro.splice(0, registro.length - MAX_REGISTRO);
}

async function aguardarWebUI(tentativas = 360) {
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

/** Qualquer falha na subida vira motivo guardado, para a tela poder mostrar. */
async function iniciar(config, aoLog = () => {}) {
    try {
        return await subir(config, aoLog);
    } catch (erro) {
        ultimoErro = erro.message;
        anotar(`falha ao iniciar: ${erro.message}`);
        throw erro;
    }
}

async function subir(config, aoLog) {
    encerrando = false; // pode ser um religamento depois de trocar as credenciais
    const executavel = binarioQbit();
    if (!fs.existsSync(executavel)) {
        throw new Error(
            `qbittorrent-nox nao encontrado em ${executavel}. Rode "npm run binaries" antes.`
        );
    }

    const perfil = garantirPasta(pastaDados('qbittorrent'));
    garantirPasta(config.pastaDownloads);

    // Uma sobra da tentativa anterior segura o lock de instancia unica do
    // qBittorrent: a nova sobe e morre na hora. Limpa antes de tentar.
    await matarProcesso();

    porta = await portaLivre();
    credencialTemporaria = null;
    usandoCredencialTemporaria = false;

    // Credenciais proprias, quando o usuario configurou; senao uma senha nova
    // a cada execucao, que nunca sai daqui.
    const proprias = !!(config.qbitUsuario && config.qbitSenha);
    usuario = proprias ? String(config.qbitUsuario).trim() : USUARIO_PADRAO;
    senha = proprias ? String(config.qbitSenha) : crypto.randomBytes(24).toString('base64url');

    const arquivos = escreverConfig(perfil, config.pastaDownloads);
    anotar(`configuracao escrita em: ${arquivos.join(' , ')}`);
    anotar(`usuario da WebUI: ${usuario}${proprias ? ' (definido nos Ajustes)' : ''}`);

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

    const registrar = (texto) => {
        anotar(texto);
        aoLog(texto);
    };

    const receber = (d) => {
        const texto = String(d);
        lerCredencialAnunciada(texto);
        registrar(texto);
    };
    processo.stdout.on('data', receber);
    processo.stderr.on('data', receber);

    // Sem este ouvinte um spawn que falha (executavel bloqueado pelo antivirus,
    // DLL faltando, permissao negada) derruba o processo principal inteiro.
    let falhaDoSpawn = null;
    processo.on('error', (erro) => {
        falhaDoSpawn = erro;
        registrar(`nao consegui executar ${executavel}: ${erro.message}`);
    });

    processo.on('exit', (codigo, sinal) => {
        if (!encerrando && !trocandoProcesso) {
            registrar(`qbittorrent-nox saiu inesperadamente (codigo ${codigo}, sinal ${sinal})`);
        }
        processo = null;
    });

    try {
        await aguardarWebUI();
    } catch (erro) {
        // a causa real costuma estar no que o proprio qbittorrent-nox imprimiu
        const causa = falhaDoSpawn ? falhaDoSpawn.message : ultimasLinhas(3);
        ultimoErro = causa ? `${erro.message} -- ${causa}` : erro.message;
        throw new Error(ultimoErro);
    }
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
    ultimoErro = '';
    registrar(`qBittorrent no ar em 127.0.0.1:${porta}`);
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

/** Derruba uma sobra da tentativa anterior, sem marcar o app como encerrando. */
async function matarProcesso() {
    if (!processo) return;
    const p = processo;
    trocandoProcesso = true;
    anotar('derrubando o qbittorrent-nox da tentativa anterior');
    try {
        p.kill();
    } catch {
        /* ja morreu */
    }
    for (let i = 0; i < 20 && p.exitCode === null; i++) await esperar(150);
    if (p.exitCode === null) {
        try {
            p.kill('SIGKILL');
        } catch {
            /* ja morreu */
        }
        await esperar(400);
    }
    processo = null;
    trocandoProcesso = false;
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
    registro: () => registro.slice(),
    ultimoErro: () => ultimoErro,
    usuario: () => usuario,
    usandoCredencialTemporaria: () => usandoCredencialTemporaria,
    CATEGORIA,
    get porta() {
        return porta;
    },
    get ativo() {
        return !!processo;
    },
};
