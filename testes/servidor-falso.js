'use strict';
/**
 * Servidor de teste: reproduz a API do aplicativo do torrange.com
 * (https://torrange.com/api/aplicativo) com as regras que importam para o app:
 *
 *   - os dois cabecalhos obrigatorios, e a recusa de cada um que falta;
 *   - o aparelho nasce PENDENTE e so fala depois de autorizado;
 *   - tres aparelhos por token, contando os pendentes;
 *   - o GET /baixar nunca debita: se a opcao custa gema ele responde 402
 *     confirmacao_necessaria, e so o POST cobra.
 *
 * Alem da API, continua servindo .torrent cru em /baixar/<id>, uma pagina com
 * o link em /item/<id> e um redirecionamento em /cdn/<id> -- e o que exercita
 * a entrada por endereco da aba Downloads, que nao passa pela API.
 *
 * Rotas de controle do teste (fora da API): /_teste/...
 */
const crypto = require('crypto');
const http = require('http');

// ---------------------------------------------------------------- bencode
function bencode(valor) {
    if (Buffer.isBuffer(valor)) return Buffer.concat([Buffer.from(`${valor.length}:`), valor]);
    if (typeof valor === 'string') return bencode(Buffer.from(valor, 'utf8'));
    if (typeof valor === 'number') return Buffer.from(`i${Math.floor(valor)}e`);
    if (Array.isArray(valor)) {
        return Buffer.concat([Buffer.from('l'), ...valor.map(bencode), Buffer.from('e')]);
    }
    const chaves = Object.keys(valor).sort(); // o bencode exige dicionario ordenado
    return Buffer.concat([
        Buffer.from('d'),
        ...chaves.flatMap((k) => [bencode(k), bencode(valor[k])]),
        Buffer.from('e'),
    ]);
}

/** Gera um .torrent valido de arquivo unico para um conteudo qualquer. */
function criarTorrent(nome, conteudo, announce) {
    const tamanhoPeca = 16384;
    const pedacos = [];
    for (let i = 0; i < conteudo.length; i += tamanhoPeca) {
        pedacos.push(crypto.createHash('sha1').update(conteudo.subarray(i, i + tamanhoPeca)).digest());
    }
    const info = {
        length: conteudo.length,
        name: nome,
        'piece length': tamanhoPeca,
        pieces: Buffer.concat(pedacos),
    };
    return {
        arquivo: bencode({ announce, 'created by': 'torrange-teste', info }),
        hash: crypto.createHash('sha1').update(bencode(info)).digest('hex'),
    };
}

const porta = Number(process.argv[2]) || 47110;
const anuncio = `http://127.0.0.1:${porta}/announce`;
const BASE = `http://127.0.0.1:${porta}`;

// --------------------------------------------------------------- catalogo

const TOKEN_VALIDO = process.env.TESTE_TOKEN || 'a'.repeat(50) + 'B'.repeat(25) + '9'.repeat(25);

const OPCOES = {
    1: { id: 1, rotulo: 'Full HD', etiquetas: ['MKV', 'Nacional', 'H.264'], tamanho_bytes: 4294967296, tamanho: '4,0 GB', seeders: 10, temporada: null, episodio: null, free: true, preco: 0, titulo: 'g1' },
    4: { id: 4, rotulo: '4K', etiquetas: ['MKV', 'Dual Áudio', 'H.265'], tamanho_bytes: 34359738368, tamanho: '32,0 GB', seeders: 4, temporada: null, episodio: null, free: false, preco: 2, titulo: 'g1' },
    7: { id: 7, rotulo: 'Full HD', etiquetas: ['MKV', 'Legendado', 'H.264'], tamanho_bytes: 2791728742, tamanho: '2,6 GB', seeders: 28, temporada: 2, episodio: 2, free: true, preco: 0, titulo: 's45' },
    8: { id: 8, rotulo: 'Full HD', etiquetas: ['MKV', 'Legendado', 'H.264'], tamanho_bytes: 2791728742, tamanho: '2,6 GB', seeders: 24, temporada: 2, episodio: 1, free: true, preco: 0, titulo: 's45' },
    // a temporada 1 vem em pacote (sem episodio), e em duas resolucoes
    9: { id: 9, rotulo: 'Full HD', etiquetas: ['MKV', 'Dual Áudio', 'H.264'], tamanho_bytes: 8589934592, tamanho: '8,0 GB', seeders: 12, temporada: 1, episodio: null, free: true, preco: 0, titulo: 's45' },
    10: { id: 10, rotulo: '4K', etiquetas: ['MKV', 'Dual Áudio', 'H.265'], tamanho_bytes: 21474836480, tamanho: '20,0 GB', seeders: 5, temporada: 1, episodio: null, free: false, preco: 2, titulo: 's45' },
};

const TITULOS = {
    g1: {
        chave: 'g1',
        titulo: 'Duna: Parte Dois',
        titulo_alternativo: 'Dune: Part Two',
        ano: 2024,
        categoria: 'filme',
        tags: ['drama'],
        nota_imdb: 8.5,
        serie: false,
        total_opcoes: 2,
        melhor_resolucao: '4K',
        faixa_de_tamanho: '4,0–32,0 GB',
        nada_para_baixar: false,
        item_referencia: 1,
        ficha_tecnica: {
            Formato: 'MKV',
            'Resolução': 'Full HD',
            'Áudio': 'Nacional',
            'Codec de Vídeo': 'H.264',
            'Adicionado em': '10/09/2026',
        },
        opcoes: [1, 4],
        faltantes: [],
    },
    s45: {
        chave: 's45',
        titulo: 'Série de Teste',
        titulo_alternativo: null,
        ano: 2021,
        categoria: 'serie',
        tags: ['comédia'],
        nota_imdb: null,
        serie: true,
        total_opcoes: 4,
        melhor_resolucao: '4K',
        faixa_de_tamanho: '2,6 GB–20,0 GB',
        nada_para_baixar: false,
        item_referencia: 7,
        ficha_tecnica: {
            Formato: 'MKV',
            'Resolução': 'Full HD',
            'Áudio': 'Legendado',
            'Codec de Vídeo': 'H.264',
        },
        opcoes: [7, 8, 9, 10],
        faltantes: [{ id: 4721858, nome: 'Série de Teste - S02E03 [2021]', rotulo: 'Full HD' }],
    },
};

// -------------------------------------------------------- estado mutavel
const estado = {
    token: TOKEN_VALIDO,
    aprovado: false,
    contaAtiva: true,
    assinaturaAtiva: true,
    vagas: 3,
    gemas: { plano: 5, paga: 0, total: 5 },
    temPasskey: true,
    precoDaGema: 2,
    instalacoes: new Map(), // id -> { nome, plataforma, aprovado_em, idNumerico }
    favoritos: new Set(),
    baixados: [],
    chamadas: {},
    debitos: [],
};

function contar(rota) {
    estado.chamadas[rota] = (estado.chamadas[rota] || 0) + 1;
}

// ------------------------------------------------------------------ paginas
// Pagina de um item: so o link de baixar. Exercita a entrada por endereco --
// colar a URL da pagina deve achar o .torrent dentro dela.
const PAGINA_ITEM = (id) => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Item ${id} · Torrange</title></head>
<body><h1>Item ${id}</h1>
<a href="${BASE}/baixar/${id}" class="botao-baixar">Baixar</a>
</body></html>`;

// --------------------------------------------------------------- utilidades

function responder(res, status, corpo, tipo = 'application/json; charset=utf-8', extras = {}) {
    const dados = Buffer.isBuffer(corpo) ? corpo : Buffer.from(JSON.stringify(corpo));
    res.writeHead(status, Object.assign({ 'Content-Type': tipo, 'Content-Length': dados.length }, extras));
    res.end(dados);
}

/** attachment com o nome em ASCII e a forma estendida para acentos. */
function disposicao(nome) {
    const simples = nome.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    return `attachment; filename="${simples}"; filename*=UTF-8''${encodeURIComponent(nome)}`;
}

function recusar(res, status, erro, mensagem, extras = {}) {
    responder(res, status, Object.assign({ erro, mensagem }, extras));
}

function lerCorpo(req) {
    return new Promise((resolve) => {
        const partes = [];
        req.on('data', (d) => partes.push(d));
        req.on('end', () => {
            const texto = Buffer.concat(partes).toString('utf8');
            if (!texto) return resolve({});
            try {
                resolve(JSON.parse(texto));
            } catch {
                resolve(Object.fromEntries(new URLSearchParams(texto)));
            }
        });
    });
}

/**
 * Confere os dois cabecalhos obrigatorios e o estado da conta.
 * Devolve o id da instalacao, ou null quando ja respondeu a recusa.
 */
function autenticar(req, res) {
    const token =
        req.headers['x-aplicativo-token'] ||
        (/^Bearer\s+(\S+)/i.exec(req.headers.authorization || '') || [])[1] ||
        '';
    const instalacao = req.headers['x-aplicativo-instalacao'] || '';

    if (!token) {
        recusar(res, 401, 'token_ausente', 'O cabeçalho X-Aplicativo-Token não veio.');
        return null;
    }
    if (token !== estado.token) {
        recusar(res, 401, 'token_invalido', 'Este token não existe. Gere um novo no site.');
        return null;
    }
    if (!estado.contaAtiva) {
        recusar(res, 403, 'conta_inativa', 'Esta conta foi removida.');
        return null;
    }
    if (!estado.assinaturaAtiva) {
        recusar(res, 402, 'assinatura_inativa', 'A assinatura não está em dia.');
        return null;
    }
    if (!/^[A-Za-z0-9._:-]{8,64}$/.test(instalacao)) {
        recusar(
            res,
            400,
            'instalacao_ausente',
            'O id da instalação faltou, ou está fora do formato (8 a 64 caracteres).'
        );
        return null;
    }
    return instalacao;
}

/** Depois de autenticar: esta instalacao tem vaga e ja foi autorizada? */
function exigirAprovacao(res, instalacao) {
    const registro = estado.instalacoes.get(instalacao);
    if (!registro) {
        recusar(res, 403, 'nao_conectado', 'Este aplicativo não tem vaga nesta conta.');
        return false;
    }
    if (!registro.aprovado_em) {
        recusar(
            res,
            403,
            'aguardando_aprovacao',
            'Este aplicativo ainda não foi autorizado. Abra o site e permita o acesso.'
        );
        return false;
    }
    return true;
}

function cardDe(chave) {
    const t = TITULOS[chave];
    if (!t) return null;
    const card = {};
    for (const campo of [
        'chave', 'titulo', 'titulo_alternativo', 'ano', 'categoria', 'tags', 'nota_imdb',
        'serie', 'total_opcoes', 'melhor_resolucao', 'faixa_de_tamanho', 'nada_para_baixar',
        'item_referencia',
    ]) {
        card[campo] = t[campo];
    }
    card.capa = `${BASE}/api/aplicativo/capa/${t.item_referencia}`;
    return card;
}

// 1x1 webp, o menor arquivo que um <img> aceita
const CAPA = Buffer.from(
    'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
    'base64'
);

function torrentDaOpcao(id) {
    const opcao = OPCOES[id];
    const nome = `${TITULOS[opcao.titulo].titulo} ${opcao.rotulo}`;
    const conteudo = Buffer.alloc(200000, `conteudo-da-opcao-${id}`);
    return { arquivo: criarTorrent(`${nome}.mkv`, conteudo, anuncio).arquivo, nome: `${nome}.torrent` };
}

// ------------------------------------------------------------------- API

async function tratarApi(req, res, rota, url) {
    // ------------------------------------------------------------ /conexao
    if (rota === '/conexao' && req.method === 'POST') {
        contar('conexao');
        const instalacao = autenticar(req, res);
        if (!instalacao) return;

        const corpo = await lerCorpo(req);
        const nome = String(corpo.nome || '').trim();
        if (nome.length < 2 || nome.length > 80) {
            responder(res, 422, { message: 'O nome é obrigatório.', errors: { nome: ['2 a 80 caracteres'] } });
            return;
        }

        const jaExiste = estado.instalacoes.has(instalacao);
        if (!jaExiste && estado.instalacoes.size >= estado.vagas) {
            recusar(res, 409, 'sem_vaga', 'Esta conta já tem três aplicativos.');
            return;
        }
        if (!jaExiste) {
            estado.instalacoes.set(instalacao, {
                id: estado.instalacoes.size + 1,
                nome,
                plataforma: String(corpo.plataforma || '').slice(0, 40),
                aprovado_em: estado.aprovado ? new Date().toISOString() : null,
            });
        }
        const registro = estado.instalacoes.get(instalacao);
        // o dono pode ter autorizado entre duas chamadas
        if (estado.aprovado && !registro.aprovado_em) registro.aprovado_em = new Date().toISOString();

        responder(res, jaExiste ? 200 : 201, {
            estado: registro.aprovado_em ? 'aprovado' : 'pendente',
            aplicativo: { id: registro.id, nome: registro.nome, aprovado_em: registro.aprovado_em },
            vagas_livres: Math.max(0, estado.vagas - estado.instalacoes.size),
            mensagem: registro.aprovado_em
                ? 'Aplicativo autorizado.'
                : 'Aguardando a autorização do dono da conta no site.',
        });
        return;
    }

    // -------------------------------------------------------------- /conta
    if (rota === '/conta' && req.method === 'GET') {
        contar('conta');
        const instalacao = autenticar(req, res);
        if (!instalacao) return;

        const registro = estado.instalacoes.get(instalacao);
        // o dono autorizou pelo site: a proxima /conta ja passa
        if (estado.aprovado && registro && !registro.aprovado_em) {
            registro.aprovado_em = new Date().toISOString();
        }
        if (!exigirAprovacao(res, instalacao)) return;

        responder(res, 200, {
            conta: {
                nome: 'Benedito das Dores',
                email: 'benedito@exemplo.net',
                admin: false,
                tem_passkey: estado.temPasskey,
                mostra_adulto: false,
            },
            gemas: estado.gemas,
            aplicativo: {
                id: registro.id,
                nome: registro.nome,
                aprovado_em: registro.aprovado_em,
            },
        });
        return;
    }

    // Todas as rotas abaixo exigem token valido e aparelho autorizado.
    const instalacao = autenticar(req, res);
    if (!instalacao) return;
    if (!exigirAprovacao(res, instalacao)) return;

    // ------------------------------------------------------------- /acervo
    if (rota === '/acervo' && req.method === 'GET') {
        contar('acervo');
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const categoria = url.searchParams.get('categoria') || '';
        const free = url.searchParams.get('free') === '1';

        let titulos = Object.keys(TITULOS).map(cardDe);
        if (q) titulos = titulos.filter((t) => t.titulo.toLowerCase().includes(q));
        if (categoria) titulos = titulos.filter((t) => t.categoria === categoria);
        if (free) {
            titulos = titulos.filter((t) =>
                TITULOS[t.chave].opcoes.some((id) => OPCOES[id].free)
            );
        }

        responder(res, 200, {
            titulos,
            pagina: 1,
            paginas: 1,
            por_pagina: Number(url.searchParams.get('por')) || 20,
            total: titulos.length,
            // so vem preenchido quando ha busca
            sem_arquivo: q
                ? [
                      {
                          chave: 'i7',
                          titulo: `Sem arquivo para "${q}"`,
                          titulo_alternativo: null,
                          ano: 1999,
                          categoria: 'filme',
                          tags: [],
                          nota_imdb: null,
                          serie: false,
                          total_opcoes: 0,
                          melhor_resolucao: null,
                          faixa_de_tamanho: null,
                          nada_para_baixar: true,
                          capa: null,
                          item_referencia: 77,
                      },
                  ]
                : [],
            preco_da_gema: estado.precoDaGema,
        });
        return;
    }

    // ------------------------------------------------------ /titulo/{chave}
    const ficha = /^\/titulo\/(.+)$/.exec(rota);
    if (ficha && req.method === 'GET') {
        contar('titulo');
        const chave = decodeURIComponent(ficha[1]);
        const t = TITULOS[chave];
        if (!t) {
            recusar(res, 404, 'nao_encontrado', 'Esse título não existe para esta conta.');
            return;
        }
        const card = cardDe(chave);
        responder(res, 200, {
            titulo: Object.assign(card, {
                ficha_tecnica: t.ficha_tecnica,
                opcoes: t.opcoes.map((id) => {
                    const o = OPCOES[id];
                    return {
                        id: o.id,
                        rotulo: o.rotulo,
                        etiquetas: o.etiquetas,
                        tamanho_bytes: o.tamanho_bytes,
                        tamanho: o.tamanho,
                        seeders: o.seeders,
                        temporada: o.temporada,
                        episodio: o.episodio,
                        free: o.free,
                        preco: o.preco,
                        baixar: `${BASE}/api/aplicativo/baixar/${o.id}`,
                    };
                }),
                faltantes: t.faltantes,
            }),
            preco_da_gema: estado.precoDaGema,
        });
        return;
    }

    // -------------------------------------------------------- /capa/{item}
    const capa = /^\/capa\/(\w+)$/.exec(rota);
    if (capa && req.method === 'GET') {
        contar('capa');
        if (capa[1] === '77') {
            responder(res, 404, { erro: 'nao_encontrado', mensagem: 'Sem imagem.' });
            return;
        }
        responder(res, 200, CAPA, 'image/webp');
        return;
    }

    // ------------------------------------------------------ /baixar/{item}
    const baixar = /^\/baixar\/(\w+)$/.exec(rota);
    if (baixar) {
        const id = Number(baixar[1]);
        const opcao = OPCOES[id];
        if (!opcao) {
            recusar(res, 404, 'nao_encontrado', 'Essa opção não existe para esta conta.');
            return;
        }
        if (!estado.temPasskey) {
            recusar(res, 409, 'sem_passkey', 'A conta não tem passkey. Nenhum download sai.');
            return;
        }

        const entregar = () => {
            const { arquivo, nome } = torrentDaOpcao(id);
            estado.baixados.unshift({
                baixado_em: new Date().toISOString(),
                vezes: 1,
                titulo: cardDe(opcao.titulo),
                opcao: { id: opcao.id, rotulo: opcao.rotulo, tamanho: opcao.tamanho },
            });
            responder(res, 200, arquivo, 'application/x-bittorrent', {
                // O nome tem acento, e o Node recusa nao-ASCII em cabecalho.
                // A forma estendida do RFC 5987 e a que o site usa de verdade
                // -- e de quebra exercita o parser do cliente.
                'Content-Disposition': disposicao(nome),
            });
        };

        if (req.method === 'GET') {
            contar('baixar-get');
            if (opcao.free) return entregar();
            // NAO debita: so diz o que a tela de confirmacao precisa
            recusar(res, 402, 'confirmacao_necessaria', 'Esta opção custa gemas. Confirme o preço para baixar.', {
                preco: opcao.preco,
                saldo: estado.gemas.total,
                confirmar_em: `${BASE}/api/aplicativo/baixar/${id}`,
            });
            return;
        }

        if (req.method === 'POST') {
            contar('baixar-post');
            if (opcao.free) {
                recusar(res, 409, 'opcao_free', 'Esta opção não cobra.', {
                    baixar: `${BASE}/api/aplicativo/baixar/${id}`,
                });
                return;
            }
            const corpo = await lerCorpo(req);
            const oferecido = Number(corpo.preco);
            if (oferecido !== opcao.preco) {
                recusar(res, 409, 'preco_mudou', 'O preço mudou.', {
                    preco: opcao.preco,
                    saldo: estado.gemas.total,
                });
                return;
            }
            if (estado.gemas.total < opcao.preco) {
                recusar(res, 402, 'sem_saldo', 'Gemas insuficientes.', {
                    preco: opcao.preco,
                    saldo: estado.gemas.total,
                });
                return;
            }
            estado.gemas.plano = Math.max(0, estado.gemas.plano - opcao.preco);
            estado.gemas.total = estado.gemas.plano + estado.gemas.paga;
            estado.debitos.push({ item: id, preco: opcao.preco, em: new Date().toISOString() });
            return entregar();
        }
    }

    // ---------------------------------------------------------- /favoritos
    if (rota === '/favoritos' && req.method === 'GET') {
        contar('favoritos');
        const titulos = [...estado.favoritos].map(cardDe).filter(Boolean);
        responder(res, 200, { titulos, pagina: 1, paginas: 1, total: titulos.length });
        return;
    }
    if (rota === '/favoritos' && req.method === 'POST') {
        contar('favoritar');
        const corpo = await lerCorpo(req);
        const chave = String(corpo.chave || '');
        if (!TITULOS[chave]) {
            recusar(res, 404, 'nao_encontrado', 'Título inexistente.');
            return;
        }
        const ligado = !estado.favoritos.has(chave);
        if (ligado) estado.favoritos.add(chave);
        else estado.favoritos.delete(chave);
        responder(res, 200, { ligado, chave });
        return;
    }

    // ----------------------------------------------------------- /baixados
    if (rota === '/baixados' && req.method === 'GET') {
        contar('baixados');
        responder(res, 200, {
            registros: estado.baixados,
            pagina: 1,
            paginas: 1,
            total: estado.baixados.length,
        });
        return;
    }

    recusar(res, 404, 'nao_encontrado', `Rota desconhecida: ${rota}`);
}

// ---------------------------------------------------------- controle do teste

async function tratarControle(req, res, rota) {
    if (rota === '/aprovar') {
        estado.aprovado = true;
        for (const registro of estado.instalacoes.values()) {
            if (!registro.aprovado_em) registro.aprovado_em = new Date().toISOString();
        }
        responder(res, 200, { ok: true, aprovado: true });
        return;
    }
    if (rota === '/estado') {
        responder(res, 200, {
            aprovado: estado.aprovado,
            gemas: estado.gemas,
            chamadas: estado.chamadas,
            debitos: estado.debitos,
            // o espalhamento vem DEPOIS de instalacao para nao apagar a chave:
            // o registro tem um `id` proprio (numerico), que e outra coisa
            instalacoes: [...estado.instalacoes.entries()].map(([instalacao, r]) => ({ ...r, instalacao })),
            favoritos: [...estado.favoritos],
            token: estado.token,
        });
        return;
    }
    if (rota === '/esquecer-aparelhos') {
        estado.instalacoes.clear();
        responder(res, 200, { ok: true });
        return;
    }
    if (rota === '/ajustar') {
        const corpo = await lerCorpo(req);
        for (const [chave, valor] of Object.entries(corpo)) {
            if (chave in estado) estado[chave] = valor;
        }
        responder(res, 200, { ok: true });
        return;
    }
    responder(res, 404, { erro: 'nao_encontrado' });
}

// ------------------------------------------------------------------ servidor

const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, BASE);
    const caminho = url.pathname;

    try {
        if (caminho.startsWith('/api/aplicativo')) {
            return await tratarApi(req, res, caminho.slice('/api/aplicativo'.length) || '/', url);
        }
        if (caminho.startsWith('/_teste')) {
            return await tratarControle(req, res, caminho.slice('/_teste'.length) || '/');
        }
    } catch (erro) {
        responder(res, 500, { erro: 'falha_do_teste', mensagem: erro.message });
        return;
    }

    // ---------------------------------------------- rotas cruas (sem API)
    // Pagina com o link dentro: colar o endereco tem de achar o .torrent.
    const item = /^\/item\/(\d+)/.exec(caminho);
    if (item) {
        responder(res, 200, Buffer.from(PAGINA_ITEM(item[1])), 'text/html; charset=utf-8');
        return;
    }

    // Redirecionamento para outro caminho, como faz uma CDN: o app tem de
    // seguir sozinho, mantendo o Referer.
    const desvio = /^\/cdn\/(\d+)/.exec(caminho);
    if (desvio) {
        res.writeHead(302, { Location: `${BASE}/baixar/${desvio[1]}` });
        res.end();
        return;
    }

    const cru = /^\/baixar\/(\d+)/.exec(caminho);
    if (cru) {
        const conteudo = Buffer.alloc(200000, `conteudo-de-teste-${cru[1]}`);
        const { arquivo } = criarTorrent(`Filme de Teste ${cru[1]}.mkv`, conteudo, anuncio);
        responder(res, 200, arquivo, 'application/x-bittorrent', {
            'Content-Disposition': disposicao(`Filme de Teste ${cru[1]}.torrent`),
        });
        return;
    }

    responder(res, 200, Buffer.from('<h1>servidor de teste do Torrange</h1>'), 'text/html; charset=utf-8');
});

servidor.listen(porta, '127.0.0.1', () =>
    console.log(`servidor de teste em ${BASE}/ (API em ${BASE}/api/aplicativo)`)
);
