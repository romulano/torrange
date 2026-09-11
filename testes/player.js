'use strict';
/**
 * Testa os requisitos 2 e 6 com um MKV real de multiplas faixas:
 *
 *   - gera um .torrent do arquivo que ja existe em disco
 *   - manda pelo app (mesma interceptacao de download do fluxo real)
 *   - o qBittorrent confere os pedacos e marca como concluido
 *   - a biblioteca indexa o video
 *   - o player abre, lista audios e legendas, troca faixa, pausa e busca
 *
 * O arquivo do usuario NUNCA e apagado: a remocao no final usa deleteFiles=false.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { Alvo, acharAlvo, encerrarApp, espera, RAIZ } = require('./cdp');

const PORTA_SITE = 47120;
const PORTA_CDP = 9334;

const VIDEO = process.argv[2];
if (!VIDEO || !fs.existsSync(VIDEO)) {
    console.error('uso: node testes/player.js /caminho/para/video.mkv');
    process.exit(2);
}

let falhas = 0;

function checar(descricao, condicao, detalhe) {
    console.log(`[${condicao ? '  OK  ' : ' FALHA'}] ${descricao}${detalhe ? `\n         ${detalhe}` : ''}`);
    if (!condicao) falhas++;
}

// ---------------------------------------------------------------- bencode
function bencode(v) {
    if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v]);
    if (typeof v === 'string') return bencode(Buffer.from(v, 'utf8'));
    if (typeof v === 'number') return Buffer.from(`i${Math.floor(v)}e`);
    if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(bencode), Buffer.from('e')]);
    const ks = Object.keys(v).sort();
    return Buffer.concat([Buffer.from('d'), ...ks.flatMap((k) => [bencode(k), bencode(v[k])]), Buffer.from('e')]);
}

function torrentDoArquivo(caminho) {
    const tamanhoPeca = 4 * 1024 * 1024;
    const dados = fs.readFileSync(caminho);
    const pedacos = [];
    for (let i = 0; i < dados.length; i += tamanhoPeca) {
        pedacos.push(crypto.createHash('sha1').update(dados.subarray(i, i + tamanhoPeca)).digest());
    }
    const info = {
        length: dados.length,
        name: path.basename(caminho),
        'piece length': tamanhoPeca,
        pieces: Buffer.concat(pedacos),
    };
    return bencode({ announce: `http://127.0.0.1:${PORTA_SITE}/announce`, info });
}

// -------------------------------------------------------------- execucao
(async () => {
    console.log('== Teste do player e da biblioteca ==\n');
    console.log(`  arquivo: ${path.basename(VIDEO)}`);
    console.log('  gerando .torrent (conferindo os pedacos do arquivo)...');
    const torrent = torrentDoArquivo(VIDEO);
    console.log(`  .torrent com ${torrent.length} bytes\n`);

    const servidor = http.createServer((req, res) => {
        if (req.url.startsWith('/baixar/')) {
            res.writeHead(200, {
                'Content-Type': 'application/x-bittorrent',
                'Content-Disposition': `attachment; filename="${path.basename(VIDEO, '.mkv')}.torrent"`,
                'Content-Length': torrent.length,
            });
            res.end(torrent);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<a href="/baixar/1">Baixar</a>`);
    });
    await new Promise((r) => servidor.listen(PORTA_SITE, '127.0.0.1', r));

    // Perfil proprio: o teste nao toca na configuracao, na fila nem na
    // biblioteca do app instalado, e roda em paralelo com ele sem conflito
    // (o lock de instancia unica do Electron e por pasta de dados).
    const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'torrange-teste-'));
    fs.writeFileSync(path.join(perfil, 'config.json'), JSON.stringify({
        siteUrl: `http://127.0.0.1:${PORTA_SITE}/`,
        pastaDownloads: path.dirname(VIDEO),
    }, null, 2));

    const ambiente = { ...process.env };
    delete ambiente.ELECTRON_RUN_AS_NODE;
    const app = spawn(require('electron'),
        ['.', `--remote-debugging-port=${PORTA_CDP}`, `--user-data-dir=${perfil}`],
        { cwd: RAIZ, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] });
    const registro = [];
    app.stdout.on('data', (d) => registro.push(String(d)));
    app.stderr.on('data', (d) => registro.push(String(d)));

    let ui = null, hash = null;

    try {
        const alvoUi = await acharAlvo(PORTA_CDP, (a) => a.url.includes('renderer/index.html'));
        if (!alvoUi) throw new Error('a interface do app nao apareceu');
        ui = await Alvo.conectar(alvoUi.webSocketDebuggerUrl);
        await ui.enviar('Runtime.enable');
        await espera(1000);

        // ------------------------------------------------------ requisito 5
        // O player nao depende de como o torrent chegou: entra pela caixa de
        // endereco da aba Downloads.
        await ui.avaliar(
            `window.torrange.fila.adicionarUrl(${JSON.stringify(`http://127.0.0.1:${PORTA_SITE}/baixar/1`)})`
        );
        let fila = [];
        for (let i = 0; i < 40; i++) {
            await espera(500);
            fila = await ui.avaliar('window.torrange.fila.listar()');
            if (fila.length) break;
        }
        checar('o torrent do arquivo real entrou na fila', fila.length > 0,
            fila.map((t) => `${t.name} [${t.state}]`).join(', '));
        if (!fila.length) throw new Error('nada entrou na fila');
        hash = fila[0].hash;

        // ------------------------------------------------------ requisito 6
        console.log('\n  aguardando o qBittorrent conferir os pedacos do arquivo...');
        let entrada = null;
        for (let i = 0; i < 120; i++) {
            await espera(1000);
            const biblioteca = await ui.avaliar('window.torrange.biblioteca.listar()');
            entrada = biblioteca.find((e) => e.hash === hash);
            if (entrada && entrada.pronto) break;
            if (i % 10 === 9) console.log(`   ...${entrada ? `${(entrada.progresso * 100).toFixed(1)}%` : 'indexando'}`);
        }
        checar('ao concluir, o titulo aparece na biblioteca', !!entrada,
            entrada ? `"${entrada.nome}"` : 'nao apareceu');
        checar('a biblioteca marca como concluido', !!(entrada && entrada.pronto),
            entrada ? `progresso: ${(entrada.progresso * 100).toFixed(1)}%` : '');
        checar('o video ficou disponivel para o play', !!(entrada && entrada.reproduzivel));
        checar('a biblioteca aponta para o arquivo em disco',
            !!(entrada && entrada.arquivos.some((a) => a.caminho === VIDEO && a.existe)),
            entrada ? entrada.arquivos.map((a) => a.caminho).join(', ') : '');

        // ------------------------------------------------------ requisito 2
        console.log('\n  abrindo o player...');
        const abertura = await ui.avaliar(
            `window.torrange.player.abrir(${JSON.stringify({ hash, caminho: VIDEO })})`
        );
        checar('o mpv abriu acoplado a janela do app (--wid)', abertura && abertura.embutido === true,
            `embutido: ${abertura && abertura.embutido}`);

        await espera(3000);
        const faixas = await ui.avaliar('window.torrange.player.faixas()');
        console.log('\n  audios:  ' + faixas.audio.map((f) => `#${f.id} ${f.idioma} ${f.codec} ${f.canais}ch`).join(' | '));
        console.log('  legendas: ' + faixas.legenda.map((f) => `#${f.id} ${f.idioma}`).join(' | ') + '\n');

        checar('o player lista as faixas de audio do MKV', faixas.audio.length >= 2,
            `${faixas.audio.length} faixa(s)`);
        checar('o player lista as faixas de legenda', faixas.legenda.length >= 2,
            `${faixas.legenda.length} faixa(s)`);
        checar('o audio em portugues foi escolhido por padrao',
            faixas.audio.some((f) => f.selecionada && /pt/i.test(f.idioma)),
            faixas.audio.filter((f) => f.selecionada).map((f) => f.idioma).join(','));

        // troca de faixa de audio
        const outro = faixas.audio.find((f) => !f.selecionada);
        await ui.avaliar(`window.torrange.player.comando('set_property', 'aid', ${outro.id})`);
        await espera(1200);
        const aid = await ui.avaliar(`window.torrange.player.comando('get_property', 'aid')`);
        checar('trocar a faixa de audio funciona', String(aid) === String(outro.id),
            `pedi aid=${outro.id}, o mpv esta em aid=${aid}`);

        // troca de legenda
        const legenda = faixas.legenda[faixas.legenda.length - 1];
        await ui.avaliar(`window.torrange.player.comando('set_property', 'sid', ${legenda.id})`);
        await espera(800);
        const sid = await ui.avaliar(`window.torrange.player.comando('get_property', 'sid')`);
        checar('trocar a legenda funciona', String(sid) === String(legenda.id),
            `pedi sid=${legenda.id}, o mpv esta em sid=${sid}`);

        // desligar legenda
        await ui.avaliar(`window.torrange.player.comando('set_property', 'sid', 'no')`);
        await espera(600);
        const semLegenda = await ui.avaliar(`window.torrange.player.comando('get_property', 'sid')`);
        checar('desligar a legenda funciona', semLegenda === false || semLegenda === 'no',
            `sid: ${JSON.stringify(semLegenda)}`);

        // reproducao de fato andando
        const t1 = await ui.avaliar(`window.torrange.player.comando('get_property', 'time-pos')`);
        await espera(2500);
        const t2 = await ui.avaliar(`window.torrange.player.comando('get_property', 'time-pos')`);
        checar('o video esta realmente sendo reproduzido', Number(t2) > Number(t1),
            `time-pos: ${Number(t1).toFixed(1)}s -> ${Number(t2).toFixed(1)}s`);

        // busca
        await ui.avaliar(`window.torrange.player.comando('seek', 300, 'absolute')`);
        await espera(1500);
        const t3 = await ui.avaliar(`window.torrange.player.comando('get_property', 'time-pos')`);
        checar('buscar uma posicao funciona', Math.abs(Number(t3) - 300) < 15, `time-pos: ${Number(t3).toFixed(1)}s`);

        // pausa
        await ui.avaliar(`window.torrange.player.comando('set_property', 'pause', true)`);
        await espera(500);
        const pausado = await ui.avaliar(`window.torrange.player.comando('get_property', 'pause')`);
        checar('pausar funciona', pausado === true);

        const duracao = await ui.avaliar(`window.torrange.player.comando('get_property', 'duration')`);
        checar('o player conhece a duracao do video', Number(duracao) > 0, `${Number(duracao).toFixed(0)}s`);

        // posicao guardada para continuar depois
        await ui.avaliar(`window.torrange.player.salvarPosicao(${JSON.stringify({ hash, caminho: VIDEO })} && {hash: ${JSON.stringify(hash)}, caminho: ${JSON.stringify(VIDEO)}, segundos: 300, duracao: ${Number(duracao)}})`);
        await espera(900);
        const bib = await ui.avaliar('window.torrange.biblioteca.listar()');
        const guardada = bib.find((e) => e.hash === hash);
        checar('a posicao de onde parou fica guardada',
            !!(guardada && guardada.posicoes && guardada.posicoes[VIDEO]),
            guardada && guardada.posicoes ? JSON.stringify(guardada.posicoes[VIDEO]) : 'nada guardado');

        await ui.avaliar('window.torrange.player.fechar()');
    } catch (erro) {
        console.log(`\n[ FALHA] erro durante o teste: ${erro.message}`);
        falhas++;
    } finally {
        // remove da fila SEM apagar o arquivo do usuario
        if (ui && hash) {
            try {
                await ui.avaliar(`window.torrange.fila.remover(${JSON.stringify(hash)}, false)`);
            } catch { /* app pode ja ter caido */ }
        }
        if (ui) ui.fechar();
        await encerrarApp(PORTA_CDP, app);
        servidor.close();

        fs.rmSync(perfil, { recursive: true, force: true });
        checar('o arquivo de video do usuario continua intacto', fs.existsSync(VIDEO));

        const erros = registro.join('').split('\n')
            .filter((l) => /Error:/.test(l) && !/ozone|Vulkan|MESA|gpu|GPU|command_buffer|x11_software|EGL/.test(l));
        if (erros.length) console.log('\n  erros no log do app:\n   ' + erros.join('\n   '));
    }

    console.log(`\n== ${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} teste(s) falharam`} ==`);
    process.exit(falhas === 0 ? 0 : 1);
})();
