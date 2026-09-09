'use strict';
/**
 * Biblioteca: cruza o que o qBittorrent esta baixando com os arquivos de video
 * em disco e guarda o estado de reproducao (posicao, ultimo arquivo assistido).
 *
 * O catalogo e persistido para que um titulo continue disponivel no player
 * mesmo se o usuario remover o torrent da fila mantendo os arquivos.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const qbit = require('./qbit');

const EXT_VIDEO = new Set([
    '.mkv', '.mp4', '.avi', '.mov', '.m4v', '.webm', '.ts', '.m2ts',
    '.wmv', '.flv', '.mpg', '.mpeg', '.ogv', '.3gp', '.vob', '.divx',
]);
const EXT_LEGENDA = new Set(['.srt', '.ass', '.ssa', '.sub', '.idx', '.vtt']);

const ARQUIVO = () => path.join(app.getPath('userData'), 'biblioteca.json');

let catalogo = null;          // { [hash]: entrada }
let ultimoSnapshot = [];      // ultima resposta do /torrents/info
const cacheArquivos = new Map(); // hash -> { progresso, arquivos }

function carregar() {
    if (catalogo) return catalogo;
    try {
        catalogo = JSON.parse(fs.readFileSync(ARQUIVO(), 'utf8'));
    } catch {
        catalogo = {};
    }
    return catalogo;
}

let gravacaoPendente = null;
function gravar() {
    clearTimeout(gravacaoPendente);
    gravacaoPendente = setTimeout(() => {
        try {
            fs.writeFileSync(ARQUIVO(), JSON.stringify(catalogo, null, 2), 'utf8');
        } catch (e) {
            console.error('Falha ao gravar a biblioteca:', e.message);
        }
    }, 400);
}

function ehVideo(nome) {
    return EXT_VIDEO.has(path.extname(nome).toLowerCase());
}

function ehLegenda(nome) {
    return EXT_LEGENDA.has(path.extname(nome).toLowerCase());
}

/**
 * Le a lista de arquivos de um torrent. Evita bater na API a cada ciclo:
 * so relê enquanto o download nao terminou.
 */
async function arquivosDoTorrent(t) {
    const cache = cacheArquivos.get(t.hash);
    if (cache && cache.progresso === 1 && t.progress === 1) return cache.arquivos;

    let brutos;
    try {
        brutos = await qbit.arquivosDe(t.hash);
    } catch {
        return cache ? cache.arquivos : [];
    }
    const arquivos = (brutos || []).map((a) => ({
        nome: path.basename(a.name),
        relativo: a.name,
        caminho: path.join(t.save_path, a.name),
        tamanho: a.size,
        progresso: a.progress,
        indice: a.index,
        video: ehVideo(a.name),
        legenda: ehLegenda(a.name),
    }));
    cacheArquivos.set(t.hash, { progresso: t.progress, arquivos });
    return arquivos;
}

/** Escolhe o video principal: o maior arquivo de video do torrent. */
function principalDe(arquivos) {
    const videos = arquivos.filter((a) => a.video);
    if (!videos.length) return null;
    return videos.reduce((maior, a) => (a.tamanho > maior.tamanho ? a : maior), videos[0]);
}

/** Roda a cada ciclo do monitor: atualiza o catalogo com o estado do qBittorrent. */
async function sincronizar() {
    carregar();
    const torrents = await qbit.listar();
    ultimoSnapshot = torrents;
    let mudou = false;

    for (const t of torrents) {
        const arquivos = await arquivosDoTorrent(t);
        const videos = arquivos.filter((a) => a.video);
        if (!videos.length && t.progress < 1) continue; // ainda sem saber o conteudo

        const anterior = catalogo[t.hash] || {};
        const concluido = t.progress >= 1;

        catalogo[t.hash] = Object.assign({}, anterior, {
            hash: t.hash,
            nome: t.name,
            savePath: t.save_path,
            contentPath: t.content_path,
            tamanho: t.size,
            adicionadoEm: anterior.adicionadoEm || t.added_on * 1000,
            concluidoEm: concluido ? (anterior.concluidoEm || (t.completion_on > 0 ? t.completion_on * 1000 : Date.now())) : null,
            arquivos: videos.map((v) => ({
                nome: v.nome,
                relativo: v.relativo,
                caminho: v.caminho,
                tamanho: v.tamanho,
                progresso: v.progresso,
            })),
            legendas: arquivos.filter((a) => a.legenda).map((a) => a.caminho),
            principal: (principalDe(arquivos) || {}).caminho || null,
            posicoes: anterior.posicoes || {},
        });
        mudou = true;
    }

    // remove do catalogo o que sumiu do disco e nao esta mais na fila
    const naFila = new Set(torrents.map((t) => t.hash));
    for (const hash of Object.keys(catalogo)) {
        if (naFila.has(hash)) continue;
        const e = catalogo[hash];
        const existe = e.arquivos && e.arquivos.some((a) => fs.existsSync(a.caminho));
        if (!existe) {
            delete catalogo[hash];
            mudou = true;
        }
    }

    if (mudou) gravar();
    return listar();
}

/** Catalogo enriquecido com o estado ao vivo do download. */
function listar() {
    carregar();
    const porHash = new Map(ultimoSnapshot.map((t) => [t.hash, t]));

    return Object.values(catalogo)
        .map((e) => {
            const t = porHash.get(e.hash);
            const progresso = t ? t.progress : 1;
            const arquivos = e.arquivos.map((a) => ({
                ...a,
                existe: fs.existsSync(a.caminho),
            }));
            return {
                ...e,
                arquivos,
                progresso,
                estado: t ? t.state : 'arquivado',
                velocidade: t ? t.dlspeed : 0,
                eta: t ? t.eta : 0,
                seeds: t ? t.num_seeds : 0,
                naFila: !!t,
                // pronto = download concluido; reproduzivel = da para comecar a assistir
                pronto: progresso >= 1,
                reproduzivel: arquivos.some((a) => a.existe) && (progresso >= 1 || progresso > 0.015),
            };
        })
        .sort((a, b) => (b.concluidoEm || b.adicionadoEm || 0) - (a.concluidoEm || a.adicionadoEm || 0));
}

function obter(hash) {
    carregar();
    return catalogo[hash] || null;
}

/** Guarda onde o usuario parou de assistir. */
function salvarPosicao(hash, caminho, segundos, duracao) {
    carregar();
    const e = catalogo[hash];
    if (!e) return;
    e.posicoes = e.posicoes || {};
    // perto do fim, considera assistido e zera a marcacao
    if (duracao && segundos > duracao - 60) delete e.posicoes[caminho];
    else e.posicoes[caminho] = { segundos, duracao, em: Date.now() };
    e.ultimoArquivo = caminho;
    gravar();
}

function posicaoDe(hash, caminho) {
    const e = obter(hash);
    if (!e || !e.posicoes) return 0;
    const p = e.posicoes[caminho];
    return p ? p.segundos : 0;
}

module.exports = {
    sincronizar,
    listar,
    obter,
    salvarPosicao,
    posicaoDe,
    ehVideo,
    /** Ultima resposta crua do /torrents/info (usada pela aba de downloads). */
    snapshot: () => ultimoSnapshot,
};
