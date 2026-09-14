'use strict';
/*
 * Confere que a ponte do Android entrega à interface EXATAMENTE o mesmo
 * `window.torrange` que o preload do Electron entrega.
 *
 * Este teste existe porque a interface é uma só para as quatro plataformas: se
 * um método sumir, mudar de nome ou passar a mandar os argumentos noutra ordem,
 * a tela quebra no aparelho -- onde ninguém vê o console. Aqui quebra na hora,
 * no terminal, antes de virar APK.
 *
 * Roda sem navegador e sem Android:
 *
 *     node android/testes/ponte.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const raiz = path.join(__dirname, '..', '..');
const preloadDesktop = path.join(raiz, 'src', 'preload', 'app-preload.js');
const preloadAndroid = path.join(raiz, 'android', 'assets-extras', 'android-preload.js');

let falhas = 0;
function ok(nome) {
    console.log(`  ✓ ${nome}`);
}
function falhou(nome, erro) {
    falhas++;
    console.log(`  ✗ ${nome}\n      ${erro.message}`);
}
function teste(nome, fn) {
    try {
        fn();
        ok(nome);
    } catch (erro) {
        falhou(nome, erro);
    }
}

// --------------------------------------------------------------------------
// O contrato do desktop, lido do próprio arquivo

/**
 * Extrai do preload do Electron o mapa { "grupo.metodo": "canal" }.
 *
 * Ler o arquivo (em vez de manter uma lista à parte) é o que faz este teste
 * continuar valendo quando alguém acrescentar um método lá: a lista nova vem
 * junto, e o Android tem de acompanhar.
 */
function contratoDoDesktop() {
    const fonte = fs.readFileSync(preloadDesktop, 'utf8');
    const mapa = {};
    let grupo = '';

    for (const linha of fonte.split('\n')) {
        const abre = /^\s{4}(\w+):\s*\{/.exec(linha);
        if (abre) {
            grupo = abre[1];
            continue;
        }
        // A indentação é quem diz se o método é de um grupo (8 espaços) ou
        // solto no objeto (4) -- é o caso de `info`, que não tem grupo.
        const metodo = /^( +)(\w+):\s*\(.*?\)\s*=>\s*ipcRenderer\.(invoke|send)\(\s*'([^']+)'/.exec(linha);
        if (metodo) {
            const dentroDeGrupo = metodo[1].length > 4;
            const nome = dentroDeGrupo && grupo ? `${grupo}.${metodo[2]}` : metodo[2];
            mapa[nome] = metodo[4];
        }
    }

    // O único que não cabe no padrão de uma linha só.
    mapa['biblioteca.editarArquivo'] = 'biblioteca:editar-arquivo';
    return mapa;
}

// --------------------------------------------------------------------------
// A ponte do Android, carregada num mundo de mentira

function montarPonte() {
    const chamadas = [];
    const janela = {};

    const contexto = {
        window: janela,
        TorrangePonte: {
            chamar(id, canal, argumentos) {
                chamadas.push({ tipo: 'chamar', id, canal, argumentos: JSON.parse(argumentos) });
                // responde no próximo tique, como a Activity faz
                setTimeout(() => janela.__torrangeResposta(id, true, { eco: canal }), 0);
            },
            enviar(canal, argumentos) {
                chamadas.push({ tipo: 'enviar', canal, argumentos: JSON.parse(argumentos) });
            },
        },
        setTimeout,
        console,
    };
    contexto.globalThis = contexto;

    vm.createContext(contexto);
    vm.runInContext(fs.readFileSync(preloadAndroid, 'utf8'), contexto, { filename: 'android-preload.js' });

    return { api: janela.torrange, chamadas, janela };
}

function caminho(objeto, nome) {
    return nome.split('.').reduce((atual, parte) => (atual ? atual[parte] : undefined), objeto);
}

// --------------------------------------------------------------------------

console.log('ponte do Android × preload do desktop\n');

const contrato = contratoDoDesktop();
const { api, chamadas, janela } = montarPonte();

teste('o preload do desktop tem os métodos esperados', () => {
    assert.ok(Object.keys(contrato).length >= 40, `achei só ${Object.keys(contrato).length} métodos`);
});

teste('window.torrange existe', () => {
    assert.ok(api, 'a ponte não definiu window.torrange');
});

for (const [nome, canal] of Object.entries(contrato)) {
    teste(`${nome} → ${canal}`, () => {
        const fn = caminho(api, nome);
        assert.strictEqual(typeof fn, 'function', `${nome} não existe na ponte do Android`);

        chamadas.length = 0;
        fn('a', 'b');
        assert.strictEqual(chamadas.length, 1, `${nome} não falou com a ponte`);
        assert.strictEqual(chamadas[0].canal, canal, `mandou para ${chamadas[0].canal}`);
    });
}

teste('player.comando manda os argumentos do mpv num array só', () => {
    chamadas.length = 0;
    api.player.comando('seek', 30, 'relative');
    assert.deepStrictEqual(chamadas[0].argumentos, [['seek', 30, 'relative']]);
});

teste('os canais de evento são os mesmos do desktop', () => {
    const doDesktop = /const eventos = \[([\s\S]*?)\];/
        .exec(fs.readFileSync(preloadDesktop, 'utf8'))[1]
        .match(/'([^']+)'/g)
        .map((s) => s.replace(/'/g, ''));

    for (const canal of doDesktop) {
        let recebeu = null;
        const desligar = api.ao(canal, (dados) => {
            recebeu = dados;
        });
        janela.__torrangeEvento(canal, { valor: 42 });
        assert.deepStrictEqual(recebeu, { valor: 42 }, `o canal ${canal} não entregou`);

        // e o desligar tem de desligar mesmo
        desligar();
        recebeu = null;
        janela.__torrangeEvento(canal, { valor: 7 });
        assert.strictEqual(recebeu, null, `o canal ${canal} continuou entregando depois de desligado`);
    }
});

teste('um canal de evento desconhecido é recusado', () => {
    assert.throws(() => api.ao('canal:inventado', () => {}), /desconhecido/);
});

teste('a resposta da Activity resolve a promessa', async () => {
    const promessa = api.conexao.estado();
    assert.ok(promessa instanceof Promise);
});

/*
 * O outro lado da ponte: de nada adianta o JavaScript mandar para um canal que
 * o Kotlin não conhece -- a chamada morreria com "canal desconhecido", e só no
 * aparelho. A lista de canais do Ponte.kt é lida do próprio arquivo.
 */
teste('todo canal da interface existe no Ponte.kt', () => {
    const kotlin = fs.readFileSync(
        path.join(raiz, 'android', 'app', 'src', 'main', 'java', 'com', 'torrange', 'app', 'Ponte.kt'),
        'utf8'
    );
    const atendidos = new Set(
        (kotlin.match(/"[a-z]+:[a-z-]+"\s*->/g) || []).map((m) => m.replace(/"|\s|->/g, ''))
    );

    const faltando = [...new Set(Object.values(contrato))].filter((canal) => !atendidos.has(canal));
    assert.deepStrictEqual(faltando, [], `canais sem tratamento no Kotlin: ${faltando.join(', ')}`);
});

/*
 * A libtorrent entrega o add_torrent_params com `paused` e `auto_managed`
 * ligados de fábrica -- medido na própria biblioteca:
 *
 *     de fabrica         paused=true  auto_managed=true
 *     depois do ajuste   paused=false auto_managed=false
 *
 * Com eles, o torrent entra na fila e fica parado esperando o gerenciador
 * automático -- que foi o bug "vai para Downloads e não baixa, mesmo com
 * seeds". Se alguém tirar esse ajuste, o bug volta inteiro e em silêncio.
 */
teste('o motor desliga as flags que deixariam o torrent parado', () => {
    const motor = fs.readFileSync(
        path.join(raiz, 'android', 'app', 'src', 'main', 'java', 'com', 'torrange', 'app', 'Motor.kt'),
        'utf8'
    );
    const adicionar = /private fun adicionarParams[\s\S]*?\n    \}/.exec(motor);
    assert.ok(adicionar, 'não achei adicionarParams no Motor.kt');

    const trecho = adicionar[0];
    assert.ok(
        /TorrentFlags\.PAUSED\.inv\(\)/.test(trecho),
        'adicionarParams não limpa a flag PAUSED'
    );
    assert.ok(
        /TorrentFlags\.AUTO_MANAGED\.inv\(\)/.test(trecho),
        'adicionarParams não limpa a flag AUTO_MANAGED'
    );
});

teste('não existe caminho para LER o token', () => {
    const texto = JSON.stringify(api, (chave, valor) =>
        typeof valor === 'function' ? String(valor) : valor
    );
    assert.ok(!/lerToken|token:\s*\(\)/.test(texto), 'a ponte expõe leitura do token');
    assert.strictEqual(caminho(api, 'conexao.lerToken'), undefined);
});

console.log(
    falhas === 0
        ? '\nok — a ponte do Android fala o mesmo contrato do desktop'
        : `\n${falhas} falha(s)`
);
process.exit(falhas === 0 ? 0 : 1);
