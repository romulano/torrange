'use strict';
/**
 * Servidor de teste: reproduz a pagina do torrange.com (mesmo HTML do botao)
 * e serve um .torrent de verdade, para exercitar a interceptacao do app sem
 * depender do site real nem de credenciais.
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

// ------------------------------------------------------------------ paginas
const PAGINA = (porta) => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Teste · Torrange</title>
<style>
 body{background:#111;color:#eee;font:15px system-ui;padding:40px;max-width:760px;margin:auto}
 .opcao-cabeca{display:flex;align-items:center;gap:14px;background:#1b1b1b;
   border:1px solid #333;border-radius:10px;padding:14px 16px;margin:12px 0}
 .opcao-selecionar{flex:1;display:flex;gap:10px;align-items:center}
 .opcao-rotulo{font-weight:700}
 .opcao-etiquetas span{background:#2a2a2a;border-radius:6px;padding:2px 7px;font-size:12px;margin-right:4px}
 .botao-baixar{background:#ff8a3d;color:#1a1005;text-decoration:none;font-weight:700;
   padding:9px 16px;border-radius:8px;white-space:nowrap}
 .oculto-visual{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
</style></head><body>
<h1>Página de teste</h1>
<p>Mesmo HTML do botão do torrange.com.</p>

<div class="opcao-cabeca">
    <label class="opcao-selecionar" for="opcao-1">
        <span class="opcao-rotulo">Full HD</span>
        <span class="opcao-etiquetas"><span class="opcao-preco na">free</span><span>MKV</span><span class="na">Dual Áudio</span><span>H.264</span></span>
        <span class="opcao-tamanho">5,1 GB</span>
    </label>
    <a href="http://127.0.0.1:${porta}/baixar/4079200" class="botao-baixar">
        ↓ Baixar<span class="sufixo"> .torrent</span>
        <span class="oculto-visual">grátis · Full HD, 5,1 GB</span>
    </a>
</div>

<div class="opcao-cabeca">
    <label class="opcao-selecionar" for="opcao-2">
        <span class="opcao-rotulo">4K</span>
        <span class="opcao-etiquetas"><span class="opcao-preco na">free</span><span>MKV</span><span>H.265</span></span>
        <span class="opcao-tamanho">13,2 GB</span>
    </label>
    <!-- variante sem o span.sufixo, para exercitar a rede de seguranca do preload -->
    <a href="http://127.0.0.1:${porta}/baixar/4624732" class="botao-baixar">↓ Baixar .torrent grátis</a>
</div>

<div class="opcao-cabeca">
    <label class="opcao-selecionar" for="opcao-3">
        <span class="opcao-rotulo">720p</span>
        <span class="opcao-etiquetas"><span class="opcao-preco na">free</span><span>MP4</span></span>
        <span class="opcao-tamanho">2,0 GB</span>
    </label>
    <!-- abre em aba nova: o app tem de capturar sem deixar vazar para o navegador do sistema -->
    <a href="http://127.0.0.1:${porta}/baixar/4933000" target="_blank" rel="noopener" class="botao-baixar">
        ↓ Baixar<span class="sufixo"> .torrent</span>
    </a>
</div>
</body></html>`;

const porta = Number(process.argv[2]) || 47110;
const anuncio = `http://127.0.0.1:${porta}/announce`;

// Pagina de um item: so o botao de baixar. Serve para exercitar a entrada
// por endereco -- colar a URL da pagina deve achar o .torrent dentro dela.
const PAGINA_ITEM = (porta, id) => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Item ${id} · Torrange</title></head>
<body><h1>Item ${id}</h1>
<a href="http://127.0.0.1:${porta}/baixar/${id}" class="botao-baixar">↓ Baixar<span class="sufixo"> .torrent</span></a>
</body></html>`;

const servidor = http.createServer((req, res) => {
    const item = /^\/item\/(\d+)/.exec(req.url);
    if (item) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGINA_ITEM(porta, item[1]));
        return;
    }

    // Redirecionamento para outra origem, como faz uma CDN: o app tem de
    // seguir sozinho, sem passar pelo download do Chromium.
    const desvio = /^\/cdn\/(\d+)/.exec(req.url);
    if (desvio) {
        res.writeHead(302, { Location: `http://127.0.0.1:${porta}/baixar/${desvio[1]}` });
        res.end();
        return;
    }

    const m = /^\/baixar\/(\d+)/.exec(req.url);
    if (m) {
        const conteudo = Buffer.alloc(200000, `conteudo-de-teste-${m[1]}`);
        const { arquivo } = criarTorrent(`Filme de Teste ${m[1]}.mkv`, conteudo, anuncio);
        res.writeHead(200, {
            'Content-Type': 'application/x-bittorrent',
            'Content-Disposition': `attachment; filename="Filme de Teste ${m[1]}.torrent"`,
            'Content-Length': arquivo.length,
        });
        res.end(arquivo);
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGINA(porta));
});

servidor.listen(porta, '127.0.0.1', () => console.log(`servidor de teste em http://127.0.0.1:${porta}/`));
