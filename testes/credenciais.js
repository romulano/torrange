'use strict';
/**
 * O que este teste protege:
 *
 *   1. A configuração é escrita com OS DOIS nomes que o qBittorrent usa --
 *      qBittorrent.ini (Windows) e qBittorrent.conf (resto). Escrever só o
 *      .conf fazia o qBittorrent do Windows ignorar tudo: subia sem o nosso
 *      usuário e senha, o login falhava e nada era baixado.
 *   2. Usuário e senha definidos nos Ajustes valem de verdade: vão para a
 *      configuração, o qBittorrent aceita o login e a WebUI responde com eles.
 *   3. A senha do usuário não vaza para o arquivo de diagnóstico.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { Alvo, acharAlvo, encerrarApp, espera, RAIZ } = require('./cdp');

const PORTA_CDP = 9337;
const USUARIO = 'romulo';
const SENHA = 'uma-senha-bem-propria-42';

let falhas = 0;

function checar(descricao, condicao, detalhe) {
    console.log(`[${condicao ? '  OK  ' : ' FALHA'}] ${descricao}${detalhe ? `\n         ${detalhe}` : ''}`);
    if (!condicao) falhas++;
}

/** Login na WebUI por fora do app, com as credenciais que o usuário escolheu. */
function loginWebUI(porta, usuario, senha) {
    return new Promise((resolve) => {
        const corpo = new URLSearchParams({ username: usuario, password: senha }).toString();
        const req = http.request(
            {
                host: '127.0.0.1',
                port: porta,
                path: '/api/v2/auth/login',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(corpo),
                    Referer: `http://127.0.0.1:${porta}`,
                },
            },
            (res) => {
                const p = [];
                res.on('data', (d) => p.push(d));
                res.on('end', () =>
                    resolve({ status: res.statusCode, texto: Buffer.concat(p).toString() })
                );
            }
        );
        req.on('error', (e) => resolve({ status: 0, texto: e.message }));
        req.write(corpo);
        req.end();
    });
}

// ---------------------------------------------------------------- execucao
(async () => {
    console.log('== Teste: usuário e senha próprios do qBittorrent ==\n');

    const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'torrange-cred-'));
    fs.writeFileSync(
        path.join(perfil, 'config.json'),
        JSON.stringify({ pastaDownloads: path.join(perfil, 'downloads') }, null, 2)
    );

    const ambiente = { ...process.env };
    delete ambiente.ELECTRON_RUN_AS_NODE;
    const app = spawn(
        require('electron'),
        ['.', `--remote-debugging-port=${PORTA_CDP}`, `--user-data-dir=${perfil}`],
        { cwd: RAIZ, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    app.stdout.on('data', () => {});
    app.stderr.on('data', () => {});

    let ui = null;
    const pastaConfig = path.join(perfil, 'qbittorrent', 'qBittorrent', 'config');

    try {
        const alvo = await acharAlvo(PORTA_CDP, (a) => a.url.includes('renderer/index.html'));
        if (!alvo) throw new Error('a interface não apareceu');
        ui = await Alvo.conectar(alvo.webSocketDebuggerUrl);
        await ui.enviar('Runtime.enable');

        // espera o qBittorrent subir com as credenciais automáticas
        let estado = {};
        for (let i = 0; i < 80; i++) {
            await espera(500);
            estado = await ui.avaliar('window.torrange.qbit.estado()');
            if (estado.fase !== 'iniciando') break;
        }
        checar('o qBittorrent sobe com as credenciais automáticas', estado.fase === 'pronto',
            `${estado.fase}: ${estado.motivo || ''}`);

        // ----------------------------------------------------- requisito 1
        const escritos = fs.existsSync(pastaConfig) ? fs.readdirSync(pastaConfig) : [];
        checar(
            'a configuração é escrita nos dois nomes (.ini do Windows e .conf)',
            escritos.includes('qBittorrent.ini') && escritos.includes('qBittorrent.conf'),
            `na pasta: ${escritos.join(', ') || '(nada)'}`
        );

        const conteudos = ['qBittorrent.ini', 'qBittorrent.conf']
            .filter((n) => escritos.includes(n))
            .map((n) => fs.readFileSync(path.join(pastaConfig, n), 'utf8'));
        // não exigimos que fiquem idênticos: o qBittorrent reescreve o arquivo
        // que ele próprio usa enquanto roda. O que importa é os dois levarem a
        // configuração que o app escreveu.
        checar(
            'os dois arquivos levam a configuração escrita pelo app',
            conteudos.length === 2 && conteudos.every((c) => c.includes('Username=')),
            conteudos
                .map((c) => c.split('\n').find((l) => l.includes('Username=')) || '?')
                .join(' | ')
        );
        checar(
            'a WebUI é configurada só em 127.0.0.1',
            conteudos.every((c) => c.includes('Address=127.0.0.1'))
        );

        // ----------------------------------------------------- requisito 2
        await ui.avaliar(`
            window.torrange.config.gravar({
                qbitUsuario: ${JSON.stringify(USUARIO)},
                qbitSenha: ${JSON.stringify(SENHA)},
            })
        `);

        for (let i = 0; i < 80; i++) {
            await espera(500);
            estado = await ui.avaliar('window.torrange.qbit.estado()');
            if (estado.fase === 'pronto') break;
        }
        checar('o qBittorrent religa com as credenciais do usuário', estado.fase === 'pronto',
            `${estado.fase}: ${estado.motivo || ''}`);

        const info = await ui.avaliar('window.torrange.info()');
        checar(
            'o app informa o usuário escolhido, sem cair na senha temporária',
            info.qbitUsuario === USUARIO && info.qbitCredencialTemporaria === false,
            `usuário: ${info.qbitUsuario}, temporária: ${info.qbitCredencialTemporaria}`
        );

        const porta = Number(String(info.qbit).split(':')[1]);
        const entrada = await loginWebUI(porta, USUARIO, SENHA);
        checar(
            'a WebUI do qBittorrent aceita o usuário e a senha escolhidos',
            entrada.status === 200 || entrada.status === 204,
            `HTTP ${entrada.status} ${entrada.texto.slice(0, 60)}`
        );

        const recusada = await loginWebUI(porta, USUARIO, 'senha-errada');
        checar(
            'e recusa uma senha errada',
            recusada.status === 401 || /Fails/i.test(recusada.texto),
            `HTTP ${recusada.status} ${recusada.texto.slice(0, 60)}`
        );

        const confAtual = fs.readFileSync(path.join(pastaConfig, 'qBittorrent.ini'), 'utf8');
        checar(
            'a configuração guarda o usuário escolhido e a senha só como hash',
            confAtual.includes(`Username=${USUARIO}`) && !confAtual.includes(SENHA),
            confAtual.split('\n').find((l) => l.includes('Username')) || ''
        );

        // ----------------------------------------------------- requisito 3
        const arquivo = await ui.avaliar('window.torrange.diagnostico.gerar({ escolher: false })');
        const texto = fs.readFileSync(arquivo.caminho, 'utf8');
        checar(
            'o arquivo de diagnóstico não traz a senha do usuário',
            !texto.includes(SENHA),
            arquivo.caminho
        );
        checar(
            'mas registra que há uma senha definida',
            /omitida daqui/.test(texto)
        );
    } catch (erro) {
        console.log(`\n[ FALHA] erro durante o teste: ${erro.message}`);
        falhas++;
    } finally {
        if (ui) ui.fechar();
        await encerrarApp(PORTA_CDP, app);
        fs.rmSync(perfil, { recursive: true, force: true });
    }

    console.log(`\n== ${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} teste(s) falharam`} ==`);
    process.exit(falhas === 0 ? 0 : 1);
})();
