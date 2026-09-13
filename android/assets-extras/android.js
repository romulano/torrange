'use strict';
/*
 * As poucas diferencas do Android, todas aqui.
 *
 * A interface e a mesma do desktop, sem alteracao -- o que muda de sistema
 * mora neste arquivo, de fora, para `app.js`, `index.html` e `styles.css`
 * continuarem sendo UM codigo so para as quatro plataformas.
 *
 * Sao tres coisas:
 *   1. o recuo das barras do sistema, que chega da Activity e vira variavel de CSS;
 *   2. o botao Voltar, que aqui faz o papel da tecla Esc;
 *   3. os ajustes que nao existem no Android (a WebUI do qBittorrent, a janela
 *      separada de video) saem da tela, e entra o que so existe aqui.
 */
(function () {
    // ------------------------------------------- 1. barras do sistema

    /*
     * A barra de status e a de navegacao ficam POR CIMA da pagina (a janela e
     * de borda a borda). Sem esse recuo, o nome "torrange" nasce debaixo do
     * relogio e os botoes do player, debaixo da barra de gestos.
     */
    window.__torrangeRecortes = function (recortes) {
        const raiz = document.documentElement;
        raiz.style.setProperty('--recorte-topo', `${Math.round(recortes.topo || 0)}px`);
        raiz.style.setProperty('--recorte-base', `${Math.round(recortes.base || 0)}px`);
        raiz.style.setProperty('--recorte-esquerda', `${Math.round(recortes.esquerda || 0)}px`);
        raiz.style.setProperty('--recorte-direita', `${Math.round(recortes.direita || 0)}px`);
    };

    // ------------------------------------------------ 2. botao Voltar

    /*
     * Devolve true quando o toque foi consumido aqui; false faz a Activity
     * fechar o aplicativo. A logica de fechar painel ou player ja existe em
     * `app.js`, na tecla Esc -- entao nos so a acionamos, em vez de manter uma
     * segunda copia que sairia do lugar na primeira mudanca.
     */
    window.__torrangeVoltar = function () {
        const painelAberto = ['#modal', '#ficha', '#confirmacao'].some((id) => {
            const el = document.querySelector(id);
            return el && !el.hidden;
        });
        const noPlayer = document.querySelector('#tela-player').classList.contains('ativa');

        if (painelAberto || noPlayer) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return true;
        }

        // Fora do acervo, Voltar leva ao acervo -- sair do aplicativo por
        // engano, no meio de um download, seria o pior desfecho possivel.
        const aba = document.querySelector('.aba.ativa');
        if (aba && aba.dataset.aba !== 'acervo') {
            document.querySelector('.aba[data-aba="acervo"]').click();
            return true;
        }
        return false;
    };

    // ------------------------------------------------- 3. os ajustes

    function ajustarTela() {
        const $ = (s) => document.querySelector(s);

        // A WebUI do qBittorrent nao existe aqui: o motor de torrent roda
        // dentro do processo, e nao ha porta nem senha para ninguem usar.
        const usuario = $('#cfg-qbit-usuario');
        if (usuario) {
            const grupo = usuario.closest('fieldset');
            if (grupo) grupo.hidden = true;
        }

        // "Abrir o video em janela separada" era a saida para a tela preta do
        // Windows. No Android o video sempre desenha na propria tela.
        const janela = $('#cfg-janela-separada');
        if (janela) {
            const rotulo = janela.closest('label');
            if (rotulo) rotulo.hidden = true;
        }

        // O que so existe aqui: continuar baixando com a tela apagada.
        const sequencial = $('#cfg-sequencial');
        if (sequencial && !$('#cfg-segundo-plano')) {
            const rotulo = document.createElement('label');
            rotulo.className = 'campo-switch';
            rotulo.innerHTML =
                '<input type="checkbox" id="cfg-segundo-plano">' +
                '<span>Continuar baixando com a tela apagada' +
                '<small>desligado, os downloads param quando o aplicativo sai da frente — ' +
                'poupa bateria e dados</small></span>';
            sequencial.closest('label').after(rotulo);

            const caixa = rotulo.querySelector('input');
            window.torrange.config.ler().then((cfg) => {
                caixa.checked = cfg.baixarEmSegundoPlano !== false;
            });
            // Salva na hora: este ajuste nao passa pelo botao Salvar, que so
            // conhece os campos do desktop.
            caixa.addEventListener('change', () => {
                window.torrange.config.gravar({ baixarEmSegundoPlano: caixa.checked });
            });
        }

        // Onde o texto do desktop fala em "computador".
        for (const el of document.querySelectorAll('.gate-texto, .dica')) {
            if (el.textContent.includes('computador')) {
                el.textContent = el.textContent
                    .replace(/neste computador/g, 'neste aparelho')
                    .replace(/deste computador/g, 'deste aparelho');
            }
        }

        // A pasta de downloads: no Android a escolha e entre a memoria interna
        // e o cartao, entao o rotulo do botao diz isso.
        const botaoPasta = $('#btn-pasta');
        if (botaoPasta) botaoPasta.textContent = 'Trocar…';
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ajustarTela);
    } else {
        ajustarTela();
    }
})();
