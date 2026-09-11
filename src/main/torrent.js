'use strict';
/**
 * Entrada de torrents por endereco web, usada pela caixa da aba Downloads.
 *
 * Antes da comunicacao por token isto vivia dentro da aba do site e saia pela
 * sessao do navegador embutido, para levar os cookies do login junto. Agora o
 * app nao tem login nem navegador: o acervo chega pela API, e esta rota existe
 * so para quem cola um endereco na mao.
 *
 * O que foi preservado daquela epoca, porque cada item aqui ja foi um bug:
 *  - seguimos os redirecionamentos na mao, mantendo o Referer (caso da CDN);
 *  - se vier HTML, procuramos o link do .torrent dentro da pagina;
 *  - o conteudo e conferido como bencode de verdade antes de virar torrent,
 *    para uma pagina de erro de 200 nao entrar na fila como se fosse arquivo.
 */
const { net } = require('electron');
const path = require('path');

const MAX_REDIRECIONAMENTOS = 5;

function ehTorrent({ url = '', nome = '', mime = '' }) {
    return (
        mime === 'application/x-bittorrent' ||
        /\.torrent(\?|#|$)/i.test(url) ||
        /\.torrent$/i.test(nome) ||
        /\/(baixar|download)\/\d+/i.test(url)
    );
}

/** Um .torrent e um dicionario bencode: sempre comeca com "d" e tem a chave "info". */
function ehBytesTorrent(dados) {
    return (
        Buffer.isBuffer(dados) &&
        dados.length > 16 &&
        dados[0] === 0x64 && // 'd'
        dados.indexOf(Buffer.from('4:info')) !== -1
    );
}

function cabecalho(headers, nome) {
    const valor = headers && headers[nome];
    return Array.isArray(valor) ? valor[0] : valor || '';
}

function nomeDoCabecalho(disposicao) {
    if (!disposicao) return '';
    const estendido = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(disposicao);
    if (estendido) {
        try {
            return decodeURIComponent(estendido[1].trim());
        } catch {
            return estendido[1].trim();
        }
    }
    const simples = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(disposicao);
    return simples ? (simples[1] || simples[2] || '').trim() : '';
}

function nomeDaUrl(url) {
    try {
        const base = path.basename(new URL(url).pathname);
        return /\.torrent$/i.test(base) ? decodeURIComponent(base) : '';
    } catch {
        return '';
    }
}

function buscar(url, { referer = '', saltos = 0 } = {}) {
    return new Promise((resolve, reject) => {
        if (saltos > MAX_REDIRECIONAMENTOS) {
            reject(new Error('o endereço redirecionou vezes demais'));
            return;
        }

        // Depois de um redirecionamento quem manda e a requisicao nova; o
        // 'error'/'abort' que a antiga ainda possa emitir tem de ser ignorado.
        let entregue = false;
        const pronto = (fn) => (valor) => {
            if (entregue) return;
            entregue = true;
            fn(valor);
        };
        const entregar = pronto(resolve);
        const falhar = pronto(reject);

        let requisicao;
        try {
            requisicao = net.request({ method: 'GET', url, redirect: 'manual' });
        } catch (erro) {
            falhar(erro);
            return;
        }

        requisicao.setHeader('Accept', 'application/x-bittorrent,application/octet-stream,*/*');
        if (referer) requisicao.setHeader('Referer', referer);

        requisicao.on('redirect', (_status, _metodo, destino) => {
            if (entregue) return;
            entregue = true; // a partir daqui esta requisicao nao decide mais nada
            requisicao.abort();
            buscar(destino, { referer: url, saltos: saltos + 1 }).then(resolve, reject);
        });

        requisicao.on('response', (resposta) => {
            const pedacos = [];
            resposta.on('data', (d) => pedacos.push(d));
            resposta.on('error', falhar);
            resposta.on('end', () => {
                entregar({
                    status: resposta.statusCode,
                    tipo: String(cabecalho(resposta.headers, 'content-type')).split(';')[0].trim(),
                    nome:
                        nomeDoCabecalho(cabecalho(resposta.headers, 'content-disposition')) ||
                        nomeDaUrl(url),
                    dados: Buffer.concat(pedacos),
                    url,
                });
            });
        });

        requisicao.on('error', falhar);
        requisicao.end();
    });
}

/** Procura o link de download dentro de uma pagina. */
function linkDeTorrentNaPagina(html, base) {
    const encontrados = html.matchAll(/href\s*=\s*["']([^"']+)["']/gi);
    for (const [, cru] of encontrados) {
        const endereco = cru.replace(/&amp;/g, '&');
        if (!ehTorrent({ url: endereco })) continue;
        try {
            return new URL(endereco, base).href;
        } catch {
            /* href estranho: tenta o proximo */
        }
    }
    return null;
}

/**
 * Busca o .torrent de um endereco. Devolve { dados, nome } ou null quando o
 * endereco nao e um torrent.
 *
 * Com seguirPagina, se vier HTML procuramos o link de baixar dentro dele --
 * assim colar o endereco da pagina do item tambem funciona.
 */
async function pegar(url, { referer = '', seguirPagina = false } = {}) {
    const r = await buscar(url, { referer });

    if (r.status >= 400) throw new Error(`o servidor respondeu HTTP ${r.status}`);

    if (r.tipo === 'application/x-bittorrent' || ehBytesTorrent(r.dados)) {
        const nome = /\.torrent$/i.test(r.nome) ? r.nome : `${r.nome || 'torrange'}.torrent`;
        return { dados: r.dados, nome };
    }

    if (seguirPagina && /html/i.test(r.tipo)) {
        const link = linkDeTorrentNaPagina(r.dados.toString('utf8'), r.url);
        if (link && link !== url) return pegar(link, { referer: r.url });
    }

    return null;
}

module.exports = { ehTorrent, ehBytesTorrent, pegar };
