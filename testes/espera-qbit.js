'use strict';
/**
 * O que este teste protege:
 *
 * Clicar em "Baixar" antes de o qBittorrent estar no ar nao pode jogar o
 * torrent fora. Era o que acontecia -- aparecia "o qBittorrent ainda esta
 * iniciando" e o arquivo capturado se perdia, entao o clique nao valia nada.
 *
 *   1. qBittorrent LENTO: o torrent fica guardado e entra na fila sozinho
 *      assim que ele responde, sem o usuario clicar de novo.
 *   2. qBittorrent QUEBRADO: a falha fica na tela (nao num aviso que some em
 *      4 segundos), com o motivo e o registro do processo a um clique.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Alvo, acharAlvo, encerrarApp, espera, RAIZ } = require('./cdp');

const PORTA_SITE = 47112;
const PORTA_CDP = 9335;
const DEMORA = 12; // segundos que o qbittorrent-nox falso leva para subir

let falhas = 0;

function checar(descricao, condicao, detalhe) {
    console.log(`[${condicao ? '  OK  ' : ' FALHA'}] ${descricao}${detalhe ? `\n         ${detalhe}` : ''}`);
    if (!condicao) falhas++;
}

/** Envolve o qbittorrent-nox de verdade num atraso, para simular o Windows lento. */
function criarQbitLento(pasta) {
    const real = path.join(RAIZ, 'resources', 'bin', 'linux', 'qbittorrent', 'qbittorrent-nox');
    const script = path.join(pasta, 'qbit-lento.sh');
    fs.writeFileSync(script, `#!/usr/bin/env bash\nsleep ${DEMORA}\nexec ${JSON.stringify(real)} "$@"\n`);
    fs.chmodSync(script, 0o755);
    return { script, real };
}

function subirApp(perfil, qbitFalso) {
    const ambiente = { ...process.env, TORRANGE_QBIT: qbitFalso };
    delete ambiente.ELECTRON_RUN_AS_NODE;
    return spawn(
        require('electron'),
        ['.', `--remote-debugging-port=${PORTA_CDP}`, `--user-data-dir=${perfil}`],
        { cwd: RAIZ, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] }
    );
}

function prepararPerfil() {
    const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'torrange-espera-'));
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
    return perfil;
}

async function conectar(app) {
    const alvoSite = await acharAlvo(PORTA_CDP, (a) => a.url.includes(`:${PORTA_SITE}`));
    const alvoUi = await acharAlvo(PORTA_CDP, (a) => a.url.includes('renderer/index.html'));
    if (!alvoSite || !alvoUi) throw new Error('o app nao abriu as duas views');
    const siteView = await Alvo.conectar(alvoSite.webSocketDebuggerUrl);
    const ui = await Alvo.conectar(alvoUi.webSocketDebuggerUrl);
    await siteView.enviar('Runtime.enable');
    await ui.enviar('Runtime.enable');
    return { siteView, ui };
}

// ---------------------------------------------------------------- execucao
(async () => {
    console.log('== Teste: clicar em Baixar antes do qBittorrent subir ==\n');

    const servidor = spawn(
        process.execPath,
        [path.join(__dirname, 'servidor-falso.js'), String(PORTA_SITE)],
        { stdio: 'inherit' }
    );
    await espera(600);

    const oficina = fs.mkdtempSync(path.join(os.tmpdir(), 'torrange-oficina-'));
    const { script: qbitLento, real } = criarQbitLento(oficina);

    if (!fs.existsSync(real)) {
        console.log(`[ FALHA] qbittorrent-nox nao encontrado em ${real}. Rode "npm run binaries".`);
        servidor.kill();
        process.exit(1);
    }

    // ------------------------------------------------ 1. qBittorrent lento
    let perfil = prepararPerfil();
    let app = subirApp(perfil, qbitLento);
    let ui = null;
    let siteView = null;

    try {
        ({ ui, siteView } = await conectar(app));
        await espera(800);

        const inicial = await ui.avaliar('window.torrange.qbit.estado()');
        checar(
            'com o qBittorrent ainda subindo, a tela diz que esta iniciando',
            inicial && inicial.fase === 'iniciando',
            `fase: ${inicial && inicial.fase}`
        );

        // clica em Baixar bem no meio da subida
        await siteView.avaliar(`document.querySelectorAll('a.botao-baixar')[0].click(); true`);
        await espera(1500);

        const guardado = await ui.avaliar('window.torrange.qbit.estado()');
        checar(
            'o torrent capturado fica guardado em vez de ser descartado',
            guardado && guardado.pendentes >= 1,
            `pendentes: ${guardado && guardado.pendentes}`
        );

        const faixa = await ui.avaliar(`
            (() => {
                document.querySelector('[data-aba="fila"]').click();
                const el = document.querySelector('#estado-qbit');
                return { visivel: !el.hidden, texto: el.innerText.replace(/\\s+/g, ' ').trim() };
            })()
        `);
        checar(
            'a aba Downloads explica a espera na propria tela',
            faixa.visivel && /iniciando/i.test(faixa.texto),
            faixa.texto
        );

        // o qbittorrent-nox falso responde depois de DEMORA segundos
        let fila = [];
        for (let i = 0; i < 60; i++) {
            await espera(1000);
            fila = await ui.avaliar('window.torrange.fila.listar()');
            if (fila.length) break;
        }
        checar(
            'o torrent que estava esperando entra na fila sozinho, sem clicar de novo',
            fila.length > 0,
            fila.length ? fila.map((t) => t.name).join(', ') : 'a fila continuou vazia'
        );

        const depois = await ui.avaliar(`
            (() => ({
                estado: window.torrange.qbit.estado(),
                faixaEscondida: document.querySelector('#estado-qbit').hidden,
            }))()
        `);
        const estadoFinal = await ui.avaliar('window.torrange.qbit.estado()');
        checar(
            'com o qBittorrent no ar a faixa some e nao sobra nada esperando',
            depois.faixaEscondida && estadoFinal.fase === 'pronto' && !estadoFinal.pendentes,
            JSON.stringify(estadoFinal)
        );

        for (const t of fila) {
            await ui.avaliar(`window.torrange.fila.remover(${JSON.stringify(t.hash)}, true)`);
        }
    } catch (erro) {
        console.log(`\n[ FALHA] erro na parte do qBittorrent lento: ${erro.message}`);
        falhas++;
    } finally {
        if (ui) ui.fechar();
        if (siteView) siteView.fechar();
        await encerrarApp(PORTA_CDP, app);
        fs.rmSync(perfil, { recursive: true, force: true });
    }

    // -------------------------------------------- 2. qBittorrent quebrado
    console.log('');
    perfil = prepararPerfil();
    app = subirApp(perfil, path.join(oficina, 'nao-existe-qbittorrent-nox'));
    ui = null;
    siteView = null;

    try {
        ({ ui, siteView } = await conectar(app));

        let estado = {};
        for (let i = 0; i < 40; i++) {
            await espera(500);
            estado = await ui.avaliar('window.torrange.qbit.estado()');
            if (estado.fase === 'erro') break;
        }
        checar(
            'quando o qBittorrent nao sobe, o app diz o motivo',
            estado.fase === 'erro' && /nao-existe-qbittorrent-nox/.test(estado.motivo || ''),
            `${estado.fase}: ${estado.motivo}`
        );

        await siteView.avaliar(`document.querySelectorAll('a.botao-baixar')[0].click(); true`);
        await espera(1500);
        const comFalha = await ui.avaliar('window.torrange.qbit.estado()');
        checar(
            'mesmo com o qBittorrent quebrado o torrent nao e jogado fora',
            comFalha.pendentes >= 1,
            `pendentes: ${comFalha.pendentes}`
        );

        const tela = await ui.avaliar(`
            (() => {
                document.querySelector('[data-aba="fila"]').click();
                const el = document.querySelector('#estado-qbit');
                return {
                    visivel: !el.hidden,
                    erro: el.classList.contains('erro'),
                    temBotaoTentar: !document.querySelector('#btn-qbit-tentar').hidden,
                    texto: el.innerText.replace(/\\s+/g, ' ').trim(),
                };
            })()
        `);
        checar(
            'a falha fica na tela, com botao de tentar de novo',
            tela.visivel && tela.erro && tela.temBotaoTentar,
            tela.texto
        );

        const diagnostico = await ui.avaliar('window.torrange.qbit.registro()');
        checar(
            'o diagnostico traz o caminho do binario e o ultimo erro',
            !!diagnostico.binario && !!diagnostico.ultimoErro,
            `${diagnostico.binario} -> ${diagnostico.ultimoErro}`
        );

        // ------------------------------------------- modo diagnostico (.log)
        const arquivo = await ui.avaliar(
            'window.torrange.diagnostico.gerar({ escolher: false })'
        );
        checar(
            'o modo diagnostico grava o arquivo .log',
            arquivo && arquivo.caminho && fs.existsSync(arquivo.caminho),
            `${arquivo && arquivo.caminho} (${arquivo && arquivo.bytes} bytes)`
        );

        if (arquivo && arquivo.caminho && fs.existsSync(arquivo.caminho)) {
            const texto = fs.readFileSync(arquivo.caminho, 'utf8');
            const secoes = [
                'Aplicação e sistema',
                'Caminhos',
                'Binários embutidos',
                'Configuração',
                'qBittorrent',
                'Player (mpv)',
                'Fila de downloads',
                'Registro do app',
            ];
            const faltando = secoes.filter((t) => !texto.includes(t));
            checar('o .log traz todas as seções', faltando.length === 0, `faltou: ${faltando.join(', ')}`);
            checar(
                'o .log explica por que o qBittorrent não subiu',
                /nao-existe-qbittorrent-nox/.test(texto),
                texto.length > 0 ? `${texto.length} caracteres` : 'arquivo vazio'
            );
            checar(
                'o .log inclui o que o app registrou desde que abriu',
                /\[main\]|\[error\]/.test(texto)
            );
            checar(
                'o .log não vaza a senha da WebUI do qBittorrent',
                !/Password_PBKDF2|@ByteArray/.test(texto)
            );
        }
    } catch (erro) {
        console.log(`\n[ FALHA] erro na parte do qBittorrent quebrado: ${erro.message}`);
        falhas++;
    } finally {
        if (ui) ui.fechar();
        if (siteView) siteView.fechar();
        await encerrarApp(PORTA_CDP, app);
        fs.rmSync(perfil, { recursive: true, force: true });
        fs.rmSync(oficina, { recursive: true, force: true });
        servidor.kill();
    }

    console.log(`\n== ${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} teste(s) falharam`} ==`);
    process.exit(falhas === 0 ? 0 : 1);
})();
