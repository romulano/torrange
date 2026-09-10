'use strict';
/**
 * Modo diagnostico: junta num unico arquivo .log tudo o que costuma explicar
 * um problema relatado -- versoes, caminhos, se os binarios estao no lugar,
 * o que o qBittorrent e o mpv escreveram, o estado da fila e o que o app
 * registrou desde que abriu.
 *
 * O registro comeca a ser gravado assim que o app sobe (capturarConsole), e
 * nao quando o usuario pede o arquivo -- senao o mais importante, que e a
 * subida do qBittorrent, ja teria passado.
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_LINHAS = 2000;
const linhas = [];

function agora() {
    return new Date().toISOString();
}

function anotar(origem, texto) {
    const limpo = String(texto == null ? '' : texto).replace(/\s+$/, '');
    if (!limpo) return;
    for (const parte of limpo.split('\n')) {
        linhas.push(`${agora()} [${origem}] ${parte}`);
    }
    if (linhas.length > MAX_LINHAS) linhas.splice(0, linhas.length - MAX_LINHAS);
}

/** Espelha o console do processo principal para dentro do registro. */
function capturarConsole() {
    for (const nivel of ['log', 'warn', 'error']) {
        const original = console[nivel].bind(console);
        console[nivel] = (...args) => {
            anotar(nivel === 'log' ? 'main' : nivel, args.map(formatar).join(' '));
            original(...args);
        };
    }

    process.on('uncaughtException', (erro) => {
        anotar('excecao', erro && erro.stack ? erro.stack : String(erro));
        console.error('uncaughtException:', erro);
    });
    process.on('unhandledRejection', (motivo) => {
        anotar('rejeicao', motivo && motivo.stack ? motivo.stack : String(motivo));
    });
}

function formatar(valor) {
    if (typeof valor === 'string') return valor;
    if (valor instanceof Error) return valor.stack || valor.message;
    try {
        return JSON.stringify(valor);
    } catch {
        return String(valor);
    }
}

// --------------------------------------------------------------------------
// Coleta

function secao(titulo) {
    return `\n${'='.repeat(72)}\n== ${titulo}\n${'='.repeat(72)}\n`;
}

function comoTexto(valor) {
    try {
        return JSON.stringify(valor, null, 2);
    } catch (erro) {
        return `<nao consegui serializar: ${erro.message}>`;
    }
}

/** Existe? de que tamanho? executavel? -- o basico que explica binario que nao roda. */
function olharArquivo(caminho) {
    if (!caminho) return { caminho, existe: false };
    try {
        const s = fs.statSync(caminho);
        const info = { caminho, existe: true, bytes: s.size, modificado: s.mtime.toISOString() };
        if (process.platform !== 'win32') {
            info.permissoes = (s.mode & 0o777).toString(8);
            try {
                fs.accessSync(caminho, fs.constants.X_OK);
                info.executavel = true;
            } catch {
                info.executavel = false;
            }
        }
        return info;
    } catch (erro) {
        return { caminho, existe: false, erro: erro.message };
    }
}

/** Ultimas linhas do log que o proprio qBittorrent grava no perfil. */
function logDoQbit(pastaPerfil, quantas = 150) {
    const candidatos = [
        path.join(pastaPerfil, 'qBittorrent', 'data', 'logs', 'qbittorrent.log'),
        path.join(pastaPerfil, 'qBittorrent', 'logs', 'qbittorrent.log'),
    ];
    for (const arquivo of candidatos) {
        try {
            const texto = fs.readFileSync(arquivo, 'utf8').trim();
            return `${arquivo}\n\n${texto ? texto.split('\n').slice(-quantas).join('\n') : '(vazio)'}`;
        } catch {
            /* tenta o proximo caminho */
        }
    }
    return `(não encontrei o log do qBittorrent em: ${candidatos.join(' , ')})`;
}

/** O qBittorrent.conf explica muita coisa -- menos a senha, que fica de fora. */
function confDoQbit(pastaPerfil) {
    const arquivo = path.join(pastaPerfil, 'qBittorrent', 'config', 'qBittorrent.conf');
    try {
        const texto = fs.readFileSync(arquivo, 'utf8');
        const seguro = texto
            .split('\n')
            .filter((l) => !/password/i.test(l))
            .join('\n')
            .trim();
        return `${arquivo}\n\n${seguro}`;
    } catch (erro) {
        return `(não consegui ler ${arquivo}: ${erro.message})`;
    }
}

function espacoEmDisco(pasta) {
    try {
        const s = fs.statfsSync(pasta);
        const gb = (n) => `${((n * s.bsize) / 1024 ** 3).toFixed(1)} GB`;
        return { livre: gb(s.bavail), total: gb(s.blocks) };
    } catch (erro) {
        return { erro: erro.message };
    }
}

/**
 * Monta o relatorio inteiro. Recebe as pecas de fora para nao criar
 * dependencia circular com o index.js.
 */
async function montar(fontes = {}) {
    const {
        config = {},
        estadoQbit = {},
        qbit = {},
        player = null,
        fila = [],
        biblioteca = [],
        caminhos = {},
        janela = null,
        video = {},
    } = fontes;

    const partes = [];

    partes.push('Diagnóstico do Torrange');
    partes.push(`gerado em ${agora()}`);

    partes.push(secao('Aplicação e sistema'));
    partes.push(
        comoTexto({
            versao: app.getVersion(),
            empacotado: app.isPackaged,
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            node: process.versions.node,
            plataforma: process.platform,
            arquitetura: process.arch,
            sistema: `${os.type()} ${os.release()}`,
            memoriaTotal: `${(os.totalmem() / 1024 ** 3).toFixed(1)} GB`,
            idioma: app.getLocale(),
            sessaoGrafica: {
                XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE || null,
                WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || null,
                DISPLAY: process.env.DISPLAY || null,
            },
            videoAcoplavel: video.podeEmbutir,
            argumentos: process.argv.slice(1),
        })
    );

    partes.push(secao('Caminhos'));
    partes.push(
        comoTexto({
            dadosDoApp: app.getPath('userData'),
            pastaDoApp: app.getAppPath(),
            recursos: process.resourcesPath,
            temporarios: os.tmpdir(),
            perfilQbit: caminhos.perfilQbit,
        })
    );

    partes.push(secao('Binários embutidos'));
    partes.push(
        comoTexto({
            qbittorrent: olharArquivo(caminhos.binarioQbit),
            mpv: olharArquivo(caminhos.binarioMpv),
            variaveis: {
                TORRANGE_QBIT: process.env.TORRANGE_QBIT || null,
                TORRANGE_MPV: process.env.TORRANGE_MPV || null,
            },
        })
    );

    partes.push(secao('Configuração'));
    partes.push(comoTexto(config));
    partes.push(`\npasta de downloads: ${comoTexto(espacoEmDisco(config.pastaDownloads || os.homedir()))}`);

    partes.push(secao('qBittorrent'));
    partes.push(
        comoTexto({
            estado: estadoQbit,
            ativo: qbit.ativo,
            porta: qbit.porta || null,
            ultimoErro: qbit.ultimoErro || null,
        })
    );
    partes.push('\n-- o que o processo escreveu (visto pelo app) --');
    partes.push((qbit.registro && qbit.registro.length ? qbit.registro : ['(nada)']).join('\n'));
    if (caminhos.perfilQbit) {
        partes.push('\n-- qBittorrent.conf (sem a senha) --');
        partes.push(confDoQbit(caminhos.perfilQbit));
        partes.push('\n-- log do próprio qBittorrent --');
        partes.push(logDoQbit(caminhos.perfilQbit));
    }

    partes.push(secao('Player (mpv)'));
    partes.push(player ? comoTexto(player) : '(não consegui coletar)');

    partes.push(secao('Fila de downloads'));
    partes.push(
        fila.length
            ? comoTexto(
                  fila.map((t) => ({
                      nome: t.name,
                      estado: t.state,
                      progresso: `${((t.progress || 0) * 100).toFixed(1)}%`,
                      tamanho: t.size,
                      seeds: t.num_seeds,
                      categoria: t.category,
                      pasta: t.save_path,
                  }))
              )
            : '(vazia)'
    );

    partes.push(secao('Biblioteca'));
    partes.push(`${biblioteca.length} entrada(s)`);
    if (biblioteca.length) {
        partes.push(
            comoTexto(
                biblioteca.slice(0, 50).map((e) => ({
                    nome: e.nome || e.name,
                    reproduzivel: e.reproduzivel,
                    arquivos: (e.arquivos || []).length,
                }))
            )
        );
    }

    partes.push(secao('Janela'));
    partes.push(comoTexto(janela));

    partes.push(secao('Registro do app (mais recente por último)'));
    partes.push(linhas.length ? linhas.join('\n') : '(nada registrado)');

    return partes.join('\n');
}

/** Escreve o relatorio e devolve o caminho. */
async function salvar(caminho, fontes) {
    const texto = await montar(fontes);
    fs.mkdirSync(path.dirname(caminho), { recursive: true });
    fs.writeFileSync(caminho, texto, 'utf8');
    return { caminho, bytes: Buffer.byteLength(texto, 'utf8') };
}

/** torrange-diagnostico-2026-09-10_20-31-05.log */
function nomeSugerido() {
    const t = new Date();
    const dois = (n) => String(n).padStart(2, '0');
    return (
        `torrange-diagnostico-${t.getFullYear()}-${dois(t.getMonth() + 1)}-${dois(t.getDate())}` +
        `_${dois(t.getHours())}-${dois(t.getMinutes())}-${dois(t.getSeconds())}.log`
    );
}

module.exports = { anotar, capturarConsole, montar, salvar, nomeSugerido };
