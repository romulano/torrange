'use strict';
/**
 * Cliente da API do aplicativo (https://torrange.com/api/aplicativo).
 *
 * Regras que moldam este arquivo, todas vindas da especificacao:
 *
 *  - Dois cabecalhos vao em TODA chamada: X-Aplicativo-Token (o token de 100
 *    caracteres) e X-Aplicativo-Instalacao (o id fixo deste aparelho).
 *  - Toda recusa tem a mesma forma {"erro": "...", "mensagem": "..."} e quem
 *    decide e o campo `erro`, nunca a frase -- a mensagem pode mudar a
 *    qualquer momento, o codigo nao.
 *  - O POST /baixar/{item} COBRA. Ele nunca e repetido sozinho: um retry cego
 *    depois de um timeout debita duas vezes.
 *  - O token e uma senha: nao entra em URL, em log nem em mensagem de erro.
 */
const { net } = require('electron');

const credenciais = require('./credenciais');

const TEMPO_LIMITE = 30000;

let enderecoBase = 'https://torrange.com/api/aplicativo';

function configurar(url) {
    if (url) enderecoBase = String(url).replace(/\/+$/, '');
}

function base() {
    return enderecoBase;
}

/**
 * Recusa da API, ja traduzida para algo que o app possa decidir em cima.
 * `erro` e o codigo estavel; `mensagem` e a frase que o servidor mandou.
 */
class ErroApi extends Error {
    constructor({ erro, mensagem, status, retryAfter = 0, dados = null }) {
        super(mensagem || erro || `HTTP ${status}`);
        this.name = 'ErroApi';
        this.erro = erro || '';
        this.status = status || 0;
        this.retryAfter = retryAfter;
        this.dados = dados;
    }
}

/** Falha de rede: o servidor nao respondeu. Nao e recusa, e ausencia. */
class ErroRede extends Error {
    constructor(mensagem) {
        super(mensagem);
        this.name = 'ErroRede';
        this.erro = 'sem_rede';
        this.status = 0;
    }
}

function montarUrl(rota, parametros) {
    const url = new URL(`${base()}${rota.startsWith('/') ? '' : '/'}${rota}`);
    for (const [chave, valor] of Object.entries(parametros || {})) {
        if (valor === undefined || valor === null || valor === '') continue;
        url.searchParams.set(chave, String(valor));
    }
    return url.href;
}

function cabecalhoDe(cabecalhos, nome) {
    const valor = cabecalhos && cabecalhos[nome];
    return Array.isArray(valor) ? valor[0] : valor || '';
}

/** Le o nome do arquivo do Content-Disposition (aceita filename*=UTF-8''...). */
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

/**
 * Uma chamada crua. Devolve { status, tipo, nome, bytes, json }.
 * Nao decide nada sobre erro -- quem decide e `chamar`.
 */
function requisicao(metodo, url, { corpo = null, aceitar = 'application/json' } = {}) {
    return new Promise((resolve, reject) => {
        const token = credenciais.lerToken();
        if (!token) {
            reject(new ErroApi({ erro: 'token_ausente', mensagem: 'Nenhum token cadastrado neste aplicativo.', status: 401 }));
            return;
        }

        let pedido;
        try {
            pedido = net.request({ method: metodo, url });
        } catch (erro) {
            reject(new ErroRede(erro.message));
            return;
        }

        pedido.setHeader('X-Aplicativo-Token', token);
        pedido.setHeader('X-Aplicativo-Instalacao', credenciais.idInstalacao());
        pedido.setHeader('Accept', aceitar);
        if (corpo) pedido.setHeader('Content-Type', 'application/json');

        let encerrado = false;
        const falhar = (erro) => {
            if (encerrado) return;
            encerrado = true;
            reject(erro);
        };
        const entregar = (valor) => {
            if (encerrado) return;
            encerrado = true;
            resolve(valor);
        };

        const relogio = setTimeout(() => {
            try {
                pedido.abort();
            } catch {
                /* ja terminou */
            }
            falhar(new ErroRede('o servidor não respondeu a tempo'));
        }, TEMPO_LIMITE);

        pedido.on('response', (resposta) => {
            const pedacos = [];
            resposta.on('data', (d) => pedacos.push(d));
            resposta.on('error', (erro) => {
                clearTimeout(relogio);
                falhar(new ErroRede(erro.message));
            });
            resposta.on('end', () => {
                clearTimeout(relogio);
                const bytes = Buffer.concat(pedacos);
                const tipo = String(cabecalhoDe(resposta.headers, 'content-type')).split(';')[0].trim();
                let json = null;
                if (/json/i.test(tipo) && bytes.length) {
                    try {
                        json = JSON.parse(bytes.toString('utf8'));
                    } catch {
                        json = null;
                    }
                }
                entregar({
                    status: resposta.statusCode,
                    tipo,
                    nome: nomeDoCabecalho(cabecalhoDe(resposta.headers, 'content-disposition')),
                    retryAfter: Number(cabecalhoDe(resposta.headers, 'retry-after')) || 0,
                    bytes,
                    json,
                });
            });
        });

        pedido.on('error', (erro) => {
            clearTimeout(relogio);
            falhar(new ErroRede(erro.message));
        });

        if (corpo) pedido.write(JSON.stringify(corpo));
        pedido.end();
    });
}

/**
 * Chamada com o tratamento de recusa da especificacao. Em caso de erro lanca
 * ErroApi com o codigo estavel; em caso de rede fora, ErroRede.
 *
 * `aceitandoStatus` lista status que NAO sao erro para quem chamou -- e como o
 * 402 confirmacao_necessaria chega inteiro na tela de confirmacao de gemas.
 */
async function chamar(metodo, rota, opcoes = {}) {
    const { parametros, corpo, aceitar, aceitandoStatus = [] } = opcoes;
    const r = await requisicao(metodo, montarUrl(rota, parametros), { corpo, aceitar });

    if (r.status >= 200 && r.status < 300) return r;
    if (aceitandoStatus.includes(r.status)) return r;

    const dados = r.json || {};
    // 422 e o unico formato diferente: {"message": ..., "errors": {...}}
    const mensagem = dados.mensagem || dados.message || `O servidor respondeu HTTP ${r.status}.`;
    throw new ErroApi({
        erro: dados.erro || (r.status === 429 ? 'muitas_chamadas' : `http_${r.status}`),
        mensagem,
        status: r.status,
        retryAfter: r.retryAfter,
        dados,
    });
}

async function json(metodo, rota, opcoes) {
    const r = await chamar(metodo, rota, opcoes);
    return r.json || {};
}

// --------------------------------------------------------------------------
// Endpoints

/**
 * Apresenta este aparelho. E a unica rota que um aplicativo ainda nao
 * autorizado alcanca, e chamar de novo e seguro: a mesma instalacao reencontra
 * a propria vaga, nao gasta outra e nao perde a permissao que ja tem.
 */
function conexao({ nome, plataforma }) {
    return json('POST', '/conexao', { corpo: { nome, plataforma } });
}

/** Chamada de abertura -- e tambem o jeito barato de saber que a autorizacao saiu. */
function conta() {
    return json('GET', '/conta');
}

function acervo(filtros = {}) {
    return json('GET', '/acervo', { parametros: filtros });
}

function titulo(chave) {
    return json('GET', `/titulo/${encodeURIComponent(chave)}`);
}

/** Bytes da capa (webp). null quando o item nao tem imagem. */
async function capa(item) {
    const r = await chamar('GET', `/capa/${encodeURIComponent(item)}`, {
        aceitar: 'image/webp,image/*',
        aceitandoStatus: [404],
    });
    if (r.status === 404 || !r.bytes.length) return null;
    return { bytes: r.bytes, tipo: r.tipo || 'image/webp' };
}

/**
 * Baixar o que e free. Este verbo NUNCA debita gema -- repetir depois de um
 * timeout e seguro.
 *
 * Devolve { torrent: { dados, nome } } quando entregou, ou
 * { confirmacao: { preco, saldo, item } } quando a opcao custa gema.
 */
async function baixar(item) {
    const r = await chamar('GET', `/baixar/${encodeURIComponent(item)}`, {
        aceitar: 'application/x-bittorrent,application/json',
        aceitandoStatus: [402],
    });

    if (r.status === 402) {
        const d = r.json || {};
        if (d.erro && d.erro !== 'confirmacao_necessaria') {
            throw new ErroApi({ erro: d.erro, mensagem: d.mensagem, status: 402, dados: d });
        }
        return {
            confirmacao: {
                item,
                preco: Number(d.preco) || 0,
                saldo: Number(d.saldo) || 0,
                mensagem: d.mensagem || '',
            },
        };
    }
    return { torrent: comoTorrent(r, item) };
}

/**
 * O unico caminho que debita. Vai o preco que o usuario viu e aceitou; o
 * servidor reconfere contra o vigente antes de tocar no saldo.
 *
 * Nao ha retry aqui, de proposito: cada chamada entrega e cobra por si.
 */
async function confirmarBaixar(item, preco) {
    const r = await chamar('POST', `/baixar/${encodeURIComponent(item)}`, {
        corpo: { preco: Number(preco) || 0 },
        aceitar: 'application/x-bittorrent,application/json',
    });
    return { torrent: comoTorrent(r, item) };
}

function comoTorrent(r, item) {
    if (!r.bytes || r.bytes.length < 16) {
        throw new ErroApi({
            erro: 'resposta_vazia',
            mensagem: 'O servidor respondeu sem o arquivo .torrent.',
            status: r.status,
        });
    }
    const nome = /\.torrent$/i.test(r.nome) ? r.nome : `${r.nome || `torrange-${item}`}.torrent`;
    return { dados: r.bytes, nome };
}

function favoritos(pagina = 1) {
    return json('GET', '/favoritos', { parametros: { page: pagina } });
}

/** Liga e desliga a estrela -- e alternancia, nao "adicionar". */
function alternarFavorito(chave, item) {
    return json('POST', '/favoritos', { corpo: { chave, item } });
}

function baixados(pagina = 1) {
    return json('GET', '/baixados', { parametros: { page: pagina } });
}

module.exports = {
    configurar,
    base,
    ErroApi,
    ErroRede,
    chamar,
    conexao,
    conta,
    acervo,
    titulo,
    capa,
    baixar,
    confirmarBaixar,
    favoritos,
    alternarFavorito,
    baixados,
};
