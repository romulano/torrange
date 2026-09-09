'use strict';
/**
 * Aba do site: carrega o torrange.com num WebContentsView (contexto de
 * navegacao proprio -- o site manda X-Frame-Options: DENY, entao um <iframe>
 * seria bloqueado, mas isto aqui passa normalmente).
 *
 * Interceptacao do download em duas camadas:
 *   1. CSS/preload reescrevem o rotulo do botao para "Baixar".
 *   2. Todo download com Content-Type application/x-bittorrent (ou .torrent)
 *      e desviado para um arquivo temporario e mandado ao qBittorrent, sem
 *      nunca cair na pasta de Downloads do usuario. Essa camada funciona
 *      mesmo se o site mudar o layout.
 */
const { WebContentsView, session, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PARTICAO = 'persist:torrange';

// Esconde o sufixo ".torrent" do rotulo sem tocar no DOM do site.
const CSS_BOTAO = `
    a.botao-baixar .sufixo,
    .botao-baixar .sufixo { display: none !important; }
`;

let view = null;
let sessaoSite = null;
let ganchos = {};

function ehTorrent({ url = '', nome = '', mime = '' }) {
    return (
        mime === 'application/x-bittorrent' ||
        /\.torrent(\?|#|$)/i.test(url) ||
        /\.torrent$/i.test(nome) ||
        /\/baixar\/\d+/i.test(url)
    );
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

    // ------------------------------------------------------------- downloads
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

        item.once('done', (_e, estado) => {
            if (estado !== 'completed') {
                ganchos.aoErro && ganchos.aoErro(`Nao consegui baixar o torrent (${estado}).`);
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

    // ---------------------------------------------------------------- magnet
    wc.on('will-navigate', (evento, url) => {
        if (url.startsWith('magnet:')) {
            evento.preventDefault();
            ganchos.aoMagnet && ganchos.aoMagnet(url);
        }
    });

    wc.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('magnet:')) {
            ganchos.aoMagnet && ganchos.aoMagnet(url);
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
        // links do proprio site abrem na mesma aba (inclusive downloads)
        wc.loadURL(url);
        return { action: 'deny' };
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

module.exports = { criar, definirRetangulo, esconder, navegar, limparSessao, ehTorrent, PARTICAO };
