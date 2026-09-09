'use strict';
/**
 * Verifica os artefatos gerados pelo build no Docker:
 *   - os instaladores esperados existem
 *   - os binarios de terceiros foram realmente empacotados
 *   - o app empacotado sobe e usa o qbittorrent-nox de DENTRO do pacote
 *     (nao o do sistema nem o de um Docker do usuario)
 */
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Alvo, acharAlvo, encerrarApp, espera, RAIZ } = require('./cdp');

const DIST = path.join(RAIZ, 'dist');
const PORTA_CDP = 9336;
let falhas = 0;

function checar(descricao, condicao, detalhe) {
    console.log(`[${condicao ? '  OK  ' : ' FALHA'}] ${descricao}${detalhe ? `\n         ${detalhe}` : ''}`);
    if (!condicao) falhas++;
}

function tamanho(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

(async () => {
    console.log('== Verificacao dos pacotes gerados ==\n');

    if (!fs.existsSync(DIST)) {
        console.log('[ FALHA] a pasta dist/ nao existe -- rode ./build.sh antes');
        process.exit(1);
    }

    const arquivos = fs.readdirSync(DIST);
    const achar = (re) => arquivos.find((f) => re.test(f));

    const esperados = [
        ['instalador do Windows (.exe)', /^Torrange-Setup-.*\.exe$/],
        ['portatil do Windows (.zip)', /^Torrange-.*win.*\.zip$/],
        ['AppImage do Linux', /\.AppImage$/],
        ['pacote .deb do Linux', /\.deb$/],
    ];
    for (const [rotulo, re] of esperados) {
        const f = achar(re);
        checar(rotulo, !!f, f ? `${f} (${tamanho(fs.statSync(path.join(DIST, f)).size)})` : 'nao encontrado');
    }

    // ---------------------------------------------- binarios dentro do .exe
    const zipWin = achar(/^Torrange-.*win.*\.zip$/);
    if (zipWin) {
        const lista = execSync(`unzip -Z1 "${path.join(DIST, zipWin)}"`, { encoding: 'utf8' });
        checar('o pacote do Windows traz o qbittorrent-nox.exe',
            /resources[\/\\]bin[\/\\]qbittorrent[\/\\]qbittorrent-nox\.exe/i.test(lista));
        checar('o pacote do Windows traz o mpv.exe',
            /resources[\/\\]bin[\/\\]mpv[\/\\]mpv\.exe/i.test(lista));
    }

    // -------------------------------------------- binarios dentro da AppImage
    const appimage = achar(/\.AppImage$/);
    if (!appimage) {
        console.log('\n== sem AppImage para testar ==');
        process.exit(falhas === 0 ? 0 : 1);
    }

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'torrange-pacote-'));
    const caminhoApp = path.join(DIST, appimage);
    fs.chmodSync(caminhoApp, 0o755);
    execSync(`cd "${temp}" && "${caminhoApp}" --appimage-extract >/dev/null`);

    const extraido = ['squashfs-root', 'AppDir']
        .map((d) => path.join(temp, d))
        .find((d) => fs.existsSync(path.join(d, 'AppRun')));
    checar('a AppImage extrai corretamente', !!extraido);
    if (!extraido) process.exit(1);

    const real = fs.realpathSync(extraido);
    const qbitEmpacotado = path.join(real, 'resources', 'bin', 'qbittorrent', 'qbittorrent-nox');
    const mpvEmpacotado = path.join(real, 'resources', 'bin', 'mpv', 'AppRun');

    checar('o qbittorrent-nox esta dentro do pacote', fs.existsSync(qbitEmpacotado),
        fs.existsSync(qbitEmpacotado) ? tamanho(fs.statSync(qbitEmpacotado).size) : qbitEmpacotado);
    checar('o mpv esta dentro do pacote', fs.existsSync(mpvEmpacotado));
    checar('o qbittorrent-nox empacotado tem permissao de execucao',
        fs.existsSync(qbitEmpacotado) && !!(fs.statSync(qbitEmpacotado).mode & 0o111));
    checar('os hooks de rede do mpv (yt-dlp / auto-update) foram removidos',
        !fs.existsSync(path.join(real, 'resources', 'bin', 'mpv', 'bin', '05-get-yt-dlp.hook')) &&
        !fs.existsSync(path.join(real, 'resources', 'bin', 'mpv', 'bin', '10-self-updater.hook')));

    // ------------------------------------- o app empacotado usa o proprio qbit
    console.log('\n  subindo o app empacotado...');
    const ambiente = { ...process.env };
    delete ambiente.ELECTRON_RUN_AS_NODE;
    const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'torrange-teste-'));
    const app = spawn(path.join(real, 'AppRun'),
        [`--remote-debugging-port=${PORTA_CDP}`, `--user-data-dir=${perfil}`],
        { env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] });
    const registro = [];
    app.stdout.on('data', (d) => registro.push(String(d)));
    app.stderr.on('data', (d) => registro.push(String(d)));

    let ui = null;
    try {
        const alvo = await acharAlvo(PORTA_CDP, (a) => a.url.includes('renderer/index.html'));
        checar('o app empacotado abre', !!alvo);
        if (!alvo) throw new Error('a interface nao apareceu');

        ui = await Alvo.conectar(alvo.webSocketDebuggerUrl);
        await ui.enviar('Runtime.enable');

        let info = null;
        for (let i = 0; i < 60; i++) {
            await espera(1000);
            info = await ui.avaliar('window.torrange.info()');
            if (info.qbit !== 'parado') break;
        }

        console.log(`\n  qbit:  ${info.binarios.qbit}\n  mpv:   ${info.binarios.mpv}\n  webui: ${info.qbit}\n`);

        checar('o app roda em modo empacotado', info.empacotado === true);
        checar('o qBittorrent usado vem de DENTRO do pacote',
            info.binarios.qbit.startsWith(real) || info.binarios.qbit.includes('/resources/bin/'),
            info.binarios.qbit);
        checar('o mpv usado vem de DENTRO do pacote',
            info.binarios.mpv.startsWith(real) || info.binarios.mpv.includes('/resources/bin/'),
            info.binarios.mpv);
        checar('o qBittorrent embutido subiu', info.qbit !== 'parado', info.qbit);

        // conferindo pelo processo: nada de /app/qbittorrent-nox ou /usr/bin
        const processos = execSync('pgrep -af "qbittorrent[-]nox" || true', { encoding: 'utf8' }).trim();
        console.log(`  processos qbittorrent-nox rodando:\n   ${processos.split('\n').join('\n   ') || '(nenhum)'}\n`);
        checar('o processo do qBittorrent aponta para o binario do pacote',
            processos.includes(path.join(real, 'resources', 'bin', 'qbittorrent')));
    } catch (erro) {
        console.log(`\n[ FALHA] ${erro.message}`);
        falhas++;
    } finally {
        if (ui) ui.fechar();
        await encerrarApp(PORTA_CDP, app);
        fs.rmSync(temp, { recursive: true, force: true });
        fs.rmSync(perfil, { recursive: true, force: true });
        const erros = registro.join('').split('\n')
            .filter((l) => /Error:/.test(l) && !/ozone|Vulkan|MESA|gpu|GPU|command_buffer|x11_software|EGL/.test(l));
        if (erros.length) console.log('  erros no log do app:\n   ' + erros.join('\n   '));
    }

    console.log(`\n== ${falhas === 0 ? 'PACOTES VERIFICADOS' : `${falhas} verificacao(oes) falharam`} ==`);
    process.exit(falhas === 0 ? 0 : 1);
})();
