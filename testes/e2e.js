'use strict';
/**
 * Teste de ponta a ponta, sem depender do site real nem de credenciais:
 *
 *   1. sobe um servidor local com o mesmo HTML do botao do torrange
 *   2. sobe o app apontado para ele (com o DevTools Protocol aberto)
 *   3. confere que o rotulo virou "Baixar" (sem ".torrent")
 *   4. clica no botao
 *   5. confere que o torrent chegou no qBittorrent embutido
 *   6. limpa tudo o que criou
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { Alvo, acharAlvo, encerrarApp, espera, RAIZ } = require('./cdp');

const PORTA_SITE = 47110;
const PORTA_CDP = 9333;

let falhas = 0;

function checar(descricao, condicao, detalhe) {
    console.log(`[${condicao ? '  OK  ' : ' FALHA'}] ${descricao}${detalhe ? `\n         ${detalhe}` : ''}`);
    if (!condicao) falhas++;
}

// ---------------------------------------------------------------- execucao
(async () => {
    console.log('== Teste de ponta a ponta do Torrange ==\n');

    const servidor = spawn(process.execPath, [path.join(__dirname, 'servidor-falso.js'), String(PORTA_SITE)], {
        stdio: 'inherit',
    });
    await espera(600);

    // Perfil proprio para o teste: nao encosta na configuracao, na fila de
    // torrents nem na biblioteca do app instalado -- e nao briga com ele pelo
    // lock de instancia unica do Electron, que e por pasta de dados.
    const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'torrange-teste-'));
    fs.writeFileSync(
        path.join(perfil, 'config.json'),
        JSON.stringify(
            {
                siteUrl: `http://127.0.0.1:${PORTA_SITE}/`,
                pastaDownloads: path.join(perfil, 'downloads'),
            },
            null,
            2
        )
    );

    const ambiente = { ...process.env };
    delete ambiente.ELECTRON_RUN_AS_NODE;
    const app = spawn(
        require('electron'),
        ['.', `--remote-debugging-port=${PORTA_CDP}`, `--user-data-dir=${perfil}`],
        { cwd: RAIZ, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const registro = [];
    app.stdout.on('data', (d) => registro.push(String(d)));
    app.stderr.on('data', (d) => registro.push(String(d)));

    let interface_ = null;
    let siteView = null;
    const errosDeConsole = [];

    try {
        const alvoSite = await acharAlvo(PORTA_CDP, (a) => a.url.includes(`:${PORTA_SITE}`));
        checar('a view do site carregou a pagina', !!alvoSite, alvoSite && alvoSite.url);
        if (!alvoSite) throw new Error('a view do site nao apareceu');

        const alvoUi = await acharAlvo(PORTA_CDP, (a) => a.url.includes('renderer/index.html'));
        checar('a interface do app carregou', !!alvoUi);
        if (!alvoUi) throw new Error('a interface nao apareceu');

        siteView = await Alvo.conectar(alvoSite.webSocketDebuggerUrl);
        interface_ = await Alvo.conectar(alvoUi.webSocketDebuggerUrl);
        interface_.vigiarErros('interface', errosDeConsole);
        siteView.vigiarErros('site', errosDeConsole);
        await siteView.enviar('Runtime.enable');
        await interface_.enviar('Runtime.enable');
        await espera(800);

        // a view nativa do site precisa estar sobre a area reservada pela interface
        const areaUi = await interface_.avaliar(`
            (() => { const r = document.querySelector('#area-site').getBoundingClientRect();
                     return { largura: Math.round(r.width), altura: Math.round(r.height) }; })()
        `);
        const areaSite = await siteView.avaliar('({ largura: window.innerWidth, altura: window.innerHeight })');
        checar(
            'a view do site esta posicionada sobre a area da interface',
            areaSite.largura > 100 &&
                areaSite.altura > 100 &&
                Math.abs(areaSite.largura - areaUi.largura) <= 2 &&
                Math.abs(areaSite.altura - areaUi.altura) <= 2,
            `interface reservou ${areaUi.largura}x${areaUi.altura}, o site ocupa ${areaSite.largura}x${areaSite.altura}`
        );

        // ---------------------------------------------------- requisito 4
        const rotulos = await siteView.avaliar(`
            Array.from(document.querySelectorAll('a.botao-baixar')).map((a) => ({
                visivel: a.innerText.replace(/\\s+/g, ' ').trim(),
                sufixoEscondido: (() => {
                    const s = a.querySelector('.sufixo');
                    return s ? getComputedStyle(s).display === 'none' : null;
                })(),
            }))
        `);
        console.log('\n  rotulos lidos da pagina:', JSON.stringify(rotulos), '\n');

        checar(
            'botao com span.sufixo: o ".torrent" some da tela',
            rotulos[0] && rotulos[0].sufixoEscondido === true && !/\.torrent/i.test(rotulos[0].visivel),
            `lido: "${rotulos[0] && rotulos[0].visivel}"`
        );
        checar(
            'botao sem span (texto cru): o preload limpa o ".torrent"',
            rotulos[1] && !/\.torrent/i.test(rotulos[1].visivel),
            `lido: "${rotulos[1] && rotulos[1].visivel}"`
        );
        checar(
            'a palavra "Baixar" continua no botao',
            rotulos.every((r) => /Baixar/i.test(r.visivel))
        );

        // ------------------------------------------------- requisitos 1 e 5
        const antes = await interface_.avaliar('window.torrange.fila.listar().then((l) => l.length)');
        await siteView.avaliar(`document.querySelectorAll('a.botao-baixar')[0].click(); true`);

        let fila = [];
        for (let i = 0; i < 40; i++) {
            await espera(500);
            fila = await interface_.avaliar('window.torrange.fila.listar()');
            if (fila.length > antes) break;
        }

        checar(
            'clicar em "Baixar" manda o torrent para o qBittorrent embutido',
            fila.length > antes,
            fila.length ? `na fila: ${fila.map((t) => t.name).join(', ')}` : 'a fila continuou vazia'
        );

        const novo = fila[0];
        if (novo) {
            checar('o torrent entrou na categoria propria do app', novo.category === 'torrange', `categoria: ${novo.category}`);
            checar('download sequencial ligado (permite assistir antes do fim)', novo.seq_dl === true, `seq_dl: ${novo.seq_dl}`);
            checar('prioridade nas primeiras/ultimas pecas', novo.f_l_piece_prio === true, `f_l_piece_prio: ${novo.f_l_piece_prio}`);
            checar(
                'salvando na pasta configurada',
                (novo.save_path || '').startsWith(perfil),
                `save_path: ${novo.save_path}`
            );
        }

        // o .torrent nao pode ter caido na pasta de Downloads do usuario
        const downloads = path.join(os.homedir(), 'Downloads');
        const sujeira = fs.existsSync(downloads)
            ? fs.readdirSync(downloads).filter((f) => /Filme de Teste.*\.torrent$/i.test(f))
            : [];
        checar('o arquivo .torrent nao foi parar na pasta Downloads', sujeira.length === 0, sujeira.join(', '));

        // ------------------------------------------------------- limpeza
        for (const t of fila) {
            await interface_.avaliar(`window.torrange.fila.remover(${JSON.stringify(t.hash)}, true)`);
        }
        console.log('\n  (torrents de teste removidos da fila)');

        checar('a interface rodou sem erro de console', errosDeConsole.length === 0,
            errosDeConsole.join('\n         '));
    } catch (erro) {
        console.log(`\n[ FALHA] erro durante o teste: ${erro.message}`);
        falhas++;
    } finally {
        if (interface_) interface_.fechar();
        if (siteView) siteView.fechar();
        await encerrarApp(PORTA_CDP, app);
        servidor.kill();

        fs.rmSync(perfil, { recursive: true, force: true });

        const erros = registro.join('').split('\n').filter((l) => /Error:|Erro/.test(l) && !/ozone|Vulkan|MESA|gpu_process|command_buffer|x11_software|GPU/.test(l));
        if (erros.length) console.log('\n  erros no log do app:\n   ' + erros.join('\n   '));
    }

    console.log(`\n== ${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} teste(s) falharam`} ==`);
    process.exit(falhas === 0 ? 0 : 1);
})();
