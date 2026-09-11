'use strict';
/* Torrange - interface. Conversa com o processo principal pelo bridge window.torrange. */

const api = window.torrange;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let abaAtual = 'acervo';
let fila = [];
let biblioteca = [];
let configuracao = {};
let filtroBiblioteca = '';

// O monitor manda estado a cada segundo. Redesenhar tudo nesse ritmo faz a tela
// piscar e derruba o foco dos botoes, entao so redesenhamos quando o conteudo
// visivel muda de fato.
const assinaturas = { fila: '', biblioteca: '' };

function mudou(chave, valor) {
    if (assinaturas[chave] === valor) return false;
    assinaturas[chave] = valor;
    return true;
}

const player = {
    aberto: false,
    hash: null,
    caminho: null,
    nome: '',
    tempo: 0,
    duracao: 0,
    pausado: false,
    cache: 0,
    arrastando: false,
};

// --------------------------------------------------------------- formatacao

function tamanho(bytes) {
    if (!bytes || bytes < 0) return '—';
    const un = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < un.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0).replace('.', ',')} ${un[i]}`;
}

function velocidade(bps) {
    return bps > 0 ? `${tamanho(bps)}/s` : '—';
}

function restante(segundos) {
    if (!segundos || segundos <= 0 || segundos >= 8640000) return '—';
    const h = Math.floor(segundos / 3600);
    const m = Math.floor((segundos % 3600) / 60);
    if (h > 0) return `${h}h ${m}min`;
    if (m > 0) return `${m}min`;
    return `${Math.floor(segundos)}s`;
}

function relogio(segundos) {
    if (!isFinite(segundos) || segundos < 0) segundos = 0;
    const s = Math.floor(segundos % 60);
    const m = Math.floor((segundos / 60) % 60);
    const h = Math.floor(segundos / 3600);
    const dois = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${dois(m)}:${dois(s)}` : `${m}:${dois(s)}`;
}

const ESTADOS = {
    downloading: 'baixando',
    forcedDL: 'baixando',
    metaDL: 'lendo metadados',
    stalledDL: 'sem seeds',
    queuedDL: 'na fila',
    checkingDL: 'verificando',
    uploading: 'concluído',
    stalledUP: 'concluído',
    forcedUP: 'concluído',
    queuedUP: 'concluído',
    checkingUP: 'verificando',
    pausedDL: 'pausado',
    stoppedDL: 'pausado',
    pausedUP: 'concluído',
    stoppedUP: 'concluído',
    error: 'erro',
    missingFiles: 'arquivos faltando',
    arquivado: 'arquivado',
};

function rotuloEstado(estado) {
    return ESTADOS[estado] || estado || '—';
}

function elemento(tag, classe, texto) {
    const el = document.createElement(tag);
    if (classe) el.className = classe;
    if (texto !== undefined) el.textContent = texto;
    return el;
}

// -------------------------------------------------------------------- abas

function trocarAba(nome) {
    abaAtual = nome;
    $$('.aba').forEach((b) => b.classList.toggle('ativa', b.dataset.aba === nome));
    $$('.tela').forEach((t) => t.classList.toggle('ativa', t.id === `tela-${nome}`));
    $('#pilula-player').hidden = !(player.aberto && nome !== 'player');

    // a view nativa do video so pode ser posicionada depois que o layout assentou
    requestAnimationFrame(() => {
        enviarLayout();
        api.ui.aba(nome);
    });
}

function retangulo(seletor) {
    const el = $(seletor);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function enviarLayout() {
    api.ui.layout({ player: retangulo('#area-video') });
}

// ==========================================================================
// Conexao com o site (token e autorizacao)
// ==========================================================================

let estadoConexao = { fase: 'sem-token', erro: '', mensagem: '' };

const TITULOS_DE_ERRO = {
    conta_inativa: 'Esta conta foi removida',
    assinatura_inativa: 'A assinatura não está em dia',
    sem_vaga: 'Sua conta já tem três aparelhos',
    instalacao_ausente: 'Este aparelho foi recusado',
};

function renderConexao() {
    const { fase } = estadoConexao;
    const aprovado = fase === 'aprovado';

    $('#gate-conexao').hidden = aprovado;
    $('#acervo-conteudo').hidden = !aprovado;

    $('#painel-token').hidden = fase !== 'sem-token';
    $('#painel-espera').hidden = !(fase === 'pendente' || fase === 'conectando');
    $('#painel-erro-conexao').hidden = fase !== 'erro';

    if (fase === 'pendente' || fase === 'conectando') {
        // Sem rede o app tambem fica esperando, mas por outro motivo -- dizer
        // "esperando a autorizacao" ali mandaria o usuario procurar no site um
        // botao que ele ja apertou.
        const semRede = estadoConexao.erro === 'sem_rede';
        $('#espera-titulo').textContent = semRede
            ? 'Sem resposta do site'
            : 'Esperando a autorização';
        $('#espera-mensagem').textContent =
            estadoConexao.mensagem ||
            'Este aplicativo já se apresentou à sua conta. Falta você permitir o acesso no site.';
        $('#espera-aparelho').textContent =
            (estadoConexao.aplicativo && estadoConexao.aplicativo.nome) || '—';
        $('#espera-token').textContent = estadoConexao.tokenMascarado || '—';
        $('#espera-vagas').textContent =
            typeof estadoConexao.vagasLivres === 'number' ? String(estadoConexao.vagasLivres) : '—';
    }

    if (fase === 'erro') {
        $('#erro-conexao-titulo').textContent =
            TITULOS_DE_ERRO[estadoConexao.erro] || 'Não consegui conectar';
        $('#erro-conexao-texto').textContent = estadoConexao.mensagem || '';
    }

    // barra do topo: conta e gemas
    const barra = $('#conta-barra');
    barra.hidden = !aprovado;
    if (aprovado) {
        const gemas = estadoConexao.gemas || {};
        $('#gemas-barra').textContent = `◆ ${gemas.total ?? 0}`;
        $('#gemas-barra').title =
            `Gemas: ${gemas.total ?? 0} (do plano: ${gemas.plano ?? 0}, compradas: ${gemas.paga ?? 0})`;
        $('#conta-nome').textContent = (estadoConexao.conta && estadoConexao.conta.nome) || '';
    }

    renderConexaoNosAjustes();
}

const ROTULO_DE_FASE = {
    'sem-token': 'sem token',
    conectando: 'apresentando o aparelho…',
    pendente: 'esperando a autorização no site',
    aprovado: 'conectado',
    erro: 'com problema',
};

function renderConexaoNosAjustes() {
    $('#cfg-conexao-fase').textContent = ROTULO_DE_FASE[estadoConexao.fase] || estadoConexao.fase;
    $('#cfg-token').textContent = estadoConexao.tokenMascarado || '(nenhum)';
    $('#cfg-token-protegido').textContent =
        estadoConexao.protegidoPeloCofre === null
            ? '—'
            : estadoConexao.protegidoPeloCofre
              ? 'cifrado pelo cofre do sistema'
              : 'em arquivo próprio (este sistema não tem cofre)';
    $('#cfg-instalacao').textContent = estadoConexao.instalacao || '—';

    const conta = estadoConexao.conta;
    $('#cfg-conta').textContent = conta ? `${conta.nome} · ${conta.email}` : '—';

    const gemas = estadoConexao.gemas;
    $('#cfg-gemas').textContent = gemas
        ? `${gemas.total} (plano ${gemas.plano} + compradas ${gemas.paga})`
        : '—';

    // Sem passkey nenhum download sai, nem o free -- e o app nao resolve isso.
    if (conta && conta.tem_passkey === false) {
        $('#cfg-conta').textContent += ' — sem passkey: nenhum download sai';
    }
}

function aplicarEstadoConexao(estado) {
    if (!estado) return;
    const antes = estadoConexao.fase;
    estadoConexao = estado;
    renderConexao();

    // Assim que a autorizacao sai, o acervo aparece sozinho.
    if (antes !== 'aprovado' && estado.fase === 'aprovado') {
        aviso('Aparelho autorizado. Bem-vindo!', 'ok');
        carregarAcervo({ pagina: 1 });
    }
}

async function salvarToken() {
    const botao = $('#btn-salvar-token');
    const campo = $('#campo-token');
    const erro = $('#erro-token');
    erro.hidden = true;

    botao.disabled = true;
    const rotulo = botao.textContent;
    botao.textContent = 'Conectando…';
    try {
        const r = await api.conexao.definirToken(campo.value);
        if (!r.ok) {
            erro.hidden = false;
            erro.textContent = r.mensagem;
            return;
        }
        campo.value = '';
        atualizarContagemToken();
        aplicarEstadoConexao(r.estado);
    } finally {
        botao.disabled = false;
        botao.textContent = rotulo;
    }
}

function atualizarContagemToken() {
    const limpo = $('#campo-token').value.replace(/[\s"']/g, '');
    const alvo = $('#contagem-token');
    alvo.textContent = `${limpo.length} de 100 caracteres`;
    alvo.classList.toggle('ok', limpo.length === 100);
}

async function verificarConexao(botao) {
    const rotulo = botao ? botao.textContent : '';
    if (botao) {
        botao.disabled = true;
        botao.textContent = 'Verificando…';
    }
    try {
        aplicarEstadoConexao(await api.conexao.verificar());
    } finally {
        if (botao) {
            botao.disabled = false;
            botao.textContent = rotulo;
        }
    }
}

async function esquecerToken() {
    const certeza = window.confirm(
        'Desconectar este aparelho?\n\n' +
            'O token guardado aqui é apagado e o acervo deixa de abrir até você colar um de novo. ' +
            'A vaga no site continua ocupada até você removê-la por lá.'
    );
    if (!certeza) return;
    aplicarEstadoConexao(await api.conexao.esquecer());
    trocarAba('acervo');
}

// ==========================================================================
// Acervo
// ==========================================================================

const CATEGORIAS = [
    'filme', 'serie', 'anime', 'jogos', 'cursos', 'e-books', 'hq', 'manga',
    'revistas', 'audiobooks', 'esportes', 'jornais', 'aplicativos',
    'stand up comedy', 'adultas', 'outros',
];

let listaAtual = 'acervo'; // acervo | favoritos | baixados
let paginaAtual = 1;
let totalPaginas = 1;
let precoDaGema = 0;
let carregandoAcervo = false;

function filtrosAtuais() {
    return {
        q: $('#busca-acervo').value.trim(),
        categoria: $('#filtro-categoria').value,
        res: $('#filtro-res').value,
        decada: $('#filtro-decada').value,
        ordem: $('#filtro-ordem').value,
        por: $('#filtro-por').value,
        free: $('#filtro-free').checked ? 1 : '',
        page: paginaAtual,
    };
}

function preencherCategorias() {
    const select = $('#filtro-categoria');
    select.replaceChildren();
    const todas = elemento('option', null, 'todas');
    todas.value = '';
    select.append(todas);
    for (const c of CATEGORIAS) {
        const op = elemento('option', null, c);
        op.value = c;
        select.append(op);
    }
}

function trocarLista(nome) {
    listaAtual = nome;
    paginaAtual = 1;
    $$('.sub-aba').forEach((b) => b.classList.toggle('ativa', b.dataset.lista === nome));
    // busca e filtros so existem no acervo
    $('#filtros-acervo').hidden = nome !== 'acervo';
    $('#busca-acervo').disabled = nome !== 'acervo';
    $('#btn-buscar').disabled = nome !== 'acervo';
    carregarAcervo({ pagina: 1 });
}

async function carregarAcervo({ pagina } = {}) {
    if (estadoConexao.fase !== 'aprovado') return;
    if (typeof pagina === 'number') paginaAtual = pagina;
    if (carregandoAcervo) return;
    carregandoAcervo = true;

    const grade = $('#grade-acervo');
    const vazio = $('#vazio-acervo');
    vazio.hidden = true;
    grade.classList.add('carregando');

    try {
        let r;
        if (listaAtual === 'favoritos') r = await api.acervo.favoritos(paginaAtual);
        else if (listaAtual === 'baixados') r = await api.acervo.baixados(paginaAtual);
        else r = await api.acervo.listar(filtrosAtuais());

        if (!r.ok) {
            grade.replaceChildren();
            vazio.hidden = false;
            vazio.textContent = r.mensagem || 'Não consegui carregar o acervo.';
            return;
        }

        const dados = r.dados || {};
        precoDaGema = Number(dados.preco_da_gema) || precoDaGema;
        paginaAtual = Number(dados.pagina) || paginaAtual;
        totalPaginas = Number(dados.paginas) || 1;

        const titulos =
            listaAtual === 'baixados'
                ? (dados.registros || []).map(registroComoCard)
                : dados.titulos || [];

        renderGradeAcervo(titulos, dados);
    } finally {
        carregandoAcervo = false;
        grade.classList.remove('carregando');
    }
}

/** Um registro do historico vira um card com a data e a contagem por cima. */
function registroComoCard(registro) {
    const card = Object.assign({}, registro.titulo || {});
    card.baixadoEm = registro.baixado_em;
    card.vezes = registro.vezes;
    card.opcaoBaixada = registro.opcao || null;
    return card;
}

function renderGradeAcervo(titulos, dados) {
    const grade = $('#grade-acervo');
    grade.replaceChildren();

    for (const t of titulos) grade.append(cartaoDeAcervo(t));

    const vazio = $('#vazio-acervo');
    vazio.hidden = titulos.length > 0;
    vazio.textContent =
        listaAtual === 'favoritos'
            ? 'Você ainda não marcou nenhum título com a estrela.'
            : listaAtual === 'baixados'
              ? 'Nada baixado por esta conta ainda.'
              : 'Nada encontrado com esses filtros.';

    // titulos que a busca achou e que ainda nao tem arquivo
    const semArquivo = (dados && dados.sem_arquivo) || [];
    $('#bloco-sem-arquivo').hidden = semArquivo.length === 0;
    const gradeSem = $('#grade-sem-arquivo');
    gradeSem.replaceChildren();
    for (const t of semArquivo) gradeSem.append(cartaoDeAcervo(t, { semDownload: true }));

    const paginacao = $('#paginacao-acervo');
    paginacao.hidden = totalPaginas <= 1;
    $('#rotulo-pagina').textContent = `página ${paginaAtual} de ${totalPaginas}`;
    $('#btn-pagina-anterior').disabled = paginaAtual <= 1;
    $('#btn-pagina-proxima').disabled = paginaAtual >= totalPaginas;
}

/**
 * A capa vem por um esquema proprio: acervo://capa/<item>. O renderer nunca
 * monta URL de bucket nem ve o token -- quem busca a imagem e o processo
 * principal, que tem os cabecalhos.
 */
function capaDoTitulo(t) {
    if (!t.capa || !t.item_referencia) return null;
    return `acervo://capa/${encodeURIComponent(t.item_referencia)}`;
}

function cartaoDeAcervo(t, { semDownload = false } = {}) {
    const cartao = elemento('div', 'cartao acervo-cartao');

    const topo = elemento('div', 'cartao-topo');
    topo.append(caixaDeCapa(capaDoTitulo(t), t.serie ? '📺' : '🎬'));

    const info = elemento('div', 'cartao-info');
    const h3 = elemento('h3', null, t.titulo || '(sem título)');
    info.append(h3);
    if (t.titulo_alternativo) info.append(elemento('div', 'alternativo', t.titulo_alternativo));

    const partes = [];
    if (t.ano) partes.push(String(t.ano));
    if (t.categoria) partes.push(t.categoria);
    if (t.melhor_resolucao) partes.push(t.melhor_resolucao);
    if (t.faixa_de_tamanho) partes.push(t.faixa_de_tamanho);
    if (t.nota_imdb) partes.push(`★ ${t.nota_imdb}`);
    info.append(elemento('div', 'meta', partes.join(' · ')));

    if (t.baixadoEm) {
        const quando = new Date(t.baixadoEm);
        const texto = isNaN(quando)
            ? ''
            : `baixado em ${quando.toLocaleDateString('pt-BR')}${t.vezes > 1 ? ` · ${t.vezes}×` : ''}`;
        if (texto) info.append(elemento('div', 'meta', texto));
    }

    if (t.tags && t.tags.length) {
        const chips = elemento('div', 'chips');
        for (const tag of t.tags) chips.append(elemento('span', 'chip', tag));
        info.append(chips);
    }

    topo.append(info);
    cartao.append(topo);

    const rodape = elemento('div', 'rodape');
    if (semDownload || t.nada_para_baixar) {
        rodape.append(elemento('span', 'sem-arquivo-aviso', 'ainda sem arquivo'));
    } else {
        const opcoes = elemento(
            'button',
            'botao',
            t.total_opcoes > 1 ? `Ver ${t.total_opcoes} opções` : 'Ver e baixar'
        );
        opcoes.addEventListener('click', () => abrirFicha(t.chave));
        rodape.append(opcoes);

        const estrela = elemento('button', 'botao secundario', '☆');
        estrela.title = 'Favoritar';
        estrela.addEventListener('click', () => favoritar(t.chave, t.item_referencia, estrela));
        rodape.append(estrela);
    }
    cartao.append(rodape);

    return cartao;
}

async function favoritar(chave, item, botao) {
    if (!chave || !item) return;
    botao.disabled = true;
    try {
        const r = await api.acervo.favoritar(chave, item);
        if (!r.ok) {
            aviso(r.mensagem, 'erro');
            return;
        }
        const ligado = !!(r.dados && r.dados.ligado);
        botao.textContent = ligado ? '★' : '☆';
        botao.title = ligado ? 'Tirar dos favoritos' : 'Favoritar';
        if (listaAtual === 'favoritos' && !ligado) carregarAcervo();
    } finally {
        botao.disabled = false;
    }
}

// ----------------------------------------------------------- ficha do titulo

let fichaAtual = null;

async function abrirFicha(chave) {
    const r = await api.acervo.titulo(chave);
    if (!r.ok) {
        aviso(r.mensagem, 'erro');
        return;
    }
    const dados = r.dados || {};
    precoDaGema = Number(dados.preco_da_gema) || precoDaGema;
    fichaAtual = dados.titulo || null;
    if (!fichaAtual) {
        aviso('Esse título não existe mais para esta conta.', 'erro');
        return;
    }
    renderFicha(fichaAtual);
    $('#ficha').hidden = false;
}

function fecharFicha() {
    $('#ficha').hidden = true;
    fichaAtual = null;
}

function renderFicha(t) {
    $('#ficha-titulo').textContent = t.titulo || '(sem título)';

    const previa = $('#ficha-previa');
    previa.replaceChildren();
    const url = capaDoTitulo(t);
    if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.addEventListener('error', () => {
            img.remove();
            previa.textContent = 'sem capa';
        });
        previa.append(img);
    } else {
        previa.textContent = 'sem capa';
    }

    const estrela = $('#btn-ficha-favorito');
    estrela.textContent = '☆ Favoritar';
    estrela.onclick = () => favoritarDaFicha(t, estrela);

    const meta = $('#ficha-meta');
    meta.replaceChildren();
    const partes = [];
    if (t.titulo_alternativo) partes.push(t.titulo_alternativo);
    if (t.ano) partes.push(String(t.ano));
    if (t.categoria) partes.push(t.categoria);
    if (t.nota_imdb) partes.push(`★ ${t.nota_imdb}`);
    meta.append(elemento('div', 'meta', partes.join(' · ')));
    if (t.tags && t.tags.length) {
        const chips = elemento('div', 'chips');
        for (const tag of t.tags) chips.append(elemento('span', 'chip', tag));
        meta.append(chips);
    }

    // A ficha tecnica e um objeto rotulo -> valor ja formatado: as chaves
    // variam por item e podem mudar sem aviso. Listamos como veio.
    const tabela = $('#ficha-tecnica');
    tabela.replaceChildren();
    for (const [rotulo, valor] of Object.entries(t.ficha_tecnica || {})) {
        const linha = document.createElement('tr');
        linha.append(elemento('th', null, rotulo));
        linha.append(elemento('td', null, String(valor)));
        tabela.append(linha);
    }
    tabela.hidden = tabela.childElementCount === 0;

    const lista = $('#ficha-opcoes');
    lista.replaceChildren();
    for (const opcao of t.opcoes || []) lista.append(linhaDeOpcao(opcao));
    if (!(t.opcoes || []).length) {
        lista.append(elemento('p', 'vazio-inline', 'Este título ainda não tem arquivo para baixar.'));
    }

    const faltantes = $('#ficha-faltantes');
    faltantes.replaceChildren();
    const semArquivo = t.faltantes || [];
    faltantes.hidden = semArquivo.length === 0;
    if (semArquivo.length) {
        faltantes.append(elemento('h3', null, 'Ainda não chegaram'));
        for (const f of semArquivo) {
            faltantes.append(elemento('div', 'faltante', f.rotulo || f.nome || String(f.id ?? '')));
        }
    }
}

async function favoritarDaFicha(t, botao) {
    await favoritar(t.chave, t.item_referencia || (t.opcoes && t.opcoes[0] && t.opcoes[0].id), botao);
    const ligado = botao.textContent === '★';
    botao.textContent = ligado ? '★ Nos favoritos' : '☆ Favoritar';
}

function linhaDeOpcao(opcao) {
    const linha = elemento('div', 'opcao');

    const esquerda = elemento('div', 'opcao-info');
    esquerda.append(elemento('div', 'opcao-rotulo', opcao.rotulo || `Opção ${opcao.id}`));

    const etiquetas = elemento('div', 'chips');
    for (const e of opcao.etiquetas || []) etiquetas.append(elemento('span', 'chip', e));
    if (opcao.temporada) etiquetas.append(elemento('span', 'chip', `T${opcao.temporada}`));
    if (opcao.episodio) etiquetas.append(elemento('span', 'chip', `E${opcao.episodio}`));
    esquerda.append(etiquetas);

    const detalhes = [];
    if (opcao.tamanho) detalhes.push(opcao.tamanho);
    if (typeof opcao.seeders === 'number') detalhes.push(`${opcao.seeders} seeds`);
    esquerda.append(elemento('div', 'meta', detalhes.join(' · ')));
    linha.append(esquerda);

    const direita = elemento('div', 'opcao-acoes');
    const preco = elemento(
        'span',
        `preco${opcao.free ? ' free' : ''}`,
        opcao.free ? 'free' : `◆ ${opcao.preco}`
    );
    direita.append(preco);

    const baixar = elemento('button', 'botao', 'Baixar');
    baixar.addEventListener('click', () => baixarOpcao(opcao, baixar));
    direita.append(baixar);

    linha.append(direita);
    return linha;
}

/**
 * Baixar uma opcao.
 *
 * O GET nunca debita: se for free, o arquivo vem na hora. Se custar gema, a
 * API devolve preco e saldo e NADA foi cobrado -- mostramos a confirmacao e so
 * entao chamamos o POST, que e o unico que cobra.
 */
async function baixarOpcao(opcao, botao) {
    const rotulo = botao.textContent;
    botao.disabled = true;
    botao.textContent = 'Pedindo…';
    try {
        const r = await api.acervo.baixar(opcao.id);
        if (!r.ok) {
            aviso(mensagemDeDownload(r), 'erro');
            return;
        }
        if (!r.confirmacao) {
            fecharFicha();
            trocarAba('fila');
            return;
        }

        const aceitou = await pedirConfirmacao(r.confirmacao, opcao);
        if (!aceitou) return;

        botao.textContent = 'Baixando…';
        const c = await api.acervo.confirmar(opcao.id, r.confirmacao.preco);
        if (!c.ok) {
            // O preco virou entre a confirmacao e o POST: nada foi debitado e a
            // resposta ja traz o valor de agora -- da para reperguntar.
            if (c.erro === 'preco_mudou' && c.dados && c.dados.preco) {
                const denovo = await pedirConfirmacao(
                    { preco: Number(c.dados.preco), saldo: Number(c.dados.saldo) || 0 },
                    opcao,
                    'O preço mudou enquanto você decidia. Nada foi cobrado.'
                );
                if (!denovo) return;
                const terceira = await api.acervo.confirmar(opcao.id, Number(c.dados.preco));
                if (!terceira.ok) {
                    aviso(mensagemDeDownload(terceira), 'erro');
                    return;
                }
                fecharFicha();
                trocarAba('fila');
                return;
            }
            aviso(mensagemDeDownload(c), 'erro');
            return;
        }
        fecharFicha();
        trocarAba('fila');
    } finally {
        botao.disabled = false;
        botao.textContent = rotulo;
    }
}

const MENSAGENS_DE_DOWNLOAD = {
    sem_passkey:
        'Esta conta não tem passkey, então nenhum download sai — nem o free. Só o administrador do site resolve.',
    arquivo_indisponivel:
        'O arquivo não abriu no armazenamento do site. Tente mais tarde — nada foi cobrado.',
    sem_saldo: 'Gemas insuficientes para esta opção.',
    opcao_free: 'Esta opção não cobra nada — tente baixar de novo.',
    nao_encontrado: 'Essa opção não existe mais para esta conta.',
};

function mensagemDeDownload(r) {
    return MENSAGENS_DE_DOWNLOAD[r.erro] || r.mensagem || 'Não consegui baixar.';
}

let resolverConfirmacao = null;

function pedirConfirmacao({ preco, saldo }, opcao, aviso_ = '') {
    $('#confirmacao-texto').textContent =
        `${aviso_ ? aviso_ + ' ' : ''}"${opcao.rotulo || 'Esta opção'}" custa gemas. ` +
        'Confirme para baixar.';
    $('#confirmacao-preco').textContent = `◆ ${preco}`;
    $('#confirmacao-saldo').textContent = `◆ ${saldo}`;
    $('#confirmacao-resto').textContent = `◆ ${Math.max(0, saldo - preco)}`;
    $('#btn-confirmacao-ok').disabled = saldo < preco;
    $('#btn-confirmacao-ok').textContent = saldo < preco ? 'Saldo insuficiente' : 'Baixar e gastar';
    $('#confirmacao').hidden = false;

    return new Promise((resolve) => {
        resolverConfirmacao = resolve;
    });
}

function fecharConfirmacao(resposta) {
    $('#confirmacao').hidden = true;
    if (resolverConfirmacao) {
        const r = resolverConfirmacao;
        resolverConfirmacao = null;
        r(resposta);
    }
}

// -------------------------------------------------------------- estado do qbit

let estadoQbit = { fase: 'iniciando', motivo: '', pendentes: 0 };

function renderEstadoQbit() {
    const faixa = $('#estado-qbit');
    const { fase, motivo, pendentes } = estadoQbit;

    if (fase === 'pronto') {
        faixa.hidden = true;
        return;
    }

    faixa.hidden = false;
    faixa.classList.toggle('erro', fase === 'erro');
    $('#btn-qbit-tentar').hidden = fase !== 'erro';

    const itens = pendentes === 1 ? '1 download está esperando' : `${pendentes} downloads estão esperando`;

    if (fase === 'erro') {
        $('#estado-qbit-titulo').textContent = 'O qBittorrent não subiu.';
        $('#estado-qbit-detalhe').textContent = pendentes
            ? `${motivo} — ${itens} e entra na fila assim que ele subir. Nada foi perdido.`
            : motivo;
    } else {
        $('#estado-qbit-titulo').textContent = 'Iniciando o qBittorrent…';
        $('#estado-qbit-detalhe').textContent = pendentes
            ? `${itens} e entra na fila sozinho quando ele responder — não precisa clicar de novo.`
            : 'Na primeira execução isso pode levar alguns segundos.';
    }
}

async function mostrarRegistroQbit() {
    const saida = $('#qbit-registro');
    if (!saida.hidden) {
        saida.hidden = true;
        return;
    }
    saida.hidden = false;
    saida.textContent = 'coletando…';
    try {
        const d = await api.qbit.registro();
        saida.textContent = [
            `binário: ${d.binario}`,
            `porta: ${d.porta || '—'}`,
            `último erro: ${d.ultimoErro || '—'}`,
            '',
            ...(d.linhas.length ? d.linhas : ['(o qbittorrent-nox não escreveu nada)']),
        ].join('\n');
    } catch (erro) {
        saida.textContent = `falha ao coletar: ${erro.message || erro}`;
    }
}

// -------------------------------------------------------------------- fila

function renderFila(forcar) {
    const assinatura = fila
        .map((t) => `${t.hash}:${t.state}:${(t.progress * 1000) | 0}:${t.dlspeed}:${t.eta}`)
        .join('|');
    if (!forcar && !mudou('fila', assinatura)) return;

    const alvo = $('#lista-fila');
    const ativos = fila.filter((t) => t.progress < 1).length;
    const contador = $('#contador-fila');
    contador.hidden = ativos === 0;
    contador.textContent = String(ativos);

    $('#vazio-fila').hidden = fila.length > 0;
    alvo.replaceChildren();

    for (const t of fila) {
        const concluido = t.progress >= 1;
        const item = elemento('div', 'item');

        const topo = elemento('div', 'item-topo');
        topo.append(elemento('div', 'item-nome', t.name));
        topo.append(
            elemento(
                'span',
                `etiqueta ${concluido ? 'ok' : 'baixando'}`,
                rotuloEstado(t.state)
            )
        );

        const acoes = elemento('div', 'item-acoes');
        const entrada = biblioteca.find((e) => e.hash === t.hash);
        if (entrada && entrada.reproduzivel) {
            const assistir = elemento('button', 'icone', '▶');
            assistir.title = 'Assistir';
            assistir.addEventListener('click', () => reproduzirEntrada(entrada));
            acoes.append(assistir);
        }
        const pausado = /paused|stopped/i.test(t.state);
        const alternar = elemento('button', 'icone', pausado ? '▶' : '⏸');
        alternar.title = pausado ? 'Retomar' : 'Pausar';
        alternar.addEventListener('click', () =>
            pausado ? api.fila.retomar(t.hash) : api.fila.pausar(t.hash)
        );
        acoes.append(alternar);

        const remover = elemento('button', 'icone', '🗑');
        remover.title = 'Remover';
        remover.addEventListener('click', () => confirmarRemocao(t));
        acoes.append(remover);

        topo.append(acoes);
        item.append(topo);

        const barra = elemento('div', 'progresso');
        const preenchida = elemento('div');
        preenchida.style.width = `${Math.round(t.progress * 100)}%`;
        barra.append(preenchida);
        item.append(barra);

        const info = elemento('div', 'item-info');
        info.append(elemento('span', null, `${(t.progress * 100).toFixed(1).replace('.', ',')}%`));
        info.append(elemento('span', null, `${tamanho(t.completed)} de ${tamanho(t.size)}`));
        info.append(elemento('span', null, `↓ ${velocidade(t.dlspeed)}`));
        info.append(elemento('span', null, `↑ ${velocidade(t.upspeed)}`));
        if (!concluido) info.append(elemento('span', null, `faltam ${restante(t.eta)}`));
        info.append(elemento('span', null, `${t.num_seeds} seeds`));
        item.append(info);

        alvo.append(item);
    }
}

/**
 * Caixa de entrada da aba Downloads: aceita link magnet e tambem endereco web
 * -- tanto o link direto do .torrent quanto uma pagina que o contenha.
 */
async function adicionarDaCaixa() {
    const campo = $('#campo-magnet');
    const valor = campo.value.trim();
    if (!valor) return;

    const ehMagnet = valor.startsWith('magnet:');
    if (!ehMagnet && !/^https?:\/\//i.test(valor)) {
        aviso('Cole um link magnet ou um endereço que comece com http:// ou https://', 'erro');
        return;
    }

    const botao = $('#btn-magnet');
    campo.value = '';
    botao.disabled = true;
    try {
        if (ehMagnet) await api.fila.adicionarMagnet(valor);
        else await api.fila.adicionarUrl(valor);
    } finally {
        botao.disabled = false;
    }
}

async function escolherArquivoTorrent() {
    const botao = $('#btn-arquivo-torrent');
    botao.disabled = true;
    try {
        await api.fila.escolherArquivo();
    } finally {
        botao.disabled = false;
    }
}

async function confirmarRemocao(t) {
    const apagar = window.confirm(
        `Remover "${t.name}" da fila?\n\nOK = remover e apagar os arquivos\nCancelar = manter na fila`
    );
    if (!apagar) return;
    await api.fila.remover(t.hash, true);
}

// -------------------------------------------------------------- biblioteca

let pastaAtual = null;      // null = raiz
let pastas = [];
let filtroEtiqueta = null;

async function carregarPastas() {
    pastas = (await api.biblioteca.pastas()) || [];
}

function pastaPorId(id) {
    return pastas.find((p) => p.id === id) || null;
}

function filhasDe(id) {
    return pastas.filter((p) => (p.pai || null) === (id || null));
}

/** Quantos titulos a pasta guarda, contando as subpastas. */
function contarNaPasta(id, vistos = new Set()) {
    if (vistos.has(id)) return 0;
    vistos.add(id);
    const diretos = biblioteca.filter((e) => (e.pasta || null) === id).length;
    return filhasDe(id).reduce((total, p) => total + contarNaPasta(p.id, vistos), diretos);
}

function trilhaDe(id) {
    const caminho = [];
    const vistos = new Set();
    let atual = id ? pastaPorId(id) : null;
    while (atual && !vistos.has(atual.id)) {
        caminho.unshift(atual);
        vistos.add(atual.id);
        atual = atual.pai ? pastaPorId(atual.pai) : null;
    }
    return caminho;
}

function entrarNaPasta(id) {
    pastaAtual = id;
    filtroEtiqueta = null;
    $('#busca-biblioteca').value = '';
    filtroBiblioteca = '';
    renderBiblioteca(true);
}

function renderCaminho() {
    const alvo = $('#caminho-biblioteca');
    alvo.replaceChildren();

    const raiz = elemento('button', pastaAtual ? '' : 'atual', 'Biblioteca');
    raiz.addEventListener('click', () => entrarNaPasta(null));
    alvo.append(raiz);

    const caminho = trilhaDe(pastaAtual);
    caminho.forEach((p, i) => {
        alvo.append(elemento('span', 'separador', '/'));
        const b = elemento('button', i === caminho.length - 1 ? 'atual' : '', p.nome);
        b.addEventListener('click', () => entrarNaPasta(p.id));
        alvo.append(b);
    });
}

function renderEtiquetas() {
    const alvo = $('#etiquetas-filtro');
    alvo.replaceChildren();

    const todas = [...new Set(biblioteca.flatMap((e) => e.etiquetas || []))].sort((a, b) =>
        a.localeCompare(b, 'pt-BR')
    );
    if (!todas.length) return;

    for (const etiqueta of todas) {
        const chip = elemento('button', `etiqueta-filtro${filtroEtiqueta === etiqueta ? ' ativa' : ''}`, etiqueta);
        chip.addEventListener('click', () => {
            filtroEtiqueta = filtroEtiqueta === etiqueta ? null : etiqueta;
            renderBiblioteca(true);
        });
        alvo.append(chip);
    }
}

function caixaDeCapa(url, simbolo) {
    const capa = elemento('div', 'capa');
    if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.addEventListener('error', () => {
            img.remove();
            capa.textContent = simbolo;
        });
        capa.append(img);
    } else {
        capa.textContent = simbolo;
    }
    return capa;
}

function cartaoDePasta(pasta) {
    const cartao = elemento('div', 'cartao pasta');
    const topo = elemento('div', 'cartao-topo');
    topo.append(caixaDeCapa(pasta.capa, '📁'));

    const info = elemento('div', 'cartao-info');
    info.append(elemento('h3', null, pasta.nome));
    const quantos = contarNaPasta(pasta.id);
    const subpastas = filhasDe(pasta.id).length;
    const partes = [`${quantos} ${quantos === 1 ? 'título' : 'títulos'}`];
    if (subpastas) partes.push(`${subpastas} ${subpastas === 1 ? 'subpasta' : 'subpastas'}`);
    info.append(elemento('div', 'meta', partes.join(' · ')));
    if (pasta.descricao) info.append(elemento('div', 'descricao', pasta.descricao));
    topo.append(info);
    cartao.append(topo);

    cartao.addEventListener('click', (evento) => {
        if (evento.target.closest('button')) return;
        entrarNaPasta(pasta.id);
    });

    const rodape = elemento('div', 'rodape');
    const abrir = elemento('button', 'botao', 'Abrir');
    abrir.addEventListener('click', () => entrarNaPasta(pasta.id));
    rodape.append(abrir);

    const editar = elemento('button', 'botao secundario', 'Editar');
    editar.addEventListener('click', () => abrirModal('pasta', pasta));
    rodape.append(editar);

    cartao.append(rodape);
    return cartao;
}

function cartaoDeTitulo(e) {
    const cartao = elemento('div', 'cartao');

    const topo = elemento('div', 'cartao-topo');
    topo.append(caixaDeCapa(e.capa, '🎬'));

    const info = elemento('div', 'cartao-info');
    info.append(elemento('h3', null, e.nome));

    const partes = [tamanho(e.tamanho), rotuloEstado(e.estado)];
    if (!e.pronto) partes.push(`${(e.progresso * 100).toFixed(0)}% baixado`);
    info.append(elemento('div', 'meta', partes.join(' · ')));

    if (e.etiquetas && e.etiquetas.length) {
        const chips = elemento('div', 'chips');
        for (const etiqueta of e.etiquetas) chips.append(elemento('span', 'chip', etiqueta));
        info.append(chips);
    }
    if (e.descricao) info.append(elemento('div', 'descricao', e.descricao));

    topo.append(info);
    cartao.append(topo);

    const lista = elemento('div', 'arquivos');
    for (const a of e.arquivos) {
        const linha = elemento('div', `arquivo${a.existe ? '' : ' indisponivel'}`);
        linha.append(elemento('span', null, '🎬'));
        linha.append(elemento('span', 'nome', a.nome));
        const pos = e.posicoes && e.posicoes[a.caminho];
        if (pos && pos.segundos > 30) {
            linha.append(elemento('span', 'retomar', `retomar ${relogio(pos.segundos)}`));
        }
        linha.append(elemento('span', 'meta', tamanho(a.tamanho)));
        if (a.existe) linha.addEventListener('click', () => reproduzir(e, a));
        lista.append(linha);
    }
    cartao.append(lista);

    const rodape = elemento('div', 'rodape');
    const assistir = elemento('button', 'botao', e.pronto ? 'Assistir' : 'Assistir agora');
    assistir.disabled = !e.reproduzivel;
    assistir.addEventListener('click', () => reproduzirEntrada(e));
    rodape.append(assistir);

    const editar = elemento('button', 'botao secundario', 'Editar');
    editar.addEventListener('click', () => abrirModal('titulo', e));
    rodape.append(editar);

    const pasta = elemento('button', 'botao secundario', 'Abrir pasta');
    pasta.addEventListener('click', () => api.biblioteca.abrirPasta(e.principal || e.savePath));
    rodape.append(pasta);

    cartao.append(rodape);
    return cartao;
}

function combina(e, termo) {
    if (!termo) return true;
    const campos = [e.nome, e.nomeOriginal, e.descricao, ...(e.etiquetas || [])];
    return campos.some((c) => (c || '').toLowerCase().includes(termo));
}

function renderBiblioteca(forcar) {
    const termo = filtroBiblioteca.trim().toLowerCase();
    const assinatura = [
        termo,
        pastaAtual || '',
        filtroEtiqueta || '',
        pastas.map((p) => `${p.id}:${p.nome}:${p.pai || ''}:${p.capa || ''}:${p.descricao}`).join('|'),
        biblioteca
            .map((e) =>
                [
                    e.hash, e.estado, (e.progresso * 100) | 0, e.arquivos.length,
                    e.nome, e.capa || '', (e.etiquetas || []).join(','), e.pasta || '', e.descricao || '',
                ].join(':')
            )
            .join('|'),
    ].join('#');
    if (!forcar && !mudou('biblioteca', assinatura)) return;

    renderCaminho();
    renderEtiquetas();

    const alvo = $('#grade-biblioteca');
    alvo.replaceChildren();

    // Buscando ou filtrando por etiqueta, procuramos no acervo inteiro --
    // limitar a pasta atual esconderia justamente o que se procura.
    const buscando = !!termo || !!filtroEtiqueta;

    const titulos = biblioteca.filter((e) => {
        if (filtroEtiqueta && !(e.etiquetas || []).includes(filtroEtiqueta)) return false;
        if (buscando) return combina(e, termo);
        return (e.pasta || null) === pastaAtual;
    });

    if (!buscando) {
        for (const pasta of filhasDe(pastaAtual)) alvo.append(cartaoDePasta(pasta));
    }
    for (const e of titulos) alvo.append(cartaoDeTitulo(e));

    const vazio = $('#vazio-biblioteca');
    vazio.hidden = alvo.childElementCount > 0;
    vazio.textContent = buscando
        ? 'Nada encontrado com esse filtro.'
        : pastaAtual
          ? 'Pasta vazia. Edite um título e escolha esta pasta para trazê-lo para cá.'
          : 'Nada por aqui ainda. O que você baixar aparece nesta aba.';
}

// ---------------------------------------------------------- painel de edicao

let alvoDoModal = null; // { tipo: 'pasta' | 'titulo', dados }

function opcoesDePasta(select, selecionada, excluir) {
    select.replaceChildren();
    const raiz = elemento('option', null, '— nenhuma (raiz) —');
    raiz.value = '';
    select.append(raiz);

    const proibidas = new Set();
    if (excluir) {
        // uma pasta nao pode ser movida para dentro de si mesma nem de suas filhas
        const marcar = (id) => {
            proibidas.add(id);
            filhasDe(id).forEach((f) => marcar(f.id));
        };
        marcar(excluir);
    }

    for (const p of pastas) {
        if (proibidas.has(p.id)) continue;
        const op = elemento('option', null, trilhaDe(p.id).map((x) => x.nome).join(' / '));
        op.value = p.id;
        select.append(op);
    }
    select.value = selecionada || '';
}

function abrirModal(tipo, dados) {
    alvoDoModal = { tipo, dados };

    $('#modal-titulo').textContent = tipo === 'pasta' ? 'Editar pasta' : 'Editar título';
    $('#campo-nome').value = dados.nome || '';
    $('#campo-descricao').value = dados.descricao || '';
    $('#nome-original').textContent =
        tipo === 'titulo' && dados.nomeOriginal && dados.nomeOriginal !== dados.nome
            ? `original: ${dados.nomeOriginal}`
            : '';

    $('#bloco-etiquetas').hidden = tipo === 'pasta';
    $('#campo-etiquetas').value = (dados.etiquetas || []).join(', ');

    opcoesDePasta($('#campo-pasta'), tipo === 'pasta' ? dados.pai : dados.pasta, tipo === 'pasta' ? dados.id : null);

    const blocoEpisodios = $('#bloco-episodios');
    const listaEpisodios = $('#lista-episodios');
    listaEpisodios.replaceChildren();
    const varios = tipo === 'titulo' && dados.arquivos && dados.arquivos.length > 1;
    blocoEpisodios.hidden = !varios;
    if (varios) {
        for (const a of dados.arquivos) {
            const campo = document.createElement('input');
            campo.type = 'text';
            campo.value = a.nome;
            campo.placeholder = a.nomeOriginal || a.nome;
            campo.dataset.caminho = a.caminho;
            listaEpisodios.append(campo);
        }
    }

    $('#btn-modal-excluir').hidden = tipo !== 'pasta';
    $('#campo-capa-url').value = '';
    atualizarPreviaCapa(dados.capa);

    $('#modal').hidden = false;
    $('#campo-nome').focus();
}

function atualizarPreviaCapa(url) {
    const previa = $('#modal-previa');
    previa.replaceChildren();
    if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        previa.append(img);
    } else {
        previa.textContent = 'sem capa';
    }
}

function fecharModal() {
    $('#modal').hidden = true;
    alvoDoModal = null;
}

function alvoDaCapa() {
    return {
        tipo: alvoDoModal.tipo,
        id: alvoDoModal.tipo === 'pasta' ? alvoDoModal.dados.id : alvoDoModal.dados.hash,
    };
}

/** Depois de trocar a capa, relê o item para mostrar a imagem nova na prévia. */
async function recarregarPrevia() {
    if (!alvoDoModal) return;
    if (alvoDoModal.tipo === 'pasta') {
        await carregarPastas();
        const p = pastaPorId(alvoDoModal.dados.id);
        if (p) {
            alvoDoModal.dados = p;
            atualizarPreviaCapa(p.capa);
        }
    } else {
        biblioteca = (await api.biblioteca.listar()) || [];
        const e = biblioteca.find((x) => x.hash === alvoDoModal.dados.hash);
        if (e) {
            alvoDoModal.dados = e;
            atualizarPreviaCapa(e.capa);
        }
    }
    renderBiblioteca(true);
}

async function definirCapa(origem) {
    if (!alvoDoModal) return;
    const r = await api.biblioteca.definirCapa(alvoDaCapa(), origem);
    if (r && r.cancelado) return;
    if (r && r.erro) {
        aviso(`Não consegui usar essa imagem: ${r.erro}`, 'erro');
        return;
    }
    await recarregarPrevia();
    aviso('Capa atualizada.', 'ok');
}

async function salvarModal() {
    if (!alvoDoModal) return;
    const { tipo, dados } = alvoDoModal;
    const nome = $('#campo-nome').value;
    const descricao = $('#campo-descricao').value;
    const pastaEscolhida = $('#campo-pasta').value || null;

    if (tipo === 'pasta') {
        await api.biblioteca.editarPasta(dados.id, { nome, descricao, pai: pastaEscolhida });
        await carregarPastas();
    } else {
        await api.biblioteca.editarTitulo(dados.hash, {
            nome,
            descricao,
            etiquetas: $('#campo-etiquetas').value,
            pasta: pastaEscolhida,
        });
        for (const campo of $$('#lista-episodios input')) {
            const original = (dados.arquivos.find((a) => a.caminho === campo.dataset.caminho) || {}).nomeOriginal;
            const valor = campo.value.trim();
            await api.biblioteca.editarArquivo(dados.hash, campo.dataset.caminho, valor === original ? '' : valor);
        }
        biblioteca = (await api.biblioteca.listar()) || [];
    }

    fecharModal();
    renderBiblioteca(true);
    aviso('Alterações salvas.', 'ok');
}

async function excluirPastaDoModal() {
    if (!alvoDoModal || alvoDoModal.tipo !== 'pasta') return;
    const pasta = alvoDoModal.dados;
    const quantos = contarNaPasta(pasta.id);
    const texto = quantos
        ? `Excluir a pasta "${pasta.nome}"?\n\nOs ${quantos} título(s) dentro dela sobem um nível — nenhum arquivo em disco é apagado.`
        : `Excluir a pasta "${pasta.nome}"?`;
    if (!window.confirm(texto)) return;

    await api.biblioteca.removerPasta(pasta.id);
    await carregarPastas();
    if (pastaAtual === pasta.id) pastaAtual = pasta.pai || null;
    biblioteca = (await api.biblioteca.listar()) || [];
    fecharModal();
    renderBiblioteca(true);
    aviso('Pasta excluída.', 'ok');
}

async function criarPasta() {
    const nome = window.prompt('Nome da nova pasta:', 'Nova pasta');
    if (!nome) return;
    await api.biblioteca.criarPasta({ nome, pai: pastaAtual });
    await carregarPastas();
    renderBiblioteca(true);
    aviso('Pasta criada.', 'ok');
}

function reproduzirEntrada(e) {
    const escolhido =
        e.arquivos.find((a) => a.caminho === e.ultimoArquivo && a.existe) ||
        e.arquivos.find((a) => a.caminho === e.principal && a.existe) ||
        e.arquivos.find((a) => a.existe);
    if (!escolhido) {
        aviso('Os arquivos ainda não estão disponíveis.', 'erro');
        return;
    }
    reproduzir(e, escolhido);
}

// ------------------------------------------------------------------ player

async function reproduzir(entrada, arquivo) {
    try {
        mensagemVideo('Abrindo…');
        const r = await api.player.abrir({ hash: entrada.hash, caminho: arquivo.caminho });
        player.aberto = true;
        player.hash = entrada.hash;
        player.caminho = arquivo.caminho;
        player.nome = arquivo.nome;
        player.tempo = r.posicao || 0;
        player.duracao = 0;
        player.cache = 0;
        $('#titulo-player').textContent = `${entrada.nome} — ${arquivo.nome}`;
        trocarAba('player');
        mensagemVideo(null);
        if (!r.embutido) {
            aviso('O vídeo abriu em janela separada — os controles daqui continuam valendo.', 'info');
        }
        setTimeout(atualizarFaixas, 1200);
    } catch (erro) {
        mensagemVideo(null);
        aviso(erro.message || String(erro), 'erro');
    }
}

function mensagemVideo(texto) {
    const el = $('#mensagem-video');
    el.hidden = !texto;
    el.textContent = texto || '';
}

async function fecharPlayer() {
    await api.player.fechar();
    player.aberto = false;
    player.hash = null;
    player.caminho = null;
    $('#faixa-audio').replaceChildren();
    $('#faixa-legenda').replaceChildren();
    if (document.body.classList.contains('tela-cheia')) api.ui.telaCheia(false);
    trocarAba('biblioteca');
}

function cmd(...args) {
    return api.player.comando(...args);
}

async function atualizarFaixas() {
    if (!player.aberto) return;
    let faixas;
    try {
        faixas = await api.player.faixas();
    } catch {
        return;
    }
    preencherSelect($('#faixa-audio'), faixas.audio, false);
    preencherSelect($('#faixa-legenda'), faixas.legenda, true);
}

const IDIOMAS = {
    por: 'Português', pt: 'Português', 'pt-br': 'Português (BR)',
    eng: 'Inglês', en: 'Inglês', spa: 'Espanhol', es: 'Espanhol',
    jpn: 'Japonês', ja: 'Japonês', fre: 'Francês', fra: 'Francês',
    ger: 'Alemão', deu: 'Alemão', ita: 'Italiano', kor: 'Coreano',
    chi: 'Chinês', zho: 'Chinês', rus: 'Russo',
};

function rotuloFaixa(f, indice) {
    const partes = [];
    const idioma = IDIOMAS[(f.idioma || '').toLowerCase()] || f.idioma;
    if (idioma) partes.push(idioma);
    if (f.titulo) partes.push(f.titulo);
    if (!partes.length) partes.push(`Faixa ${indice + 1}`);
    const extra = [f.codec, f.canais ? `${f.canais}ch` : null].filter(Boolean).join(' ');
    return extra ? `${partes.join(' · ')} (${extra})` : partes.join(' · ');
}

function preencherSelect(select, faixas, comNenhuma) {
    select.replaceChildren();
    if (comNenhuma) {
        const nenhuma = elemento('option', null, 'Desligada');
        nenhuma.value = 'no';
        select.append(nenhuma);
    }
    faixas.forEach((f, i) => {
        const op = elemento('option', null, rotuloFaixa(f, i));
        op.value = String(f.id);
        if (f.selecionada) op.selected = true;
        select.append(op);
    });
    if (comNenhuma && !faixas.some((f) => f.selecionada)) select.value = 'no';
    select.disabled = faixas.length === 0 && !comNenhuma;
}

function atualizarBarra() {
    const d = player.duracao || 0;
    const t = Math.min(player.tempo, d || player.tempo);
    const pct = d > 0 ? (t / d) * 100 : 0;
    if (!player.arrastando) {
        $('#trilha-preenchida').style.width = `${pct}%`;
        $('#trilha-marcador').style.left = `${pct}%`;
    }
    const cache = d > 0 ? Math.min(100, ((t + player.cache) / d) * 100) : 0;
    $('#trilha-buffer').style.width = `${cache}%`;
    $('#tempo-atual').textContent = relogio(t);
    $('#tempo-total').textContent = relogio(d);
}

function tratarEventoPlayer(ev) {
    if (ev.tipo === 'tela-cheia') {
        document.body.classList.toggle('tela-cheia', ev.valor);
        requestAnimationFrame(enviarLayout);
        return;
    }

    if (ev.tipo === 'evento') {
        if (ev.nome === 'encerrado' && player.aberto) {
            player.aberto = false;
            trocarAba('biblioteca');
        }
        if (ev.nome === 'file-loaded') setTimeout(atualizarFaixas, 300);
        return;
    }

    if (ev.tipo !== 'propriedade') return;

    switch (ev.nome) {
        case 'time-pos':
            player.tempo = ev.valor || 0;
            atualizarBarra();
            break;
        case 'duration':
            player.duracao = ev.valor || 0;
            atualizarBarra();
            break;
        case 'demuxer-cache-time':
            player.cache = Math.max(0, (ev.valor || 0) - player.tempo);
            atualizarBarra();
            break;
        case 'pause':
            player.pausado = !!ev.valor;
            $('#btn-play').textContent = player.pausado ? '▶' : '⏸';
            break;
        case 'volume':
            $('#volume').value = Math.round(ev.valor || 0);
            break;
        case 'mute':
            $('#btn-mudo').textContent = ev.valor ? '🔇' : '🔊';
            break;
        case 'track-list':
            atualizarFaixas();
            break;
        case 'paused-for-cache':
            mensagemVideo(ev.valor ? 'Aguardando o download alcançar este ponto…' : null);
            break;
        case 'eof-reached':
            if (ev.valor) {
                const entrada = biblioteca.find((e) => e.hash === player.hash);
                mensagemVideo(
                    entrada && !entrada.pronto
                        ? 'O player chegou ao fim do que já foi baixado. Assim que o download avançar, é só dar play de novo.'
                        : 'Fim do vídeo.'
                );
            } else {
                mensagemVideo(null);
            }
            break;
        default:
            break;
    }
}

function salvarPosicao() {
    if (!player.aberto || !player.hash || player.tempo <= 0) return;
    api.player.salvarPosicao({
        hash: player.hash,
        caminho: player.caminho,
        segundos: player.tempo,
        duracao: player.duracao,
    });
}

// ------------------------------------------------------------------ avisos

function aviso(texto, tipo = 'info') {
    const el = elemento('div', `aviso ${tipo}`, texto);
    $('#avisos').append(el);

    const sumir = () => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 300);
    };
    el.addEventListener('click', sumir); // dá para tirar da frente antes da hora

    // Erro é justamente o que o usuário precisa ler: 4 segundos não bastam.
    setTimeout(sumir, tipo === 'erro' ? 14000 : 4200);
}

// ------------------------------------------------------------------ config

async function carregarConfig() {
    configuracao = await api.config.ler();
    $('#cfg-pasta').value = configuracao.pastaDownloads;
    $('#cfg-site').value = configuracao.siteUrl;
    $('#cfg-api').value = configuracao.apiUrl;
    $('#cfg-nome-aparelho').value = configuracao.nomeDoAparelho || '';
    $('#cfg-sequencial').checked = !!configuracao.downloadSequencial;
    $('#cfg-janela-separada').checked = !!configuracao.videoEmJanelaSeparada;
    $('#cfg-limite-down').value = configuracao.limiteDownload || 0;
    $('#cfg-limite-up').value = configuracao.limiteUpload || 0;
    $('#cfg-qbit-usuario').value = configuracao.qbitUsuario || '';
    $('#cfg-qbit-senha').value = configuracao.qbitSenha || '';
    $('#volume').value = configuracao.volume ?? 100;

    const info = await api.info();
    $('#sobre').textContent =
        `Torrange ${info.versao} · Electron ${info.electron} · ${info.plataforma}` +
        `${info.empacotado ? '' : ' (desenvolvimento)'}\n` +
        `API do aplicativo: ${info.api}\n` +
        `qBittorrent embutido: ${info.qbit}\n` +
        `  ${info.binarios.qbit}\n` +
        `Player: ${info.videoAcoplado ? 'acoplado à janela' : 'janela separada'}\n` +
        `  ${info.binarios.mpv}\n` +
        `Dados do app: ${info.dados}\n\n` +
        'qBittorrent e mpv são softwares livres de terceiros, distribuídos aqui como ' +
        'programas independentes (GPLv3 e LGPLv2.1+). Código-fonte em ' +
        'github.com/qbittorrent/qBittorrent e github.com/mpv-player/mpv.';
}

async function salvarConfig() {
    const usuarioQbit = $('#cfg-qbit-usuario').value.trim();
    const senhaQbit = $('#cfg-qbit-senha').value;

    // um sem o outro não dá: o qBittorrent precisa do par para autenticar
    if (!!usuarioQbit !== !!senhaQbit) {
        aviso('Preencha usuário e senha do qBittorrent, ou deixe os dois em branco.', 'erro');
        return;
    }

    const botao = $('#btn-salvar');
    botao.disabled = true;
    try {
        const novo = await api.config.gravar({
            siteUrl: $('#cfg-site').value.trim() || configuracao.siteUrl,
            apiUrl: $('#cfg-api').value.trim() || configuracao.apiUrl,
            nomeDoAparelho: $('#cfg-nome-aparelho').value.trim(),
            downloadSequencial: $('#cfg-sequencial').checked,
            videoEmJanelaSeparada: $('#cfg-janela-separada').checked,
            limiteDownload: Number($('#cfg-limite-down').value) || 0,
            limiteUpload: Number($('#cfg-limite-up').value) || 0,
            qbitUsuario: usuarioQbit,
            qbitSenha: senhaQbit,
        });
        configuracao = novo;
        aviso('Ajustes salvos.', 'ok');
        await mostrarAcessoQbit();
    } finally {
        botao.disabled = false;
    }
}

/** Mostra onde e com qual usuário dá para abrir a WebUI do qBittorrent. */
async function mostrarAcessoQbit() {
    const campo = $('#qbit-endereco');
    if (!campo) return;
    try {
        const info = await api.info();
        if (!info.webui) {
            campo.textContent = 'O qBittorrent não está no ar agora.';
            return;
        }
        campo.textContent = info.qbitCredencialTemporaria
            ? `No ar em ${info.webui}. Atenção: ele recusou as credenciais do app e está ` +
              `usando a senha temporária que ele mesmo gerou (usuário "${info.qbitUsuario}").`
            : `No ar em ${info.webui} — usuário "${info.qbitUsuario}".`;
    } catch {
        campo.textContent = '';
    }
}

// ------------------------------------------------------------- diagnostico

function formatarDiagnostico(d) {
    const linhas = [];
    const item = (rotulo, valor) => linhas.push(`${rotulo.padEnd(22)} ${valor}`);

    item('plataforma', d.plataforma);
    item('acopla video?', d.videoAcoplavel ? 'sim' : 'nao (janela separada)');
    item('player aberto', d.aberto ? 'sim' : 'nao');
    item('modo', d.embutido ? 'acoplado à janela' : 'janela separada');
    if (d.wid) item('id da janela (wid)', d.wid);
    item('binario do mpv', d.binario);

    if (d.aberto) {
        linhas.push('');
        item('saida de video (vo)', d.vo || '*** VAZIO — sem imagem por isso ***');
        item('saida de audio (ao)', d.ao || '(vazio)');
        item('decodificacao', d.hwdec || '(software)');
        item('codec', d.codec || '(?)');
        item('resolucao', `${d.resolucao || '?'}x${d.alturaVideo || '?'}`);
        item('tempo', `${Number(d.tempo || 0).toFixed(1)}s ${d.pausado ? '(pausado)' : '(tocando)'}`);
        if (d.tamanhoJanela) {
            item('area de desenho', `${d.tamanhoJanela.w}x${d.tamanhoJanela.h}`);
        }
    }

    linhas.push('');
    item('janela do mpv', d.janelaMpv ? `${d.janelaMpv.width}x${d.janelaMpv.height} em ${d.janelaMpv.x},${d.janelaMpv.y}` : '(nao existe)');
    item('visivel', d.janelaVisivel ? 'sim' : 'nao');
    item('area pedida pela UI', d.retanguloPedido
        ? `${Math.round(d.retanguloPedido.width)}x${Math.round(d.retanguloPedido.height)} em ${Math.round(d.retanguloPedido.x)},${Math.round(d.retanguloPedido.y)}`
        : '(nenhuma)');
    item('janela principal', d.janelaPrincipal
        ? `${d.janelaPrincipal.width}x${d.janelaPrincipal.height} em ${d.janelaPrincipal.x},${d.janelaPrincipal.y}`
        : '(?)');

    linhas.push('', '--- log do mpv ---');
    linhas.push(...(d.log && d.log.length ? d.log : ['(vazio)']));

    return linhas.join('\n');
}

let ultimoDiagnostico = null;

async function gerarArquivoDiagnostico() {
    const botao = $('#btn-diagnostico-arquivo');
    const rotulo = botao.textContent;
    botao.disabled = true;
    botao.textContent = 'Coletando…';
    try {
        const r = await api.diagnostico.gerar();
        if (r.cancelado) return;
        if (r.erro) {
            aviso(`Não consegui gerar o diagnóstico: ${r.erro}`, 'erro');
            return;
        }
        ultimoDiagnostico = r.caminho;
        const campo = $('#caminho-diagnostico');
        campo.hidden = false;
        campo.textContent = `Salvo em ${r.caminho} (${tamanho(r.bytes)}).`;
        $('#btn-abrir-diagnostico').hidden = false;
    } finally {
        botao.disabled = false;
        botao.textContent = rotulo;
    }
}

async function coletarDiagnostico() {
    const saida = $('#saida-diagnostico');
    saida.hidden = false;
    saida.textContent = 'coletando…';
    try {
        saida.textContent = formatarDiagnostico(await api.player.diagnostico());
        $('#btn-copiar-diagnostico').hidden = false;
    } catch (erro) {
        saida.textContent = `falha ao coletar: ${erro.message || erro}`;
    }
}

// ------------------------------------------------------------------ eventos

function ligarEventos() {
    $$('.aba').forEach((b) => b.addEventListener('click', () => trocarAba(b.dataset.aba)));
    $('#pilula-player').addEventListener('click', () => trocarAba('player'));

    // ------------------------------------------------------------ conexao
    $('#campo-token').addEventListener('input', atualizarContagemToken);
    $('#campo-token').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) salvarToken();
    });
    $('#btn-salvar-token').addEventListener('click', salvarToken);
    for (const id of ['#btn-abrir-aplicativos', '#btn-abrir-aplicativos-2', '#btn-abrir-aplicativos-3', '#btn-cfg-abrir-site']) {
        $(id).addEventListener('click', () => api.conexao.abrirSite());
    }
    $('#btn-verificar').addEventListener('click', (e) => verificarConexao(e.target));
    $('#btn-verificar-2').addEventListener('click', (e) => verificarConexao(e.target));
    $('#btn-cfg-verificar').addEventListener('click', (e) => verificarConexao(e.target));
    $('#btn-trocar-token').addEventListener('click', esquecerToken);
    $('#btn-trocar-token-2').addEventListener('click', esquecerToken);
    $('#btn-cfg-esquecer').addEventListener('click', esquecerToken);

    // ------------------------------------------------------------- acervo
    $$('.sub-aba').forEach((b) => b.addEventListener('click', () => trocarLista(b.dataset.lista)));
    $('#btn-buscar').addEventListener('click', () => carregarAcervo({ pagina: 1 }));
    $('#busca-acervo').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') carregarAcervo({ pagina: 1 });
    });
    for (const id of ['#filtro-categoria', '#filtro-res', '#filtro-decada', '#filtro-ordem', '#filtro-por', '#filtro-free']) {
        $(id).addEventListener('change', () => carregarAcervo({ pagina: 1 }));
    }
    $('#btn-limpar-filtros').addEventListener('click', () => {
        $('#busca-acervo').value = '';
        $('#filtro-categoria').value = '';
        $('#filtro-res').value = '';
        $('#filtro-decada').value = '';
        $('#filtro-ordem').value = 'chegada';
        $('#filtro-por').value = '20';
        $('#filtro-free').checked = false;
        carregarAcervo({ pagina: 1 });
    });
    $('#btn-pagina-anterior').addEventListener('click', () => carregarAcervo({ pagina: paginaAtual - 1 }));
    $('#btn-pagina-proxima').addEventListener('click', () => carregarAcervo({ pagina: paginaAtual + 1 }));

    $('#btn-ficha-fechar').addEventListener('click', fecharFicha);
    $('#ficha-fundo').addEventListener('click', fecharFicha);
    $('#btn-confirmacao-cancelar').addEventListener('click', () => fecharConfirmacao(false));
    $('#confirmacao-fundo').addEventListener('click', () => fecharConfirmacao(false));
    $('#btn-confirmacao-ok').addEventListener('click', () => fecharConfirmacao(true));

    // --------------------------------------------------------------- fila
    $('#btn-magnet').addEventListener('click', adicionarDaCaixa);
    $('#campo-magnet').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') adicionarDaCaixa();
    });
    $('#btn-arquivo-torrent').addEventListener('click', escolherArquivoTorrent);
    $('#btn-qbit-detalhes').addEventListener('click', mostrarRegistroQbit);
    $('#btn-qbit-diagnostico').addEventListener('click', async () => {
        await gerarArquivoDiagnostico();
        if (ultimoDiagnostico) aviso('Diagnóstico salvo. Anexe esse arquivo ao relatar o problema.', 'ok');
    });
    $('#btn-qbit-tentar').addEventListener('click', async () => {
        const botao = $('#btn-qbit-tentar');
        botao.disabled = true;
        $('#estado-qbit-titulo').textContent = 'Tentando de novo…';
        try {
            estadoQbit = await api.qbit.tentarDeNovo();
            renderEstadoQbit();
        } finally {
            botao.disabled = false;
        }
    });

    // biblioteca
    $('#busca-biblioteca').addEventListener('input', (e) => {
        filtroBiblioteca = e.target.value;
        renderBiblioteca(true);
    });
    $('#btn-nova-pasta').addEventListener('click', criarPasta);

    // painel de edicao
    $('#btn-modal-cancelar').addEventListener('click', fecharModal);
    $('#modal-fundo').addEventListener('click', fecharModal);
    $('#btn-modal-salvar').addEventListener('click', salvarModal);
    $('#btn-modal-excluir').addEventListener('click', excluirPastaDoModal);
    $('#btn-capa-arquivo').addEventListener('click', () => definirCapa({ escolher: true }));
    $('#btn-capa-url').addEventListener('click', () => {
        const url = $('#campo-capa-url').value.trim();
        if (!/^https?:\/\//i.test(url)) {
            aviso('Cole um link que comece com http:// ou https://', 'erro');
            return;
        }
        definirCapa({ url });
    });
    $('#btn-capa-remover').addEventListener('click', async () => {
        if (!alvoDoModal) return;
        await api.biblioteca.removerCapa(alvoDaCapa());
        await recarregarPrevia();
    });

    // ajustes
    $('#btn-pasta').addEventListener('click', async () => {
        const novo = await api.config.escolherPasta();
        if (novo) {
            configuracao = novo;
            $('#cfg-pasta').value = novo.pastaDownloads;
            aviso('Pasta de downloads atualizada.', 'ok');
        }
    });
    $('#btn-salvar').addEventListener('click', salvarConfig);
    $('#cfg-qbit-ver-senha').addEventListener('change', (e) => {
        $('#cfg-qbit-senha').type = e.target.checked ? 'text' : 'password';
    });
    $('#btn-diagnostico-arquivo').addEventListener('click', gerarArquivoDiagnostico);
    $('#btn-abrir-diagnostico').addEventListener('click', () => {
        if (ultimoDiagnostico) api.diagnostico.abrirArquivo(ultimoDiagnostico);
    });
    $('#btn-diagnostico').addEventListener('click', coletarDiagnostico);
    $('#btn-copiar-diagnostico').addEventListener('click', async () => {
        await navigator.clipboard.writeText($('#saida-diagnostico').textContent);
        aviso('Diagnóstico copiado.', 'ok');
    });

    // player
    $('#btn-play').addEventListener('click', () => cmd('cycle', 'pause'));
    $('#btn-voltar10').addEventListener('click', () => cmd('seek', -10, 'relative'));
    $('#btn-avancar30').addEventListener('click', () => cmd('seek', 30, 'relative'));
    $('#btn-mudo').addEventListener('click', () => cmd('cycle', 'mute'));
    $('#btn-fechar-player').addEventListener('click', fecharPlayer);
    $('#btn-tela-cheia').addEventListener('click', () =>
        api.ui.telaCheia(!document.body.classList.contains('tela-cheia'))
    );

    $('#volume').addEventListener('input', (e) => {
        const v = Number(e.target.value);
        cmd('set_property', 'volume', v);
        api.config.gravar({ volume: v });
    });

    $('#faixa-audio').addEventListener('change', (e) =>
        cmd('set_property', 'aid', e.target.value)
    );
    $('#faixa-legenda').addEventListener('change', (e) =>
        cmd('set_property', 'sid', e.target.value)
    );

    const trilha = $('#trilha');
    const posicaoNaTrilha = (evento) => {
        const r = trilha.getBoundingClientRect();
        return Math.max(0, Math.min(1, (evento.clientX - r.left) / r.width));
    };
    trilha.addEventListener('pointerdown', (evento) => {
        if (!player.duracao) return;
        player.arrastando = true;
        trilha.setPointerCapture(evento.pointerId);
        const f = posicaoNaTrilha(evento);
        $('#trilha-preenchida').style.width = `${f * 100}%`;
        $('#trilha-marcador').style.left = `${f * 100}%`;
    });
    trilha.addEventListener('pointermove', (evento) => {
        if (!player.arrastando) return;
        const f = posicaoNaTrilha(evento);
        $('#trilha-preenchida').style.width = `${f * 100}%`;
        $('#trilha-marcador').style.left = `${f * 100}%`;
        $('#tempo-atual').textContent = relogio(f * player.duracao);
    });
    trilha.addEventListener('pointerup', (evento) => {
        if (!player.arrastando) return;
        player.arrastando = false;
        cmd('seek', posicaoNaTrilha(evento) * player.duracao, 'absolute');
    });

    // teclado
    document.addEventListener('keydown', (evento) => {
        // Com qualquer painel aberto, nenhum atalho do player responde.
        const painelAberto = ['#modal', '#ficha', '#confirmacao'].find((id) => !$(id).hidden);
        if (painelAberto) {
            if (evento.key === 'Escape') {
                evento.preventDefault();
                if (painelAberto === '#modal') fecharModal();
                else if (painelAberto === '#ficha') fecharFicha();
                else fecharConfirmacao(false);
            }
            return;
        }
        if (/^(INPUT|SELECT|TEXTAREA)$/.test(evento.target.tagName)) return;
        if (abaAtual !== 'player') return;
        const acoes = {
            ' ': () => cmd('cycle', 'pause'),
            ArrowLeft: () => cmd('seek', -5, 'relative'),
            ArrowRight: () => cmd('seek', 5, 'relative'),
            ArrowUp: () => cmd('add', 'volume', 5),
            ArrowDown: () => cmd('add', 'volume', -5),
            f: () => api.ui.telaCheia(!document.body.classList.contains('tela-cheia')),
            m: () => cmd('cycle', 'mute'),
            Escape: () =>
                document.body.classList.contains('tela-cheia')
                    ? api.ui.telaCheia(false)
                    : fecharPlayer(),
        };
        const acao = acoes[evento.key];
        if (acao) {
            evento.preventDefault();
            acao();
        }
    });

    // esconde os controles quando o mouse para, em tela cheia
    let ocioso = null;
    document.addEventListener('mousemove', () => {
        document.body.classList.remove('ocioso');
        clearTimeout(ocioso);
        ocioso = setTimeout(() => {
            if (document.body.classList.contains('tela-cheia') && !player.pausado) {
                document.body.classList.add('ocioso');
            }
        }, 2500);
    });

    // layout da view nativa do video
    window.addEventListener('resize', enviarLayout);
    const observador = new ResizeObserver(enviarLayout);
    observador.observe($('#area-video'));

    // eventos vindos do processo principal
    api.ao('conexao:estado', aplicarEstadoConexao);
    api.ao('fila:atualizou', (lista) => {
        fila = lista || [];
        renderFila();
    });
    api.ao('biblioteca:atualizou', (lista) => {
        biblioteca = lista || [];
        renderBiblioteca();
        if (abaAtual === 'fila') renderFila();
    });
    api.ao('player:evento', tratarEventoPlayer);
    api.ao('qbit:estado', (d) => {
        estadoQbit = d || estadoQbit;
        renderEstadoQbit();
        if (estadoQbit.fase === 'pronto') mostrarAcessoQbit();
    });
    api.ao('aviso', (d) => aviso(d.texto, d.tipo));

    setInterval(salvarPosicao, 5000);
    window.addEventListener('beforeunload', salvarPosicao);
}

// ------------------------------------------------------------------ inicio

// Erro na interface tambem entra no arquivo de diagnostico -- sem isto, o que
// quebra a tela nao aparece em lugar nenhum do log.
window.addEventListener('error', (e) => {
    api.diagnostico.anotar('interface', `${e.message} (${e.filename}:${e.lineno})`);
});
window.addEventListener('unhandledrejection', (e) => {
    const motivo = e.reason;
    api.diagnostico.anotar('interface', `promessa rejeitada: ${(motivo && motivo.stack) || motivo}`);
});

(async function iniciar() {
    preencherCategorias();
    ligarEventos();
    await carregarConfig();
    trocarAba('acervo');

    estadoConexao = (await api.conexao.estado()) || estadoConexao;
    renderConexao();
    if (estadoConexao.fase === 'aprovado') carregarAcervo({ pagina: 1 });

    fila = (await api.fila.listar()) || [];
    biblioteca = (await api.biblioteca.listar()) || [];
    await carregarPastas();
    // o qBittorrent pode ter subido (ou falhado) antes desta tela existir
    estadoQbit = (await api.qbit.estado()) || estadoQbit;
    renderEstadoQbit();
    mostrarAcessoQbit();
    renderFila(true);
    renderBiblioteca(true);
})();
