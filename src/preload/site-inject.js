'use strict';
/**
 * Roda dentro da pagina do torrange.com.
 *
 * O rotulo do botao no site e:
 *     <a class="botao-baixar">↓ Baixar<span class="sufixo"> .torrent</span>…</a>
 * O CSS injetado pelo processo principal ja esconde o .sufixo. Este script e a
 * rede de seguranca: pega qualquer outro lugar onde apareca "Baixar .torrent"
 * (listagens, paginas novas, conteudo carregado depois) e deixa so "Baixar".
 */

const CSS = `
    a.botao-baixar .sufixo,
    .botao-baixar .sufixo { display: none !important; }
`;

function injetarCss() {
    if (document.getElementById('torrange-app-css')) return;
    const alvo = document.head || document.documentElement;
    if (!alvo) return;
    const estilo = document.createElement('style');
    estilo.id = 'torrange-app-css';
    estilo.textContent = CSS;
    alvo.appendChild(estilo);
}

const SELETORES = 'a, button, [role="button"], .botao-baixar';

function limparTexto(elemento) {
    const caminhador = document.createTreeWalker(elemento, NodeFilter.SHOW_TEXT);
    let no;
    while ((no = caminhador.nextNode())) {
        if (!/\.torrent/i.test(no.nodeValue)) continue;
        const novo = no.nodeValue
            .replace(/\s*\.torrents?\b/gi, '')
            .replace(/\s{2,}/g, ' ');
        if (novo !== no.nodeValue) no.nodeValue = novo;
    }
}

function ajustar(raiz) {
    if (!raiz || !raiz.querySelectorAll) return;
    let elementos;
    try {
        elementos = raiz.querySelectorAll(SELETORES);
    } catch {
        return;
    }
    for (const el of elementos) {
        const texto = el.textContent || '';
        if (!/baixar|download/i.test(texto) || !/\.torrent/i.test(texto)) continue;
        limparTexto(el);
    }
}

let agendado = null;
function agendar() {
    if (agendado) return;
    agendado = requestAnimationFrame(() => {
        agendado = null;
        injetarCss();
        ajustar(document.body);
    });
}

function iniciar() {
    injetarCss();
    ajustar(document.body);
    if (!document.body) return;
    new MutationObserver(agendar).observe(document.body, { childList: true, subtree: true });
}

injetarCss();
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar, { once: true });
} else {
    iniciar();
}
