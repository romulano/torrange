'use strict';
/**
 * Aba do site: carrega o torrange.com num WebContentsView (contexto de
 * navegacao proprio -- o site manda X-Frame-Options: DENY, entao um <iframe>
 * seria bloqueado, mas isto aqui passa normalmente).
 *
 * Interceptacao do download em tres camadas:
 *   1. CSS/preload reescrevem o rotulo do botao para "Baixar".
 *   2. Toda navegacao para um endereco de torrent -- na mesma aba, em aba nova
 *      ou para outro dominio -- e cancelada e o arquivo e buscado aqui dentro,
 *      pela propria sessao do site (leva os cookies do login junto). Esta e a
 *      camada principal: nao passamos pelo mecanismo de download do Chromium,
 *      que no Windows pode cancelar o arquivo ou entrega-lo ao navegador do
 *      sistema -- o site contabiliza o download e o app nao recebe nada.
 *   3. Rede de seguranca: se mesmo assim um download comecar (por exemplo
 *      quando o site monta o arquivo em JavaScript e usa uma URL blob:), ele e
 *      desviado para um temporario e mandado ao qBittorrent, sem nunca cair na
 *      pasta de Downloads do usuario.
 */
const { WebContentsView, net, session, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PARTICAO = 'persist:torrange';
const MAX_REDIRECIONAMENTOS = 5;

// Esconde o sufixo ".torrent" do rotulo sem tocar no DOM do site.
const CSS_BOTAO = `
    a.botao-baixar .sufixo,
    .botao-baixar .sufixo { display: none !important; }
`;

let view = null;
let sessaoSite = null;
let ganchos = {};

function sessao() {
    if (!sessaoSite) sessaoSite = session.fromPartition(PARTICAO);
    return sessaoSite;
}

function ehTorrent({ url = '', nome = '', mime = '' }) {
    return (
        mime === 'application/x-bittorrent' ||
        /\.torrent(\?|#|$)/i.test(url) ||
        /\.torrent$/i.test(nome) ||
        /\/(baixar|download)\/\d+/i.test(url)
    );
}

/** Um .torrent e um dicionario bencode; sempre comeca com "d" e tem a chave "info". */
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

/** Le o nome do arquivo do Content-Disposition (aceita a forma filename*=UTF-8''…). */
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

/**
 * GET pela sessao do site (cookies do login inclusos). Usamos o net do
 * Electron, e nao o http do Node, justamente para herdar sessao, proxy e
 * certificados do navegador embutido.
 */
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
            requisicao = net.request({
                method: 'GET',
                url,
                session: sessao(),
                useSessionCookies: true,
                redirect: 'manual', // seguimos na mao para nao perder o Referer
            });
        } catch (erro) {
            falhar(erro);
            return;
        }

        requisicao.setHeader('Accept', 'application/x-bittorrent,application/octet-stream,*/*');
        if (referer) requisicao.setHeader('Referer', referer);
        if (view && !view.webContents.isDestroyed()) {
            try {
                requisicao.setHeader('User-Agent', view.webContents.getUserAgent());
            } catch {
                /* segue com o padrao */
            }
        }

        requisicao.on('redirect', (status, metodo, destino) => {
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

/** Procura o link de download dentro de uma pagina do site. */
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
 * endereco nao e um torrent (por exemplo, quando e uma pagina comum).
 *
 * Com seguirPagina, se vier HTML procuramos o botao de baixar dentro dele --
 * assim colar o endereco da pagina do filme tambem funciona.
 */
async function pegarTorrent(url, { referer = '', seguirPagina = false } = {}) {
    const r = await buscar(url, { referer });

    if (r.status >= 400) throw new Error(`o servidor respondeu HTTP ${r.status}`);

    if (r.tipo === 'application/x-bittorrent' || ehBytesTorrent(r.dados)) {
        const nome = /\.torrent$/i.test(r.nome) ? r.nome : `${r.nome || 'torrange'}.torrent`;
        return { dados: r.dados, nome };
    }

    if (seguirPagina && /html/i.test(r.tipo)) {
        const link = linkDeTorrentNaPagina(r.dados.toString('utf8'), r.url);
        if (link && link !== url) return pegarTorrent(link, { referer: r.url });
    }

    return null;
}

/**
 * Cancela a navegacao e traz o arquivo para dentro do app. Quando o endereco
 * era na verdade uma pagina, volta a navegar nela normalmente.
 */
async function capturar(url, { referer = '', navegarSeForPagina = false } = {}) {
    try {
        const torrent = await pegarTorrent(url, { referer });
        if (torrent) {
            ganchos.aoTorrent && ganchos.aoTorrent(torrent);
            return true;
        }
        if (navegarSeForPagina && view && !view.webContents.isDestroyed()) {
            view.webContents.loadURL(url); // loadURL nao dispara will-navigate: sem laco
            return false;
        }
        ganchos.aoErro && ganchos.aoErro('Esse endereço não devolveu um arquivo .torrent.');
    } catch (erro) {
        ganchos.aoErro && ganchos.aoErro(`Não consegui baixar o torrent: ${erro.message}`);
    }
    return false;
}

function criar(janela, config, callbacks) {
    ganchos = callbacks || {};
    sessaoSite = session.fromPartition(PARTICAO);

    view = new WebContentsView({
        webPreferences: {
            partition: PARTICAO,
            preload: path.join(__dirname, '..', 'preload', 'site-inject.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
        },
    });

    const wc = view.webContents;

    // ---------------------------------------------------------------- rotulo
    wc.on('dom-ready', () => {
        if (config.ler().renomearBotaoBaixar) wc.insertCSS(CSS_BOTAO).catch(() => {});
    });

    // ------------------------------------------------- navegacao interceptada
    wc.on('will-navigate', (evento, url) => {
        if (url.startsWith('magnet:')) {
            evento.preventDefault();
            ganchos.aoMagnet && ganchos.aoMagnet(url);
            return;
        }
        if (ehTorrent({ url })) {
            evento.preventDefault();
            capturar(url, { referer: wc.getURL(), navegarSeForPagina: true });
        }
    });

    wc.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('magnet:')) {
            ganchos.aoMagnet && ganchos.aoMagnet(url);
            return { action: 'deny' };
        }
        // Torrent em aba nova: buscamos aqui mesmo. Vale inclusive quando o
        // arquivo mora em outro dominio (CDN) -- antes esse caso caia no
        // shell.openExternal abaixo e o arquivo ia parar no navegador do
        // sistema, que e o sintoma relatado no Windows.
        if (ehTorrent({ url })) {
            capturar(url, { referer: wc.getURL() });
            return { action: 'deny' };
        }
        // links externos ao torrange abrem no navegador do sistema
        try {
            const alvo = new URL(url);
            const base = new URL(config.ler().siteUrl);
            if (alvo.host !== base.host) {
                shell.openExternal(url);
                return { action: 'deny' };
            }
        } catch {
            /* url estranha: segue o fluxo abaixo */
        }
        // links do proprio site abrem na mesma aba
        wc.loadURL(url);
        return { action: 'deny' };
    });

    // ------------------------------------------------- downloads (rede de seguranca)
    sessaoSite.on('will-download', (evento, item) => {
        const info = {
            url: item.getURL(),
            nome: item.getFilename(),
            mime: item.getMimeType(),
        };
        if (!ehTorrent(info)) return; // qualquer outro arquivo baixa normalmente

        const temporario = path.join(
            os.tmpdir(),
            `torrange-${Date.now()}-${Math.random().toString(36).slice(2)}.torrent`
        );
        // setSavePath tambem impede que o Electron abra o dialogo de salvar
        item.setSavePath(temporario);

        // O Chromium pode pausar o download sozinho (checagem de seguranca do
        // Windows, por exemplo). Retomar aqui evita o download que trava calado.
        item.on('updated', (_e, estado) => {
            if (estado === 'interrupted' && item.canResume()) item.resume();
        });

        item.once('done', (_e, estado) => {
            if (estado !== 'completed') {
                // Ultimo recurso: refaz o pedido por conta propria.
                capturar(info.url, { referer: view ? view.webContents.getURL() : '' });
                return;
            }
            let dados;
            try {
                dados = fs.readFileSync(temporario);
            } catch (erro) {
                ganchos.aoErro && ganchos.aoErro(`Falha ao ler o torrent: ${erro.message}`);
                return;
            } finally {
                fs.promises.unlink(temporario).catch(() => {});
            }
            ganchos.aoTorrent && ganchos.aoTorrent({ dados, nome: info.nome });
        });
    });

    // ------------------------------------------------------------- navegacao
    const avisar = () => {
        ganchos.aoNavegar &&
            ganchos.aoNavegar({
                url: wc.getURL(),
                titulo: wc.getTitle(),
                voltar: wc.navigationHistory.canGoBack(),
                avancar: wc.navigationHistory.canGoForward(),
                carregando: wc.isLoading(),
            });
    };
    for (const evento of [
        'did-navigate',
        'did-navigate-in-page',
        'did-finish-load',
        'did-start-loading',
        'did-stop-loading',
        'page-title-updated',
    ]) {
        wc.on(evento, avisar);
    }

    wc.on('did-fail-load', (_e, codigo, descricao, url, principal) => {
        if (principal && codigo !== -3) {
            ganchos.aoErro && ganchos.aoErro(`Nao consegui abrir ${url}: ${descricao}`);
        }
    });

    janela.contentView.addChildView(view);
    wc.loadURL(config.ler().siteUrl);
    return view;
}

function definirRetangulo(r) {
    if (view) view.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
}

/** Some da tela zerando as dimensoes (funciona em qualquer versao do Electron). */
function esconder() {
    if (view) view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
}

function navegar(acao, url) {
    if (!view) return;
    const wc = view.webContents;
    const historico = wc.navigationHistory;
    if (acao === 'voltar' && historico.canGoBack()) historico.goBack();
    else if (acao === 'avancar' && historico.canGoForward()) historico.goForward();
    else if (acao === 'recarregar') wc.reload();
    else if (acao === 'inicio') wc.loadURL(url);
    else if (acao === 'ir' && url) wc.loadURL(url);
}

function limparSessao() {
    return sessaoSite ? sessaoSite.clearStorageData() : Promise.resolve();
}

module.exports = {
    criar,
    definirRetangulo,
    esconder,
    navegar,
    limparSessao,
    ehTorrent,
    ehBytesTorrent,
    pegarTorrent,
    PARTICAO,
};
