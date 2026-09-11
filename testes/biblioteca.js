'use strict';
/**
 * Pastas, capas e edicao da biblioteca.
 *
 * Usa um video real do disco para ter uma entrada de verdade na biblioteca
 * (o caminho vem por argumento). O arquivo do usuario nunca e apagado.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { Alvo, acharAlvo, encerrarApp, espera, RAIZ } = require('./cdp');

const PORTA_SITE = 47130;
const PORTA_CDP = 9337;

// PNG 1x1 valido, para servir de capa nos testes
const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const VIDEO = process.argv[2];
if (!VIDEO || !fs.existsSync(VIDEO)) {
    console.error('uso: node testes/biblioteca.js /caminho/para/video.mkv');
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
    return bencode({
        announce: `http://127.0.0.1:${PORTA_SITE}/announce`,
        info: { length: dados.length, name: path.basename(caminho), 'piece length': tamanhoPeca, pieces: Buffer.concat(pedacos) },
    });
}

// -------------------------------------------------------------- execucao
(async () => {
    console.log('== Teste de pastas, capas e edicao da biblioteca ==\n');
    console.log('  preparando o torrent do arquivo...');
    const torrent = torrentDoArquivo(VIDEO);

    const servidor = http.createServer((req, res) => {
        if (req.url.startsWith('/baixar/')) {
            res.writeHead(200, {
                'Content-Type': 'application/x-bittorrent',
                'Content-Disposition': 'attachment; filename="teste.torrent"',
                'Content-Length': torrent.length,
            });
            res.end(torrent);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<a href="/baixar/1">Baixar</a>');
    });
    await new Promise((r) => servidor.listen(PORTA_SITE, '127.0.0.1', r));

    const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'torrange-teste-'));
    fs.writeFileSync(path.join(perfil, 'config.json'), JSON.stringify({
        siteUrl: `http://127.0.0.1:${PORTA_SITE}/`,
        pastaDownloads: path.dirname(VIDEO),
    }, null, 2));

    const capaTeste = path.join(perfil, 'capa-de-teste.png');
    fs.writeFileSync(capaTeste, Buffer.from(PNG, 'base64'));

    const ambiente = { ...process.env };
    delete ambiente.ELECTRON_RUN_AS_NODE;
    const app = spawn(require('electron'),
        ['.', `--remote-debugging-port=${PORTA_CDP}`, `--user-data-dir=${perfil}`],
        { cwd: RAIZ, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] });

    let ui = null;
    const errosDeConsole = [];

    try {
        const alvoUi = await acharAlvo(PORTA_CDP, (a) => a.url.includes('renderer/index.html'));
        if (!alvoUi) throw new Error('a interface do app nao apareceu');
        ui = await Alvo.conectar(alvoUi.webSocketDebuggerUrl);
        ui.vigiarErros('interface', errosDeConsole);
        await ui.enviar('Runtime.enable');
        await espera(1000);

        // Uma entrada de verdade na biblioteca. Entra pela caixa de endereco
        // da aba Downloads: a biblioteca nao depende de como o torrent chegou.
        await ui.avaliar(
            `window.torrange.fila.adicionarUrl(${JSON.stringify(`http://127.0.0.1:${PORTA_SITE}/baixar/1`)})`
        );
        let entrada = null;
        for (let i = 0; i < 120; i++) {
            await espera(1000);
            const lista = await ui.avaliar('window.torrange.biblioteca.listar()');
            entrada = lista[0];
            if (entrada && entrada.pronto) break;
        }
        checar('o titulo entrou na biblioteca', !!entrada, entrada && entrada.nome);
        if (!entrada) throw new Error('nada na biblioteca');
        const hash = entrada.hash;
        const nomeOriginal = entrada.nome;

        // ------------------------------------------------------------ pastas
        const serie = await ui.avaliar(
            `window.torrange.biblioteca.criarPasta({ nome: 'Séries' })`
        );
        checar('criar pasta', !!(serie && serie.id), serie && serie.nome);

        const temporada = await ui.avaliar(
            `window.torrange.biblioteca.criarPasta({ nome: 'Temporada 1', pai: ${JSON.stringify(serie.id)} })`
        );
        checar('criar subpasta dentro de outra', temporada && temporada.pai === serie.id,
            `pai: ${temporada && temporada.pai}`);

        // uma pasta nao pode virar filha de si mesma
        await ui.avaliar(
            `window.torrange.biblioteca.editarPasta(${JSON.stringify(serie.id)}, { pai: ${JSON.stringify(temporada.id)} })`
        );
        const pastas = await ui.avaliar('window.torrange.biblioteca.pastas()');
        const serieDepois = pastas.find((p) => p.id === serie.id);
        checar('impede mover uma pasta para dentro da propria subpasta',
            !serieDepois.pai, `pai virou: ${serieDepois.pai}`);

        // ------------------------------------------------------------ edicao
        await ui.avaliar(`window.torrange.biblioteca.editarTitulo(${JSON.stringify(hash)}, {
            nome: 'President Curtis — T1E07',
            descricao: 'Episódio de teste, com acentuação: ação, coração.',
            etiquetas: 'drama, teste, assistido',
            pasta: ${JSON.stringify(temporada.id)}
        })`);

        let lista = await ui.avaliar('window.torrange.biblioteca.listar()');
        let item = lista.find((e) => e.hash === hash);
        checar('nome de exibicao trocado', item.nome === 'President Curtis — T1E07', item.nome);
        checar('nome original preservado', item.nomeOriginal === nomeOriginal, item.nomeOriginal);
        checar('descricao gravada', /coração/.test(item.descricao || ''), item.descricao);
        checar('etiquetas viraram lista', Array.isArray(item.etiquetas) && item.etiquetas.length === 3,
            JSON.stringify(item.etiquetas));
        checar('titulo foi para a subpasta', item.pasta === temporada.id, item.pasta);

        // nome de um arquivo especifico
        const caminhoArquivo = item.arquivos[0].caminho;
        await ui.avaliar(
            `window.torrange.biblioteca.editarArquivo(${JSON.stringify(hash)}, ${JSON.stringify(caminhoArquivo)}, 'Episódio 7 — o final')`
        );
        lista = await ui.avaliar('window.torrange.biblioteca.listar()');
        item = lista.find((e) => e.hash === hash);
        checar('nome do arquivo trocado', item.arquivos[0].nome === 'Episódio 7 — o final', item.arquivos[0].nome);
        checar('caminho em disco intacto', item.arquivos[0].caminho === caminhoArquivo);

        // ------------------------------------------------------------- capas
        const r = await ui.avaliar(
            `window.torrange.biblioteca.definirCapa({ tipo: 'titulo', id: ${JSON.stringify(hash)} }, { arquivo: ${JSON.stringify(capaTeste)} })`
        );
        checar('definir capa a partir de um arquivo', !!(r && r.ok), JSON.stringify(r));

        lista = await ui.avaliar('window.torrange.biblioteca.listar()');
        item = lista.find((e) => e.hash === hash);
        checar('a capa aparece na biblioteca', /^capa:\/\//.test(item.capa || ''), item.capa);

        // a imagem precisa realmente carregar pelo protocolo capa://
        const carregou = await ui.avaliar(`new Promise((res) => {
            const i = new Image();
            i.onload = () => res('ok ' + i.naturalWidth + 'x' + i.naturalHeight);
            i.onerror = () => res('erro ao carregar');
            i.src = ${JSON.stringify('PLACEHOLDER')};
        })`.replace('"PLACEHOLDER"', JSON.stringify(item.capa)));
        checar('o protocolo capa:// serve a imagem', /^ok/.test(carregou), carregou);

        // caminho malicioso nao pode escapar da pasta de capas
        const escapou = await ui.avaliar(`new Promise((res) => {
            const i = new Image();
            i.onload = () => res('SERVIU (falha de seguranca)');
            i.onerror = () => res('bloqueado');
            i.src = 'capa://img/..%2F..%2Fconfig.json';
        })`);
        checar('nao serve arquivos fora da pasta de capas', escapou === 'bloqueado', escapou);

        // ------------------------------------ o que foi editado sobrevive ao sync
        console.log('\n  esperando ciclos de sincronizacao com o qBittorrent...');
        await espera(4000);
        lista = await ui.avaliar('window.torrange.biblioteca.listar()');
        item = lista.find((e) => e.hash === hash);
        checar('a sincronizacao nao apaga o que foi editado',
            item.nome === 'President Curtis — T1E07' &&
                item.pasta === temporada.id &&
                (item.etiquetas || []).length === 3 &&
                /^capa:\/\//.test(item.capa || ''),
            `nome=${item.nome} pasta=${item.pasta} etiquetas=${(item.etiquetas || []).length} capa=${!!item.capa}`);

        // -------------------------------------------- excluir pasta nao perde nada
        await ui.avaliar(`window.torrange.biblioteca.removerPasta(${JSON.stringify(temporada.id)})`);
        lista = await ui.avaliar('window.torrange.biblioteca.listar()');
        item = lista.find((e) => e.hash === hash);
        checar('excluir a subpasta sobe o titulo para a pasta de cima',
            item.pasta === serie.id, `pasta agora: ${item.pasta}`);
        checar('o arquivo em disco continua la', fs.existsSync(caminhoArquivo));

        checar('a interface rodou sem erro de console', errosDeConsole.length === 0,
            errosDeConsole.join('\n         '));

        try {
            await ui.avaliar(`window.torrange.fila.remover(${JSON.stringify(hash)}, false)`);
        } catch { /* ja pode ter caido */ }
    } catch (erro) {
        console.log(`\n[ FALHA] erro durante o teste: ${erro.message}`);
        falhas++;
    } finally {
        if (ui) ui.fechar();
        await encerrarApp(PORTA_CDP, app);
        servidor.close();
        fs.rmSync(perfil, { recursive: true, force: true });
        checar('o video do usuario continua intacto', fs.existsSync(VIDEO));
    }

    console.log(`\n== ${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} teste(s) falharam`} ==`);
    process.exit(falhas === 0 ? 0 : 1);
})();
