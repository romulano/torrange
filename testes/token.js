'use strict';
/**
 * As recusas da API do aplicativo, uma a uma.
 *
 * O que este teste protege e a tabela de erros da especificacao: cada codigo
 * leva o app para um lugar diferente, e confundir dois deles da o pior tipo de
 * bug -- o que manda o usuario reinstalar quando bastava esperar, ou o que
 * deixa a tela dizendo "conectado" enquanto nada responde.
 *
 *   token_invalido      -> volta para a tela do token, e o token morto e apagado
 *   assinatura_inativa  -> tela de erro (nao a do token: o token continua bom)
 *   conta_inativa       -> tela de erro, sem insistir
 *   sem_vaga            -> tela de erro dizendo para remover um aparelho
 *
 * E, antes de tudo, o que a especificacao chama de "guardar o id de instalacao
 * para sempre": reabrir o app NAO pode gastar outra das tres vagas.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { Alvo, acharAlvo, encerrarApp, espera, pegarJson, RAIZ } = require('./cdp');

const PORTA_SITE = 47150;
const PORTA_CDP = 9339;
const BASE = `http://127.0.0.1:${PORTA_SITE}`;

let falhas = 0;
function checar(descricao, condicao, detalhe) {
    console.log(`[${condicao ? '  OK  ' : ' FALHA'}] ${descricao}${detalhe ? `\n         ${detalhe}` : ''}`);
    if (!condicao) falhas++;
}

function controlar(caminho, corpo) {
    return new Promise((resolve, reject) => {
        const dados = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
        const req = http.request(
            {
                host: '127.0.0.1',
                port: PORTA_SITE,
                path: `/_teste${caminho}`,
                method: 'POST',
                headers: dados
                    ? { 'Content-Type': 'application/json', 'Content-Length': dados.length }
                    : {},
            },
            (res) => {
                const p = [];
                res.on('data', (d) => p.push(d));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(p).toString()));
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );
        req.on('error', reject);
        if (dados) req.write(dados);
        req.end();
    });
}

const estadoDoServidor = () => pegarJson(PORTA_SITE, '/_teste/estado');

function subirApp(perfil) {
    const ambiente = { ...process.env };
    delete ambiente.ELECTRON_RUN_AS_NODE;
    return spawn(
        require('electron'),
        ['.', `--remote-debugging-port=${PORTA_CDP}`, `--user-data-dir=${perfil}`],
        { cwd: RAIZ, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] }
    );
}

async function conectarNaInterface() {
    const alvo = await acharAlvo(PORTA_CDP, (a) => a.url.includes('renderer/index.html'));
    if (!alvo) throw new Error('a interface nao apareceu');
    const ui = await Alvo.conectar(alvo.webSocketDebuggerUrl);
    await ui.enviar('Runtime.enable');
    return ui;
}

/** Qual das tres caixas da porta de entrada esta na tela agora. */
const LER_TELA = `(() => ({
    fase: document.querySelector('#cfg-conexao-fase').textContent,
    token: !document.querySelector('#painel-token').hidden,
    espera: !document.querySelector('#painel-espera').hidden,
    erro: !document.querySelector('#painel-erro-conexao').hidden,
    acervo: !document.querySelector('#acervo-conteudo').hidden,
    tituloDoErro: document.querySelector('#erro-conexao-titulo').textContent,
    textoDoErro: document.querySelector('#erro-conexao-texto').textContent,
}))()`;

/** Clica em "verificar agora" e espera a resposta assentar. */
async function verificar(ui) {
    await ui.avaliar(`window.torrange.conexao.verificar()`);
    await espera(600);
    return ui.avaliar(LER_TELA);
}

(async () => {
    console.log('== Teste das recusas da API do aplicativo ==\n');

    const servidor = spawn(process.execPath, [path.join(__dirname, 'servidor-falso.js'), String(PORTA_SITE)], {
        stdio: 'inherit',
    });
    await espera(700);

    const { token: TOKEN } = await estadoDoServidor();
    await controlar('/aprovar'); // neste teste o dono ja autorizou de antemao

    const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'torrange-token-'));
    fs.writeFileSync(
        path.join(perfil, 'config.json'),
        JSON.stringify(
            {
                siteUrl: `${BASE}/`,
                apiUrl: `${BASE}/api/aplicativo`,
                nomeDoAparelho: 'Aparelho do Teste de Token',
                pastaDownloads: path.join(perfil, 'downloads'),
            },
            null,
            2
        )
    );
    // O formato "claro:" e o que o app usa quando a maquina nao tem cofre de
    // credenciais -- serve para semear o token sem passar pela tela.
    fs.writeFileSync(path.join(perfil, 'token.bin'), `claro:${TOKEN}`, { mode: 0o600 });

    let app = subirApp(perfil);
    let ui = null;
    let instalacaoInicial = '';

    try {
        ui = await conectarNaInterface();
        await espera(1500);

        // ------------------------------------------ token guardado = sem login
        let tela = await ui.avaliar(LER_TELA);
        checar(
            'com o token já cadastrado, o app entra direto — sem tela de login',
            tela.acervo && !tela.token && !tela.espera && !tela.erro,
            JSON.stringify(tela)
        );

        const info = await ui.avaliar('window.torrange.info()');
        instalacaoInicial = info.conexao.instalacao;
        checar(
            'o token guardado sem cofre fica em arquivo próprio, nunca no config.json',
            !JSON.stringify(await ui.avaliar('window.torrange.config.ler()')).includes(TOKEN)
        );

        // ------------------------------------------- reabrir não gasta outra vaga
        let servidorAntes = await estadoDoServidor();
        checar(
            'o app ocupou exatamente uma vaga',
            servidorAntes.instalacoes.length === 1,
            `${servidorAntes.instalacoes.length} aparelho(s)`
        );

        ui.fechar();
        await encerrarApp(PORTA_CDP, app);
        await espera(800);

        app = subirApp(perfil);
        ui = await conectarNaInterface();
        await espera(1800);

        const infoDepois = await ui.avaliar('window.torrange.info()');
        checar(
            'reabrir o app mantém o mesmo identificador de instalação',
            infoDepois.conexao.instalacao === instalacaoInicial,
            `${instalacaoInicial} -> ${infoDepois.conexao.instalacao}`
        );

        const servidorDepois = await estadoDoServidor();
        checar(
            'e não gasta outra das três vagas da conta',
            servidorDepois.instalacoes.length === 1,
            `${servidorDepois.instalacoes.length} aparelho(s)`
        );

        // --------------------------------------------------- assinatura vencida
        await controlar('/ajustar', { assinaturaAtiva: false });
        tela = await verificar(ui);
        checar(
            'assinatura vencida leva à tela de erro, não à do token',
            tela.erro && !tela.token && !tela.acervo,
            JSON.stringify(tela)
        );
        checar(
            'e a mensagem manda resolver no site',
            /assinatura/i.test(tela.textoDoErro),
            tela.textoDoErro
        );
        checar(
            'o token continua guardado (a assinatura é outro problema)',
            fs.existsSync(path.join(perfil, 'token.bin'))
        );

        await controlar('/ajustar', { assinaturaAtiva: true });
        tela = await verificar(ui);
        checar('resolvida a assinatura, o acervo volta sozinho', tela.acervo, JSON.stringify(tela));

        // -------------------------------------------------------- conta removida
        await controlar('/ajustar', { contaAtiva: false });
        tela = await verificar(ui);
        checar(
            'conta removida leva à tela de erro',
            tela.erro && /removida/i.test(tela.textoDoErro),
            tela.textoDoErro
        );
        await controlar('/ajustar', { contaAtiva: true });
        await verificar(ui);

        // ------------------------------------------------- o dono girou o token
        await controlar('/ajustar', { token: 'Z'.repeat(100) });
        tela = await verificar(ui);
        checar(
            'token girado no site leva de volta à tela do token',
            tela.token && !tela.acervo && !tela.erro,
            JSON.stringify(tela)
        );
        checar(
            'e o token morto é apagado do disco — guardá-lo só faria o app falhar calado',
            !fs.existsSync(path.join(perfil, 'token.bin'))
        );

        // --------------------------------------------------------- sem vaga
        await controlar('/ajustar', { token: TOKEN });
        await controlar('/esquecer-aparelhos');
        await controlar('/ajustar', { vagas: 0 });

        const r = await ui.avaliar(
            `window.torrange.conexao.definirToken(${JSON.stringify(TOKEN)})`
        );
        await espera(800);
        tela = await ui.avaliar(LER_TELA);
        checar(
            'sem vaga, o app diz que é preciso remover um aparelho no site',
            tela.erro && /três aplicativos|tres aplicativos/i.test(tela.textoDoErro),
            `${tela.tituloDoErro} — ${tela.textoDoErro}`
        );
        checar('e o token colado continua guardado para quando abrir vaga', !!r.ok);

        // ----------------------------------------------- desconectar o aparelho
        await ui.avaliar('window.torrange.conexao.esquecer()');
        await espera(500);
        tela = await ui.avaliar(LER_TELA);
        checar(
            'desconectar volta para a tela do token',
            tela.token && !tela.acervo,
            JSON.stringify(tela)
        );
        checar(
            'e apaga o token guardado',
            !fs.existsSync(path.join(perfil, 'token.bin'))
        );
    } catch (erro) {
        console.log(`\n[ FALHA] erro durante o teste: ${erro.message}`);
        falhas++;
    } finally {
        if (ui) ui.fechar();
        await encerrarApp(PORTA_CDP, app);
        servidor.kill();
        fs.rmSync(perfil, { recursive: true, force: true });
    }

    console.log(`\n== ${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} teste(s) falharam`} ==`);
    process.exit(falhas === 0 ? 0 : 1);
})();
