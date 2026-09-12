'use strict';
/**
 * Teste de ponta a ponta da comunicacao por token, sem depender do site real:
 *
 *   1. sobe um servidor local que fala a API do aplicativo
 *   2. sobe o app apontado para ele, SEM token cadastrado
 *   3. confere que aparece a tela do token -- e nenhuma tela de login
 *   4. recusa um token fora do formato, aceita o de 100 caracteres
 *   5. confere a tela de espera enquanto o aparelho nao foi autorizado
 *   6. "autoriza" no site e confere que o acervo aparece sozinho
 *   7. baixa uma opcao free: o .torrent chega ao qBittorrent e nada e cobrado
 *   8. baixa uma opcao paga: confirma o preco e confere que debitou UMA vez
 *   9. confere as outras entradas da aba Downloads (endereco direto, pagina
 *      com o link dentro, e redirecionamento de CDN)
 *  10. limpa tudo o que criou
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { Alvo, acharAlvo, encerrarApp, espera, pegarJson, RAIZ } = require('./cdp');

const PORTA_SITE = 47110;
const PORTA_CDP = 9333;
const BASE = `http://127.0.0.1:${PORTA_SITE}`;

let falhas = 0;

function checar(descricao, condicao, detalhe) {
    console.log(`[${condicao ? '  OK  ' : ' FALHA'}] ${descricao}${detalhe ? `\n         ${detalhe}` : ''}`);
    if (!condicao) falhas++;
}

/** POST simples nas rotas de controle do servidor de teste. */
function controlar(caminho) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port: PORTA_SITE, path: `/_teste${caminho}`, method: 'POST' },
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
        req.end();
    });
}

const estadoDoServidor = () => pegarJson(PORTA_SITE, '/_teste/estado');

// ---------------------------------------------------------------- execucao
(async () => {
    console.log('== Teste de ponta a ponta do Torrange (comunicação por token) ==\n');

    const servidor = spawn(process.execPath, [path.join(__dirname, 'servidor-falso.js'), String(PORTA_SITE)], {
        stdio: 'inherit',
    });
    await espera(700);

    const { token: TOKEN } = await estadoDoServidor();

    // Perfil proprio para o teste: nao encosta na configuracao, no token, na
    // fila de torrents nem na biblioteca do app instalado -- e nao briga com
    // ele pelo lock de instancia unica do Electron, que e por pasta de dados.
    const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'torrange-teste-'));
    fs.writeFileSync(
        path.join(perfil, 'config.json'),
        JSON.stringify(
            {
                siteUrl: `${BASE}/`,
                apiUrl: `${BASE}/api/aplicativo`,
                nomeDoAparelho: 'Aparelho de Teste',
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

    let ui = null;
    const errosDeConsole = [];

    try {
        const alvoUi = await acharAlvo(PORTA_CDP, (a) => a.url.includes('renderer/index.html'));
        checar('a interface do app carregou', !!alvoUi);
        if (!alvoUi) throw new Error('a interface nao apareceu');

        ui = await Alvo.conectar(alvoUi.webSocketDebuggerUrl);
        ui.vigiarErros('interface', errosDeConsole);
        await ui.enviar('Runtime.enable');
        await espera(900);

        // ------------------------------------------------------ requisito 3
        const semNavegador = await ui.avaliar(`
            ({
                temAreaDeSite: !!document.querySelector('#area-site'),
                temNavDoSite: !!document.querySelector('#nav-site'),
                temTelaDeToken: !!document.querySelector('#painel-token'),
                telaDeTokenVisivel: !document.querySelector('#painel-token').hidden,
                acervoEscondido: document.querySelector('#acervo-conteudo').hidden,
            })
        `);
        checar(
            'não existe mais a aba do site nem tela de login',
            !semNavegador.temAreaDeSite && !semNavegador.temNavDoSite,
            JSON.stringify(semNavegador)
        );
        checar(
            'sem token, o app mostra a tela para colar o token',
            semNavegador.telaDeTokenVisivel && semNavegador.acervoEscondido
        );

        // o token nunca pode voltar para a interface
        const info = await ui.avaliar('window.torrange.info()');
        const pontes = await ui.avaliar('Object.keys(window.torrange.conexao)');
        checar(
            'a ponte da interface não oferece nenhum jeito de ler o token',
            !pontes.some((nome) => /^(ler|obter)/i.test(nome)),
            `métodos expostos: ${pontes.join(', ')}`
        );
        checar(
            'o identificador do aparelho tem o tamanho que a API aceita (8 a 64)',
            /^[A-Za-z0-9._:-]{8,64}$/.test(info.conexao.instalacao),
            `${info.conexao.instalacao.length} caracteres`
        );

        // ------------------------------------------------------ requisito 4
        const curto = await ui.avaliar(`
            (async () => {
                document.querySelector('#campo-token').value = 'abc123';
                document.querySelector('#campo-token').dispatchEvent(new Event('input'));
                document.querySelector('#btn-salvar-token').click();
                await new Promise((r) => setTimeout(r, 500));
                const erro = document.querySelector('#erro-token');
                return { visivel: !erro.hidden, texto: erro.textContent };
            })()
        `);
        checar(
            'um token fora do formato é recusado antes de sair da máquina',
            curto.visivel && /100 caracteres/.test(curto.texto),
            curto.texto
        );

        const antesDaConexao = await estadoDoServidor();
        checar(
            'e o app nem chega a chamar a API com ele',
            !antesDaConexao.chamadas.conexao,
            JSON.stringify(antesDaConexao.chamadas)
        );

        // ------------------------------------------------------ requisito 5
        await ui.avaliar(`
            (async () => {
                document.querySelector('#campo-token').value = ${JSON.stringify(TOKEN)};
                document.querySelector('#campo-token').dispatchEvent(new Event('input'));
                document.querySelector('#btn-salvar-token').click();
                await new Promise((r) => setTimeout(r, 1200));
            })()
        `);

        const espera1 = await ui.avaliar(`
            ({
                esperaVisivel: !document.querySelector('#painel-espera').hidden,
                tokenVisivel: !document.querySelector('#painel-token').hidden,
                acervoEscondido: document.querySelector('#acervo-conteudo').hidden,
                aparelho: document.querySelector('#espera-aparelho').textContent,
                mascarado: document.querySelector('#espera-token').textContent,
            })
        `);
        checar(
            'com o token aceito e sem autorização, aparece a tela de espera',
            espera1.esperaVisivel && !espera1.tokenVisivel && espera1.acervoEscondido,
            JSON.stringify(espera1)
        );
        checar(
            'a tela de espera mostra o nome que o site vai exibir',
            espera1.aparelho === 'Aparelho de Teste',
            espera1.aparelho
        );
        checar(
            'o token aparece mascarado, nunca inteiro',
            espera1.mascarado.includes('…') && !espera1.mascarado.includes(TOKEN),
            espera1.mascarado
        );

        const tudoQueAInterfaceVe = await ui.avaliar(`
            (async () => JSON.stringify([
                await window.torrange.info(),
                await window.torrange.conexao.estado(),
                await window.torrange.config.ler(),
            ]))()
        `);
        checar(
            'com o token guardado, ele não aparece em nada que a interface enxerga',
            !tudoQueAInterfaceVe.includes(TOKEN)
        );

        const comConexao = await estadoDoServidor();
        checar(
            'o app se apresentou ao site (POST /conexao)',
            comConexao.chamadas.conexao === 1 && comConexao.instalacoes.length === 1,
            JSON.stringify(comConexao.chamadas)
        );
        checar(
            'o mesmo identificador de instalação foi usado nos cabeçalhos',
            comConexao.instalacoes[0].instalacao === info.conexao.instalacao,
            `app: ${info.conexao.instalacao} · site: ${comConexao.instalacoes[0].instalacao}`
        );

        // ------------------------------------------------------ requisito 6
        await controlar('/aprovar');

        let aprovado = false;
        for (let i = 0; i < 24; i++) {
            await espera(1000);
            aprovado = await ui.avaliar(
                `!document.querySelector('#acervo-conteudo').hidden && document.querySelectorAll('#grade-acervo .cartao-acervo').length > 0`
            );
            if (aprovado) break;
        }
        checar('assim que o dono autoriza, o acervo aparece sozinho', aprovado);

        const depois = await estadoDoServidor();
        checar(
            'o app não repetiu /conexao em laço enquanto esperava',
            depois.chamadas.conexao <= 2,
            `${depois.chamadas.conexao} chamada(s) de /conexao, ${depois.chamadas.conta} de /conta`
        );

        const grade = await ui.avaliar(`
            ({
                cartoes: document.querySelectorAll('#grade-acervo .cartao-acervo').length,
                primeiro: (document.querySelector('#grade-acervo .cartao-acervo h3') || {}).textContent,
                temPoster: !!document.querySelector('#grade-acervo .cartao-acervo .poster'),
                temSeloRes: !!document.querySelector('#grade-acervo .cartao-acervo .selo-res'),
                temEstrela: !!document.querySelector('#grade-acervo .cartao-acervo .estrela'),
                gemas: document.querySelector('#gemas-barra').textContent,
                conta: document.querySelector('#conta-nome').textContent,
            })
        `);
        checar(
            'o cartão tem o desenho do site: pôster, selo de resolução e estrela',
            grade.temPoster && grade.temSeloRes && grade.temEstrela,
            JSON.stringify(grade)
        );
        checar('o acervo veio pela API', grade.cartoes >= 2, `${grade.cartoes} cartões`);
        checar('o card traz o título', /Duna/.test(grade.primeiro || ''), grade.primeiro);
        checar('a barra mostra o saldo de gemas', grade.gemas === '◆ 5', grade.gemas);
        checar('a barra mostra a conta', /Benedito/.test(grade.conta || ''), grade.conta);

        // ------------------------------------------------------ requisito 7
        const antes = await ui.avaliar('window.torrange.fila.listar().then((l) => l.length)');

        await ui.avaliar(`
            (async () => {
                const cartoes = Array.from(document.querySelectorAll('#grade-acervo .cartao-acervo'));
                const alvo = cartoes.find((c) => /Duna/.test(c.textContent));
                alvo.click();
                await new Promise((r) => setTimeout(r, 1200));
            })()
        `);

        const ficha = await ui.avaliar(`
            ({
                aberta: !document.querySelector('#ficha').hidden,
                titulo: document.querySelector('#ficha-titulo').textContent,
                subtitulo: document.querySelector('#ficha-subtitulo').textContent,
                cabecalho: document.querySelector('#titulo-opcoes').textContent,
                conta: document.querySelector('#conta-opcoes').textContent,
                opcoes: document.querySelectorAll('#ficha-opcoes .opcao').length,
                temTemporada: !!document.querySelector('#ficha-opcoes .temporada'),
                etiquetas: Array.from(document.querySelectorAll('#ficha-opcoes .etiqueta-free, #ficha-opcoes .etiqueta-preco')).map((e) => e.textContent),
                chips: Array.from(document.querySelectorAll('#ficha-chips > *')).map((e) => e.textContent),
            })
        `);
        checar('a ficha do título abre com as opções', ficha.aberta && ficha.opcoes === 2, JSON.stringify(ficha));
        checar(
            'um filme mostra "Opções de download", sem temporadas',
            ficha.cabecalho === 'Opções de download' && !ficha.temTemporada && /2 disponíveis/.test(ficha.conta),
            `${ficha.cabecalho} · ${ficha.conta}`
        );
        checar('a ficha mostra o que é free e o que custa gema',
            ficha.etiquetas.includes('free') && ficha.etiquetas.some((p) => /◆/.test(p)),
            ficha.etiquetas.join(' | '));
        checar(
            'o cabeçalho traz nota, categoria e faixa de tamanho, como no site',
            ficha.chips.some((c) => /IMDb/.test(c)) && ficha.chips.some((c) => /filme/.test(c)),
            ficha.chips.join(' | ')
        );

        // a ficha técnica abre ao escolher uma opção
        const tecnica = await ui.avaliar(`
            (async () => {
                document.querySelector('#ficha-opcoes .opcao .opcao-selecionar').click();
                await new Promise((r) => setTimeout(r, 200));
                const aberta = document.querySelector('#ficha-opcoes .opcao.aberta');
                return {
                    abriu: !!aberta,
                    campos: aberta ? aberta.querySelectorAll('.opcao-tecnica > div').length : 0,
                    visivel: aberta ? getComputedStyle(aberta.querySelector('.opcao-tecnica')).display : null,
                };
            })()
        `);
        checar(
            'escolher uma opção abre a ficha técnica embaixo dela',
            tecnica.abriu && tecnica.campos >= 4 && tecnica.visivel === 'grid',
            JSON.stringify(tecnica)
        );

        // baixar a opcao free
        await ui.avaliar(`
            (async () => {
                const opcoes = Array.from(document.querySelectorAll('#ficha-opcoes .opcao'));
                const free = opcoes.find((o) => o.querySelector('.etiqueta-free'));
                free.querySelector('.botao.baixar').click();
                await new Promise((r) => setTimeout(r, 1500));
            })()
        `);

        const esperarFila = async (quantos) => {
            let atual = [];
            for (let i = 0; i < 40; i++) {
                await espera(500);
                atual = await ui.avaliar('window.torrange.fila.listar()');
                if (atual.length >= quantos) break;
            }
            return atual;
        };

        let fila = await esperarFila(antes + 1);
        checar(
            'baixar uma opção free manda o torrent para o qBittorrent',
            fila.length > antes,
            fila.length ? `na fila: ${fila.map((t) => t.name).join(', ')}` : 'a fila continuou vazia'
        );

        const novo = fila[0];
        if (novo) {
            checar('o torrent entrou na categoria própria do app', novo.category === 'torrange', `categoria: ${novo.category}`);
            checar('download sequencial ligado (permite assistir antes do fim)', novo.seq_dl === true, `seq_dl: ${novo.seq_dl}`);
            checar('prioridade nas primeiras/últimas peças', novo.f_l_piece_prio === true, `f_l_piece_prio: ${novo.f_l_piece_prio}`);
            checar(
                'salvando na pasta configurada',
                (novo.save_path || '').startsWith(perfil),
                `save_path: ${novo.save_path}`
            );
        }

        const aposFree = await estadoDoServidor();
        checar(
            'a opção free NÃO debitou gema',
            aposFree.debitos.length === 0 && aposFree.gemas.total === 5,
            JSON.stringify(aposFree.gemas)
        );

        // o .torrent nao pode ter caido na pasta de Downloads do usuario
        const downloads = path.join(os.homedir(), 'Downloads');
        const sujeira = fs.existsSync(downloads)
            ? fs.readdirSync(downloads).filter((f) => /(Duna|Filme de Teste).*\.torrent$/i.test(f))
            : [];
        checar('o arquivo .torrent não foi parar na pasta Downloads', sujeira.length === 0, sujeira.join(', '));

        // ------------------------------------------------------ requisito 8
        await ui.avaliar(`
            (async () => {
                const cartoes = Array.from(document.querySelectorAll('#grade-acervo .cartao-acervo'));
                const alvo = cartoes.find((c) => /Duna/.test(c.textContent));
                alvo.click();
                await new Promise((r) => setTimeout(r, 1200));
                const opcoes = Array.from(document.querySelectorAll('#ficha-opcoes .opcao'));
                const paga = opcoes.find((o) => o.querySelector('.etiqueta-preco'));
                paga.querySelector('.botao.baixar').click();
                await new Promise((r) => setTimeout(r, 1500));
            })()
        `);

        const confirmacao = await ui.avaliar(`
            ({
                aberta: !document.querySelector('#confirmacao').hidden,
                preco: document.querySelector('#confirmacao-preco').textContent,
                saldo: document.querySelector('#confirmacao-saldo').textContent,
                resto: document.querySelector('#confirmacao-resto').textContent,
            })
        `);
        checar(
            'a opção paga pede confirmação antes de gastar',
            confirmacao.aberta && confirmacao.preco === '◆ 2' && confirmacao.saldo === '◆ 5',
            JSON.stringify(confirmacao)
        );
        checar('a confirmação mostra com quanto o usuário fica', confirmacao.resto === '◆ 3', confirmacao.resto);

        const antesDoPost = await estadoDoServidor();
        checar(
            'até aqui nada foi cobrado (o GET nunca debita)',
            antesDoPost.debitos.length === 0,
            JSON.stringify(antesDoPost.debitos)
        );

        await ui.avaliar(`document.querySelector('#btn-confirmacao-ok').click(); true`);
        fila = await esperarFila(fila.length + 1);

        const aposPago = await estadoDoServidor();
        checar(
            'confirmando, o torrent pago chega ao qBittorrent',
            fila.some((t) => /4K/.test(t.name)),
            `na fila: ${fila.map((t) => t.name).join(', ')}`
        );
        checar(
            'cobrou exatamente uma vez',
            aposPago.debitos.length === 1 && aposPago.gemas.total === 3,
            `débitos: ${JSON.stringify(aposPago.debitos)} · gemas: ${JSON.stringify(aposPago.gemas)}`
        );
        checar(
            'o POST /baixar foi chamado uma única vez (retry cego cobraria de novo)',
            aposPago.chamadas['baixar-post'] === 1,
            `${aposPago.chamadas['baixar-post']} chamada(s)`
        );

        const saldoNaTela = await ui.avaliar(`document.querySelector('#gemas-barra').textContent`);
        checar('a barra já mostra o saldo novo', saldoNaTela === '◆ 3', saldoNaTela);

        // ------------------------------------------- séries: temporadas e episódios
        // O desenho tem de ser o mesmo do site: um accordion por temporada, a
        // mais recente aberta, com "Episódio N" ou "Temporada completa" dentro.
        const serie = await ui.avaliar(`
            (async () => {
                document.querySelector('#btn-ficha-fechar').click();
                await new Promise((r) => setTimeout(r, 300));
                const cartoes = Array.from(document.querySelectorAll('#grade-acervo .cartao-acervo'));
                const alvo = cartoes.find((c) => /Série de Teste/.test(c.textContent));
                alvo.click();
                await new Promise((r) => setTimeout(r, 1200));

                const temporadas = Array.from(document.querySelectorAll('#ficha-opcoes .temporada'));
                return {
                    cabecalho: document.querySelector('#titulo-opcoes').textContent,
                    conta: document.querySelector('#conta-opcoes').textContent,
                    nota: document.querySelector('#nota-opcoes').textContent,
                    quantas: temporadas.length,
                    nomes: temporadas.map((t) => t.querySelector('b').textContent),
                    resumos: temporadas.map((t) => t.querySelector('.temporada-resumo').textContent),
                    abertas: temporadas.map((t) => t.open),
                    gruposDaPrimeira: Array.from(
                        temporadas[0].querySelectorAll('.episodio-cabeca b')
                    ).map((b) => b.textContent),
                    gruposDaSegunda: Array.from(
                        temporadas[1].querySelectorAll('.episodio-cabeca b')
                    ).map((b) => b.textContent),
                    faixaDoPacote: (temporadas[1].querySelector('.episodio-cabeca span') || {}).textContent,
                    faltantes: document.querySelectorAll('#ficha-faltantes .faltante').length,
                    faltanteEscondido: document.querySelector('#bloco-faltantes').hidden,
                };
            })()
        `);

        checar(
            'uma série mostra "Temporadas" no lugar de "Opções de download"',
            serie.cabecalho === 'Temporadas',
            serie.cabecalho
        );
        checar(
            'o cabeçalho conta temporadas e arquivos, como no site',
            /2 temporadas · 4 arquivos/.test(serie.conta),
            serie.conta
        );
        checar(
            'as temporadas vêm da mais nova para a mais velha',
            serie.nomes.join(' | ') === 'Temporada 2 | Temporada 1',
            serie.nomes.join(' | ')
        );
        checar(
            'só a temporada mais recente nasce aberta',
            serie.abertas[0] === true && serie.abertas[1] === false,
            JSON.stringify(serie.abertas)
        );
        checar(
            'o resumo de cada temporada diz episódios ou temporada completa',
            serie.resumos.join(' | ') === '2 episódios | temporada completa',
            serie.resumos.join(' | ')
        );
        checar(
            'a temporada com episódios lista cada episódio, do último para o primeiro',
            serie.gruposDaPrimeira.join(' | ') === 'Episódio 2 | Episódio 1',
            serie.gruposDaPrimeira.join(' | ')
        );
        checar(
            'a temporada em pacote aparece como "Temporada completa"',
            serie.gruposDaSegunda.join(' | ') === 'Temporada completa',
            serie.gruposDaSegunda.join(' | ')
        );
        checar(
            'o pacote mostra a faixa de tamanho das suas opções',
            serie.faixaDoPacote === '8,0 GB–20,0 GB',
            serie.faixaDoPacote
        );
        checar(
            'os itens sem arquivo aparecem em bloco próprio',
            !serie.faltanteEscondido && serie.faltantes === 1,
            `${serie.faltantes} faltante(s)`
        );

        // baixar um episódio de dentro da temporada
        await ui.avaliar(`
            (async () => {
                const temporada = document.querySelector('#ficha-opcoes .temporada');
                temporada.querySelector('.opcao .botao.baixar').click();
                await new Promise((r) => setTimeout(r, 1500));
            })()
        `);
        fila = await esperarFila(fila.length + 1);
        checar(
            'dá para baixar um episódio direto da temporada',
            fila.some((t) => /Série de Teste/.test(t.name)),
            `na fila: ${fila.map((t) => t.name).join(', ')}`
        );

        // ------------------------------ entrada por endereco na aba Downloads
        await ui.avaliar(
            `window.torrange.fila.adicionarUrl(${JSON.stringify(`${BASE}/baixar/4624732`)})`
        );
        fila = await esperarFila(fila.length + 1);
        checar(
            'colar o endereço do .torrent adiciona o download',
            fila.some((t) => /4624732/.test(t.name)),
            `na fila: ${fila.map((t) => t.name).join(', ')}`
        );

        await ui.avaliar(
            `window.torrange.fila.adicionarUrl(${JSON.stringify(`${BASE}/item/4711000`)})`
        );
        fila = await esperarFila(fila.length + 1);
        checar(
            'colar o endereço de uma página acha o .torrent dentro dela',
            fila.some((t) => /4711000/.test(t.name)),
            `na fila: ${fila.map((t) => t.name).join(', ')}`
        );

        await ui.avaliar(
            `window.torrange.fila.adicionarUrl(${JSON.stringify(`${BASE}/cdn/4822000`)})`
        );
        fila = await esperarFila(fila.length + 1);
        checar(
            'endereço que redireciona (caso da CDN) também entra na fila',
            fila.some((t) => /4822000/.test(t.name)),
            `na fila: ${fila.map((t) => t.name).join(', ')}`
        );

        const botoesDaFila = await ui.avaliar(`
            ({
                arquivo: !!document.querySelector('#btn-arquivo-torrent'),
                api: typeof window.torrange.fila.escolherArquivo === 'function',
            })
        `);
        checar(
            'a aba Downloads oferece escolher um arquivo .torrent',
            botoesDaFila.arquivo && botoesDaFila.api,
            JSON.stringify(botoesDaFila)
        );

        // ------------------------------------------------ favoritos e histórico
        const favoritou = await ui.avaliar(`
            (async () => {
                document.querySelector('.sub-aba[data-lista="acervo"]').click();
                await new Promise((r) => setTimeout(r, 900));
                const cartao = document.querySelector('#grade-acervo .cartao-acervo');
                const estrela = cartao.querySelector('.estrela');
                estrela.click();
                await new Promise((r) => setTimeout(r, 900));
                return estrela.textContent;
            })()
        `);
        checar('a estrela liga o favorito', favoritou === '★', favoritou);

        const listaFavoritos = await ui.avaliar(`
            (async () => {
                document.querySelector('.sub-aba[data-lista="favoritos"]').click();
                await new Promise((r) => setTimeout(r, 1200));
                return document.querySelectorAll('#grade-acervo .cartao-acervo').length;
            })()
        `);
        checar('a aba Favoritos lista o que foi marcado', listaFavoritos === 1, `${listaFavoritos} cartão(ões)`);

        const listaBaixados = await ui.avaliar(`
            (async () => {
                document.querySelector('.sub-aba[data-lista="baixados"]').click();
                await new Promise((r) => setTimeout(r, 1200));
                return document.querySelectorAll('#grade-acervo .cartao-acervo').length;
            })()
        `);
        checar('a aba Já baixados traz o histórico da conta', listaBaixados >= 2, `${listaBaixados} registro(s)`);

        // ------------------------------------------------------- limpeza
        for (const t of fila) {
            await ui.avaliar(`window.torrange.fila.remover(${JSON.stringify(t.hash)}, true)`);
        }
        console.log('\n  (torrents de teste removidos da fila)');

        checar('a interface rodou sem erro de console', errosDeConsole.length === 0,
            errosDeConsole.join('\n         '));
    } catch (erro) {
        console.log(`\n[ FALHA] erro durante o teste: ${erro.message}`);
        falhas++;
    } finally {
        if (ui) ui.fechar();
        await encerrarApp(PORTA_CDP, app);
        servidor.kill();

        // o token nunca pode ter sido gravado em texto puro no perfil
        try {
            const arquivoToken = path.join(perfil, 'token.bin');
            if (fs.existsSync(arquivoToken)) {
                const conteudo = fs.readFileSync(arquivoToken, 'utf8');
                console.log(`\n  token.bin gravado como: ${conteudo.split(':')[0]}`);
            }
        } catch {
            /* sem token gravado */
        }

        fs.rmSync(perfil, { recursive: true, force: true });

        const erros = registro.join('').split('\n').filter((l) => /Error:|Erro/.test(l) && !/ozone|Vulkan|MESA|gpu_process|command_buffer|x11_software|GPU/.test(l));
        if (erros.length) console.log('\n  erros no log do app:\n   ' + erros.join('\n   '));
    }

    console.log(`\n== ${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} teste(s) falharam`} ==`);
    process.exit(falhas === 0 ? 0 : 1);
})();
