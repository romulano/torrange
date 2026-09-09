'use strict';
/* Torrange - interface. Conversa com o processo principal pelo bridge window.torrange. */

const api = window.torrange;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let abaAtual = 'site';
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
    $('#nav-site').style.visibility = nome === 'site' ? 'visible' : 'hidden';
    $('#pilula-player').hidden = !(player.aberto && nome !== 'player');

    // as views nativas so podem ser posicionadas depois que o layout assentou
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
    api.ui.layout({ site: retangulo('#area-site'), player: retangulo('#area-video') });
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

async function confirmarRemocao(t) {
    const apagar = window.confirm(
        `Remover "${t.name}" da fila?\n\nOK = remover e apagar os arquivos\nCancelar = manter na fila`
    );
    if (!apagar) return;
    await api.fila.remover(t.hash, true);
}

// -------------------------------------------------------------- biblioteca

function renderBiblioteca(forcar) {
    const termo = filtroBiblioteca.trim().toLowerCase();
    const assinatura =
        termo +
        '#' +
        biblioteca
            .map((e) => `${e.hash}:${e.estado}:${(e.progresso * 100) | 0}:${e.arquivos.length}:${e.ultimoArquivo || ''}`)
            .join('|');
    if (!forcar && !mudou('biblioteca', assinatura)) return;

    const alvo = $('#grade-biblioteca');
    const itens = termo
        ? biblioteca.filter((e) => e.nome.toLowerCase().includes(termo))
        : biblioteca;

    $('#vazio-biblioteca').hidden = itens.length > 0;
    alvo.replaceChildren();

    for (const e of itens) {
        const cartao = elemento('div', 'cartao');
        cartao.append(elemento('h3', null, e.nome));

        const meta = elemento('div', 'meta');
        const partes = [tamanho(e.tamanho), rotuloEstado(e.estado)];
        if (!e.pronto) partes.push(`${(e.progresso * 100).toFixed(0)}% baixado`);
        meta.textContent = partes.join(' · ');
        cartao.append(meta);

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
            if (a.existe) {
                linha.addEventListener('click', () => reproduzir(e, a));
            }
            lista.append(linha);
        }
        cartao.append(lista);

        const rodape = elemento('div', 'rodape');
        const assistir = elemento('button', 'botao', e.pronto ? 'Assistir' : 'Assistir agora');
        assistir.disabled = !e.reproduzivel;
        assistir.addEventListener('click', () => reproduzirEntrada(e));
        rodape.append(assistir);

        const pasta = elemento('button', 'botao secundario', 'Abrir pasta');
        pasta.addEventListener('click', () => api.biblioteca.abrirPasta(e.principal || e.savePath));
        rodape.append(pasta);
        cartao.append(rodape);

        alvo.append(cartao);
    }
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
            aviso('Sessão Wayland detectada: o vídeo abriu em janela separada.', 'info');
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
    setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 300);
    }, 4200);
}

// ------------------------------------------------------------------ config

async function carregarConfig() {
    configuracao = await api.config.ler();
    $('#cfg-pasta').value = configuracao.pastaDownloads;
    $('#cfg-site').value = configuracao.siteUrl;
    $('#cfg-sequencial').checked = !!configuracao.downloadSequencial;
    $('#cfg-renomear').checked = !!configuracao.renomearBotaoBaixar;
    $('#cfg-janela-separada').checked = !!configuracao.videoEmJanelaSeparada;
    $('#cfg-limite-down').value = configuracao.limiteDownload || 0;
    $('#cfg-limite-up').value = configuracao.limiteUpload || 0;
    $('#volume').value = configuracao.volume ?? 100;

    const info = await api.info();
    $('#sobre').textContent =
        `Torrange ${info.versao} · Electron ${info.electron} · ${info.plataforma}` +
        `${info.empacotado ? '' : ' (desenvolvimento)'}\n` +
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
    const novo = await api.config.gravar({
        siteUrl: $('#cfg-site').value.trim() || configuracao.siteUrl,
        downloadSequencial: $('#cfg-sequencial').checked,
        renomearBotaoBaixar: $('#cfg-renomear').checked,
        videoEmJanelaSeparada: $('#cfg-janela-separada').checked,
        limiteDownload: Number($('#cfg-limite-down').value) || 0,
        limiteUpload: Number($('#cfg-limite-up').value) || 0,
    });
    configuracao = novo;
    aviso('Ajustes salvos.', 'ok');
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

    // navegacao do site
    $('#btn-voltar').addEventListener('click', () => api.site.navegar('voltar'));
    $('#btn-avancar').addEventListener('click', () => api.site.navegar('avancar'));
    $('#btn-recarregar').addEventListener('click', () => api.site.navegar('recarregar'));

    // fila
    $('#btn-magnet').addEventListener('click', async () => {
        const valor = $('#campo-magnet').value.trim();
        if (!valor.startsWith('magnet:')) {
            aviso('Cole um link magnet válido.', 'erro');
            return;
        }
        $('#campo-magnet').value = '';
        await api.fila.adicionarMagnet(valor);
    });

    // biblioteca
    $('#busca-biblioteca').addEventListener('input', (e) => {
        filtroBiblioteca = e.target.value;
        renderBiblioteca(true);
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
    $('#btn-diagnostico').addEventListener('click', coletarDiagnostico);
    $('#btn-copiar-diagnostico').addEventListener('click', async () => {
        await navigator.clipboard.writeText($('#saida-diagnostico').textContent);
        aviso('Diagnóstico copiado.', 'ok');
    });
    $('#btn-sair-site').addEventListener('click', async () => {
        await api.site.sair();
        aviso('Sessão do site encerrada.', 'ok');
        trocarAba('site');
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

    // layout das views nativas
    window.addEventListener('resize', enviarLayout);
    const observador = new ResizeObserver(enviarLayout);
    observador.observe($('#area-site'));
    observador.observe($('#area-video'));

    // eventos vindos do processo principal
    api.ao('site:navegou', (d) => {
        $('#url-site').textContent = d.titulo || d.url;
        $('#btn-voltar').disabled = !d.voltar;
        $('#btn-avancar').disabled = !d.avancar;
    });
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
    api.ao('aviso', (d) => aviso(d.texto, d.tipo));

    setInterval(salvarPosicao, 5000);
    window.addEventListener('beforeunload', salvarPosicao);
}

// ------------------------------------------------------------------ inicio

(async function iniciar() {
    ligarEventos();
    await carregarConfig();
    trocarAba('site');
    fila = (await api.fila.listar()) || [];
    biblioteca = (await api.biblioteca.listar()) || [];
    renderFila(true);
    renderBiblioteca(true);
})();
