'use strict';
/**
 * Organizacao da biblioteca: pastas, capas, nomes de exibicao, descricoes e
 * etiquetas.
 *
 * Fica num arquivo proprio (organizacao.json), separado do catalogo. O catalogo
 * e recontruido a cada ciclo a partir do qBittorrent; o que voce edita aqui nao
 * pode ser atropelado por isso.
 *
 * As pastas sao VIRTUAIS: existem so dentro do app. Renomear, mover ou apagar
 * uma pasta nunca toca num arquivo em disco nem no torrent que o alimenta.
 */
const { app, net } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ARQUIVO = () => path.join(app.getPath('userData'), 'organizacao.json');
const PASTA_CAPAS = () => path.join(app.getPath('userData'), 'capas');

const EXT_IMAGEM = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp']);
const TAMANHO_MAXIMO_CAPA = 12 * 1024 * 1024; // 12 MB

const MIMES = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
};

let dados = null;

// --------------------------------------------------------------- persistencia

function vazio() {
    return { pastas: {}, titulos: {} };
}

function carregar() {
    if (dados) return dados;
    try {
        const lido = JSON.parse(fs.readFileSync(ARQUIVO(), 'utf8'));
        dados = Object.assign(vazio(), lido);
        dados.pastas = dados.pastas || {};
        dados.titulos = dados.titulos || {};
    } catch {
        dados = vazio();
    }
    return dados;
}

let pendente = null;
function gravar() {
    clearTimeout(pendente);
    pendente = setTimeout(() => {
        try {
            fs.mkdirSync(path.dirname(ARQUIVO()), { recursive: true });
            fs.writeFileSync(ARQUIVO(), JSON.stringify(dados, null, 2), 'utf8');
        } catch (erro) {
            console.error('Falha ao gravar a organizacao:', erro.message);
        }
    }, 300);
}

function novoId() {
    return crypto.randomBytes(8).toString('hex');
}

function texto(valor, limite = 4000) {
    return typeof valor === 'string' ? valor.trim().slice(0, limite) : '';
}

// -------------------------------------------------------------------- pastas

/** Impede que uma pasta vire descendente de si mesma ao ser movida. */
function ehDescendente(idPossivelFilho, idPossivelPai) {
    let atual = dados.pastas[idPossivelFilho];
    const vistos = new Set();
    while (atual && atual.pai && !vistos.has(atual.pai)) {
        if (atual.pai === idPossivelPai) return true;
        vistos.add(atual.pai);
        atual = dados.pastas[atual.pai];
    }
    return false;
}

function criarPasta({ nome, pai = null }) {
    carregar();
    const id = novoId();
    dados.pastas[id] = {
        id,
        nome: texto(nome, 120) || 'Nova pasta',
        descricao: '',
        capa: null,
        pai: pai && dados.pastas[pai] ? pai : null,
        criadaEm: Date.now(),
    };
    gravar();
    return dados.pastas[id];
}

function editarPasta(id, campos) {
    carregar();
    const pasta = dados.pastas[id];
    if (!pasta) return null;

    if (campos.nome !== undefined) pasta.nome = texto(campos.nome, 120) || pasta.nome;
    if (campos.descricao !== undefined) pasta.descricao = texto(campos.descricao);
    if (campos.pai !== undefined) {
        const alvo = campos.pai;
        const valido = alvo === null || (dados.pastas[alvo] && alvo !== id && !ehDescendente(alvo, id));
        if (valido) pasta.pai = alvo || null;
    }
    gravar();
    return pasta;
}

/** Remove a pasta. O que estava dentro sobe um nivel -- nada se perde. */
function removerPasta(id) {
    carregar();
    const pasta = dados.pastas[id];
    if (!pasta) return false;

    const destino = pasta.pai || null;
    for (const outra of Object.values(dados.pastas)) {
        if (outra.pai === id) outra.pai = destino;
    }
    for (const titulo of Object.values(dados.titulos)) {
        if (titulo.pasta === id) titulo.pasta = destino;
    }
    apagarArquivoCapa(pasta.capa);
    delete dados.pastas[id];
    gravar();
    return true;
}

function listarPastas() {
    carregar();
    return Object.values(dados.pastas).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

/** Caminho da raiz ate a pasta, para a trilha de navegacao. */
function trilha(id) {
    carregar();
    const caminho = [];
    const vistos = new Set();
    let atual = id ? dados.pastas[id] : null;
    while (atual && !vistos.has(atual.id)) {
        caminho.unshift({ id: atual.id, nome: atual.nome });
        vistos.add(atual.id);
        atual = atual.pai ? dados.pastas[atual.pai] : null;
    }
    return caminho;
}

// ------------------------------------------------------------------ titulos

function doTitulo(hash) {
    carregar();
    if (!dados.titulos[hash]) {
        dados.titulos[hash] = { nome: '', descricao: '', capa: null, etiquetas: [], pasta: null, arquivos: {} };
    }
    return dados.titulos[hash];
}

function editarTitulo(hash, campos) {
    const t = doTitulo(hash);
    if (campos.nome !== undefined) t.nome = texto(campos.nome, 200);
    if (campos.descricao !== undefined) t.descricao = texto(campos.descricao);
    if (campos.etiquetas !== undefined) {
        const lista = Array.isArray(campos.etiquetas)
            ? campos.etiquetas
            : String(campos.etiquetas || '').split(',');
        t.etiquetas = [...new Set(lista.map((e) => texto(e, 40)).filter(Boolean))].slice(0, 20);
    }
    if (campos.pasta !== undefined) {
        t.pasta = campos.pasta && dados.pastas[campos.pasta] ? campos.pasta : null;
    }
    gravar();
    return t;
}

/** Nome de exibicao de um arquivo (episodio) dentro de um titulo. */
function editarArquivo(hash, caminho, nome) {
    const t = doTitulo(hash);
    t.arquivos = t.arquivos || {};
    const limpo = texto(nome, 200);
    if (limpo) t.arquivos[caminho] = { nome: limpo };
    else delete t.arquivos[caminho];
    gravar();
    return t;
}

// -------------------------------------------------------------------- capas

function garantirPastaCapas() {
    fs.mkdirSync(PASTA_CAPAS(), { recursive: true });
    return PASTA_CAPAS();
}

function apagarArquivoCapa(nome) {
    if (!nome) return;
    try {
        fs.unlinkSync(path.join(PASTA_CAPAS(), path.basename(nome)));
    } catch {
        /* ja nao existe */
    }
}

function extensaoValida(origem) {
    const ext = path.extname(new URL(origem, 'file:///').pathname).toLowerCase();
    return EXT_IMAGEM.has(ext) ? ext : null;
}

async function baixarImagem(url) {
    const resposta = await net.fetch(url);
    if (!resposta.ok) throw new Error(`o servidor respondeu ${resposta.status}`);

    const tipo = resposta.headers.get('content-type') || '';
    if (!tipo.startsWith('image/')) throw new Error(`o link nao aponta para uma imagem (${tipo || 'sem tipo'})`);

    const buffer = Buffer.from(await resposta.arrayBuffer());
    if (buffer.length > TAMANHO_MAXIMO_CAPA) throw new Error('a imagem passa de 12 MB');

    const porMime = Object.entries(MIMES).find(([, m]) => m === tipo.split(';')[0].trim());
    const ext = extensaoValida(url) || (porMime ? porMime[0] : '.jpg');
    return { buffer, ext };
}

function lerImagemLocal(caminho) {
    const ext = extensaoValida(caminho);
    if (!ext) throw new Error('formato de imagem nao suportado');
    const info = fs.statSync(caminho);
    if (info.size > TAMANHO_MAXIMO_CAPA) throw new Error('a imagem passa de 12 MB');
    return { buffer: fs.readFileSync(caminho), ext };
}

/**
 * Guarda a capa dentro dos dados do app -- uma COPIA, para a biblioteca nao
 * quebrar se o arquivo original for movido ou apagado depois.
 */
async function definirCapa({ tipo, id }, origem) {
    carregar();
    const alvo = tipo === 'pasta' ? dados.pastas[id] : doTitulo(id);
    if (!alvo) throw new Error('item nao encontrado');

    const { buffer, ext } = origem.url
        ? await baixarImagem(origem.url)
        : lerImagemLocal(origem.arquivo);

    garantirPastaCapas();
    const nome = `${novoId()}${ext}`;
    fs.writeFileSync(path.join(PASTA_CAPAS(), nome), buffer);

    apagarArquivoCapa(alvo.capa);
    alvo.capa = nome;
    gravar();
    return nome;
}

function removerCapa({ tipo, id }) {
    carregar();
    const alvo = tipo === 'pasta' ? dados.pastas[id] : dados.titulos[id];
    if (!alvo) return false;
    apagarArquivoCapa(alvo.capa);
    alvo.capa = null;
    gravar();
    return true;
}

/** Serve o arquivo da capa para o protocolo capa:// registrado no main. */
function lerCapa(nome) {
    const seguro = path.basename(String(nome || ''));
    const caminho = path.join(PASTA_CAPAS(), seguro);
    if (!seguro || !fs.existsSync(caminho)) return null;
    return { buffer: fs.readFileSync(caminho), mime: MIMES[path.extname(seguro).toLowerCase()] || 'image/jpeg' };
}

function urlDaCapa(nome) {
    return nome ? `capa://img/${encodeURIComponent(nome)}` : null;
}

// ------------------------------------------------------------------- juncao

/** Junta o catalogo da biblioteca com o que o usuario editou. */
function aplicar(entradas) {
    carregar();
    return entradas.map((e) => {
        const meta = dados.titulos[e.hash];
        if (!meta) return { ...e, nomeOriginal: e.nome, etiquetas: [], pasta: null, capa: null };

        return {
            ...e,
            nomeOriginal: e.nome,
            nome: meta.nome || e.nome,
            descricao: meta.descricao || '',
            etiquetas: meta.etiquetas || [],
            pasta: meta.pasta || null,
            capa: urlDaCapa(meta.capa),
            arquivos: e.arquivos.map((a) => ({
                ...a,
                nomeOriginal: a.nome,
                nome: (meta.arquivos && meta.arquivos[a.caminho] && meta.arquivos[a.caminho].nome) || a.nome,
            })),
        };
    });
}

function pastasParaInterface() {
    return listarPastas().map((p) => ({ ...p, capa: urlDaCapa(p.capa) }));
}

module.exports = {
    criarPasta,
    editarPasta,
    removerPasta,
    listarPastas,
    pastasParaInterface,
    trilha,
    editarTitulo,
    editarArquivo,
    definirCapa,
    removerCapa,
    lerCapa,
    urlDaCapa,
    aplicar,
};
