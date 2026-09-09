'use strict';
/**
 * Navegacao da interface: cada aba tem de abrir e ficar CLICAVEL.
 *
 * Existe por causa de um bug real da 1.0.2: uma regra `.modal { display: grid }`
 * venceu o `[hidden] { display: none }` do navegador (regra de autor ganha da
 * folha do agente), e o painel de edicao ficou permanentemente aberto por cima
 * de tudo. Nenhum teste percebeu porque nenhum clicava nas abas -- a aba do
 * site parecia normal, ja que a view nativa e desenhada por cima do HTML.
 *
 * Nao precisa de torrent nem de rede: sobe o app apontado para uma pagina local.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { Alvo, acharAlvo, encerrarApp, espera, RAIZ } = require('./cdp');

const PORTA_SITE = 47140;
const PORTA_CDP = 9338;

let falhas = 0;
function checar(descricao, condicao, detalhe) {
    console.log(`[${condicao ? '  OK  ' : ' FALHA'}] ${descricao}${detalhe ? `\n         ${detalhe}` : ''}`);
    if (!condicao) falhas++;
}

const ABAS = [
    ['site', 'tela-site'],
    ['fila', 'tela-fila'],
    ['biblioteca', 'tela-biblioteca'],
    ['config', 'tela-config'],
];

(async () => {
    console.log('== Teste de navegacao da interface ==\n');

    const servidor = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>página de teste</h1>');
    });
    await new Promise((r) => servidor.listen(PORTA_SITE, '127.0.0.1', r));

    const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'torrange-teste-'));
    fs.writeFileSync(path.join(perfil, 'config.json'), JSON.stringify({
        siteUrl: `http://127.0.0.1:${PORTA_SITE}/`,
        pastaDownloads: path.join(perfil, 'downloads'),
    }, null, 2));

    const ambiente = { ...process.env };
    delete ambiente.ELECTRON_RUN_AS_NODE;

    // TORRANGE_BIN aponta para um app JA EMPACOTADO (AppRun da AppImage, por
    // exemplo). Sem a variavel, roda o codigo-fonte deste diretorio.
    const empacotado = process.env.TORRANGE_BIN;
    const app = empacotado
        ? spawn(empacotado, [`--remote-debugging-port=${PORTA_CDP}`, `--user-data-dir=${perfil}`],
            { env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(require('electron'),
            ['.', `--remote-debugging-port=${PORTA_CDP}`, `--user-data-dir=${perfil}`],
            { cwd: RAIZ, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] });

    console.log(`  testando: ${empacotado || 'código-fonte'}\n`);

    let ui = null;
    const errosDeConsole = [];

    try {
        const alvo = await acharAlvo(PORTA_CDP, (a) => a.url.includes('renderer/index.html'));
        if (!alvo) throw new Error('a interface nao apareceu');
        ui = await Alvo.conectar(alvo.webSocketDebuggerUrl);
        ui.vigiarErros('interface', errosDeConsole);
        await ui.enviar('Runtime.enable');
        await espera(1200);

        // ---------------------------------------------- nada de [hidden] visivel
        const teimosos = await ui.avaliar(`
            Array.from(document.querySelectorAll('[hidden]'))
                .map((el) => ({ id: el.id || el.className, display: getComputedStyle(el).display }))
                .filter((x) => x.display !== 'none')
        `);
        checar('todo elemento com [hidden] esta realmente escondido',
            teimosos.length === 0,
            teimosos.length ? JSON.stringify(teimosos) : '');

        // ------------------------------------------------- cada aba abre e clica
        for (const [aba, tela] of ABAS) {
            const r = await ui.avaliar(`(() => {
                document.querySelector('.aba[data-aba="${aba}"]').click();
                const ativa = document.querySelector('.tela.ativa');
                const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
                return {
                    ativa: ativa && ativa.id,
                    alvo: el ? (el.id || el.className || el.tagName) : null,
                    dentroDaTela: !!(el && ativa && ativa.contains(el)),
                    cobertoPorModal: !!(el && el.closest('#modal')),
                };
            })()`);

            checar(`aba "${aba}": a tela certa fica ativa`, r.ativa === tela, `ativa: ${r.ativa}`);
            checar(`aba "${aba}": o centro da tela recebe o clique`,
                r.dentroDaTela && !r.cobertoPorModal,
                `no centro: ${r.alvo}${r.cobertoPorModal ? ' (COBERTO PELO PAINEL DE EDICAO)' : ''}`);
            await espera(150);
        }

        // ------------------------------------------ o painel abre e fecha mesmo
        const comPainel = await ui.avaliar(`(() => {
            const m = document.getElementById('modal');
            m.hidden = false;
            const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
            return { display: getComputedStyle(m).display, pegaOClique: !!(el && el.closest('#modal')) };
        })()`);
        checar('o painel de edicao aparece quando aberto',
            comPainel.display !== 'none' && comPainel.pegaOClique, JSON.stringify(comPainel));

        const semPainel = await ui.avaliar(`(() => {
            const m = document.getElementById('modal');
            m.hidden = true;
            const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
            return { display: getComputedStyle(m).display, pegaOClique: !!(el && el.closest('#modal')) };
        })()`);
        checar('o painel some quando fechado',
            semPainel.display === 'none' && !semPainel.pegaOClique, JSON.stringify(semPainel));

        // ------------------------------------------------ os ajustes respondem
        const ajustes = await ui.avaliar(`(() => {
            document.querySelector('.aba[data-aba="config"]').click();
            const caixa = document.getElementById('cfg-janela-separada');
            const antes = caixa.checked;
            caixa.click();
            return { mudou: caixa.checked !== antes, temPastaDownloads: !!document.getElementById('cfg-pasta').value };
        })()`);
        checar('os controles de Ajustes respondem ao clique', ajustes.mudou);
        checar('Ajustes mostra a pasta de downloads', ajustes.temPastaDownloads);

        // ------------------------------------------- a biblioteca desenha o topo
        const bib = await ui.avaliar(`(() => {
            document.querySelector('.aba[data-aba="biblioteca"]').click();
            return {
                caminho: document.getElementById('caminho-biblioteca').textContent.trim(),
                temBotaoNovaPasta: !!document.getElementById('btn-nova-pasta'),
            };
        })()`);
        checar('a Biblioteca mostra a trilha de navegacao', bib.caminho.includes('Biblioteca'), bib.caminho);
        checar('a Biblioteca tem o botao de nova pasta', bib.temBotaoNovaPasta);

        checar('a interface rodou sem erro de console', errosDeConsole.length === 0,
            errosDeConsole.join('\n         '));
    } catch (erro) {
        console.log(`\n[ FALHA] erro durante o teste: ${erro.message}`);
        falhas++;
    } finally {
        if (ui) ui.fechar();
        await encerrarApp(PORTA_CDP, app);
        servidor.close();
        fs.rmSync(perfil, { recursive: true, force: true });
    }

    console.log(`\n== ${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} teste(s) falharam`} ==`);
    process.exit(falhas === 0 ? 0 : 1);
})();
