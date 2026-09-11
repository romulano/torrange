'use strict';
/**
 * O estado da conversa com o site: do token colado ate o aparelho autorizado.
 *
 * A sequencia e a da especificacao, e cada passo depende do anterior:
 *
 *   sem-token   o usuario ainda nao colou nada        -> tela do token
 *   conectando  apresentando o aparelho (/conexao)
 *   pendente    a vaga existe e espera o dono clicar  -> tela de espera
 *   aprovado    todas as rotas respondem
 *   erro        token trocado, assinatura vencida, sem vaga, sem rede...
 *
 * Duas coisas valem repetir, porque sao justamente onde e facil errar:
 *
 *  1. "aguardando_aprovacao" e ESTADO, nao erro. Uma tela dizendo "abra o site
 *     e permita este aparelho" resolve; uma mensagem de falha manda o usuario
 *     reinstalar a toa.
 *  2. Nao se repete /conexao em laco. A vaga ja esta guardada e o teto e de 10
 *     chamadas por minuto -- quem espera e o GET /conta, que custa pouco.
 */
const os = require('os');

const api = require('./api');
const credenciais = require('./credenciais');

/** De quanto em quanto tempo perguntamos se a autorizacao saiu (limite: 60/min). */
const INTERVALO_ESPERA = 5000;
/** Sem rede, espacamos mais: nao adianta martelar um servidor que nao responde. */
const INTERVALO_SEM_REDE = 15000;
/** Piso entre dois POST /conexao (limite: 10/min). */
const INTERVALO_CONEXAO = 30000;

const PLATAFORMAS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

let estado = {
    fase: 'sem-token',
    erro: '',
    mensagem: '',
    conta: null,
    gemas: null,
    aplicativo: null,
    verificadoEm: null,
};
let aoMudar = () => {};
let relogio = null;
let ultimaConexao = 0;
let ocupado = false;

// --------------------------------------------------------------------------
// Estado

function publicar(parcial) {
    estado = Object.assign({}, estado, parcial, credenciais.resumo());
    aoMudar(atual());
}

function atual() {
    return Object.assign({}, estado, {
        pronto: estado.fase === 'aprovado',
        paginaAplicativos: paginaAplicativos(),
    });
}

let urlDoSite = 'https://torrange.com/';

function paginaAplicativos() {
    try {
        return new URL('/aplicativos', urlDoSite).href;
    } catch {
        return 'https://torrange.com/aplicativos';
    }
}

/** Nome que o dono le ao lado do botao Permitir. 2 a 80 caracteres. */
function nomeDoAparelho(config) {
    const escolhido = String((config && config.nomeDoAparelho) || '').trim();
    if (escolhido.length >= 2) return escolhido.slice(0, 80);
    const maquina = String(os.hostname() || '').split('.')[0].trim();
    const base = maquina.length >= 2 ? `Torrange · ${maquina}` : 'Torrange Desktop';
    return base.slice(0, 80);
}

function plataforma() {
    const nome = PLATAFORMAS[process.platform] || process.platform;
    return `${nome} ${os.release()}`.slice(0, 40);
}

// --------------------------------------------------------------------------
// Traducao das recusas

/**
 * O que cada codigo de erro significa para o app. `fase` diz para onde a tela
 * vai; `refazerConexao` marca os casos em que a vaga precisa ser pedida de novo.
 */
const RECUSAS = {
    token_ausente: { fase: 'sem-token', texto: 'Nenhum token cadastrado neste aplicativo.' },
    token_invalido: {
        fase: 'sem-token',
        texto: 'Este token não vale mais — em geral porque um novo foi gerado no site. Cole o token atual.',
    },
    conta_inativa: {
        fase: 'erro',
        texto: 'Esta conta foi removida. Não adianta tentar de novo: fale com o site.',
    },
    assinatura_inativa: {
        fase: 'erro',
        texto: 'A assinatura não está em dia. Resolva no site e volte aqui.',
    },
    instalacao_ausente: {
        fase: 'erro',
        texto: 'O identificador deste aparelho foi recusado. Gere um novo em Ajustes.',
    },
    nao_conectado: {
        fase: 'conectando',
        texto: 'Este aparelho não tem vaga na conta. Apresentando de novo…',
        refazerConexao: true,
    },
    aguardando_aprovacao: {
        fase: 'pendente',
        texto: 'Este aplicativo ainda não foi autorizado. Abra o site e permita o acesso.',
    },
    sem_vaga: {
        fase: 'erro',
        texto: 'Esta conta já tem três aplicativos. Remova um no site para abrir vaga.',
    },
    muitas_chamadas: { fase: 'pendente', texto: 'Muitas chamadas seguidas. Esperando um pouco…' },
    sem_rede: { fase: 'pendente', texto: 'Sem resposta do site. Tentando de novo…' },
};

function traduzir(erro) {
    const codigo = (erro && erro.erro) || '';
    const conhecido = RECUSAS[codigo];
    if (conhecido) return { codigo, ...conhecido };
    return {
        codigo: codigo || 'falha',
        fase: 'erro',
        texto: (erro && erro.message) || 'Não consegui falar com o site.',
    };
}

// --------------------------------------------------------------------------
// Passos

/** Apresenta o aparelho. Respeita o piso entre duas chamadas. */
async function apresentar(config, { forcar = false } = {}) {
    const agora = Date.now();
    if (!forcar && agora - ultimaConexao < INTERVALO_CONEXAO) return null;
    ultimaConexao = agora;

    return api.conexao({ nome: nomeDoAparelho(config), plataforma: plataforma() });
}

/**
 * Uma volta completa: apresenta (se preciso) e confere a conta.
 * Devolve a fase em que parou.
 */
async function verificar(config, { apresentando = false } = {}) {
    if (ocupado) return estado.fase;
    ocupado = true;
    try {
        if (!credenciais.temToken()) {
            publicar({ fase: 'sem-token', erro: '', mensagem: '', conta: null, gemas: null });
            return 'sem-token';
        }

        if (apresentando) {
            publicar({ fase: 'conectando', erro: '', mensagem: 'Apresentando este aparelho ao site…' });
            const r = await apresentar(config, { forcar: true });
            if (r && r.estado === 'pendente') {
                publicar({
                    fase: 'pendente',
                    erro: 'aguardando_aprovacao',
                    mensagem: r.mensagem || RECUSAS.aguardando_aprovacao.texto,
                    aplicativo: r.aplicativo || null,
                    vagasLivres: typeof r.vagas_livres === 'number' ? r.vagas_livres : null,
                });
                return 'pendente';
            }
        }

        const dados = await api.conta();
        publicar({
            fase: 'aprovado',
            erro: '',
            mensagem: '',
            conta: dados.conta || null,
            gemas: dados.gemas || null,
            aplicativo: dados.aplicativo || null,
            verificadoEm: new Date().toISOString(),
        });
        return 'aprovado';
    } catch (erro) {
        return await tratarFalha(erro, config);
    } finally {
        ocupado = false;
    }
}

async function tratarFalha(erro, config) {
    const t = traduzir(erro);

    // "Este aparelho nunca se apresentou" tem conserto sozinho: pede a vaga.
    if (t.refazerConexao) {
        try {
            const r = await apresentar(config);
            if (r) {
                const pendente = r.estado !== 'aprovado';
                publicar({
                    fase: pendente ? 'pendente' : 'aprovado',
                    erro: pendente ? 'aguardando_aprovacao' : '',
                    mensagem: pendente ? r.mensagem || RECUSAS.aguardando_aprovacao.texto : '',
                    aplicativo: r.aplicativo || null,
                });
                return pendente ? 'pendente' : 'aprovado';
            }
        } catch (outro) {
            return await tratarFalha(outro, config);
        }
    }

    if (t.fase === 'sem-token' && t.codigo === 'token_invalido') {
        // O token morreu: guardar um token morto so faz o app falhar em silencio.
        credenciais.apagarToken();
    }

    publicar({ fase: t.fase, erro: t.codigo, mensagem: t.texto });
    return t.fase;
}

// --------------------------------------------------------------------------
// Laco de espera

function pararEspera() {
    clearTimeout(relogio);
    relogio = null;
}

/**
 * Enquanto a autorizacao nao sai, perguntamos de tempos em tempos.
 * Um setTimeout encadeado (e nao setInterval) garante que duas voltas nunca
 * se atropelem quando o servidor demora.
 */
function agendarEspera(config) {
    pararEspera();
    if (estado.fase !== 'pendente' && estado.fase !== 'conectando') return;

    const intervalo = estado.erro === 'sem_rede' ? INTERVALO_SEM_REDE : INTERVALO_ESPERA;
    relogio = setTimeout(async () => {
        await verificar(config);
        agendarEspera(config);
    }, intervalo);
}

// --------------------------------------------------------------------------
// Fachada

function configurar({ config, aoEstado }) {
    aoMudar = aoEstado || (() => {});
    urlDoSite = (config && config.siteUrl) || urlDoSite;
    api.configurar(config && config.apiUrl);
}

/** Chamada na subida do app. */
async function iniciar(config) {
    urlDoSite = config.siteUrl || urlDoSite;
    api.configurar(config.apiUrl);

    if (!credenciais.temToken()) {
        publicar({ fase: 'sem-token', erro: '', mensagem: '' });
        return atual();
    }
    await verificar(config, { apresentando: true });
    agendarEspera(config);
    return atual();
}

/** O usuario colou um token novo. */
async function definirToken(texto, config) {
    const motivo = credenciais.motivoDoTokenInvalido(texto);
    if (motivo) return { ok: false, mensagem: motivo };

    pararEspera();
    credenciais.gravarToken(texto);
    ultimaConexao = 0; // token novo: a apresentacao vale de novo na hora
    await verificar(config, { apresentando: true });
    agendarEspera(config);
    return { ok: true, estado: atual() };
}

function esquecerToken() {
    pararEspera();
    credenciais.apagarToken();
    publicar({
        fase: 'sem-token',
        erro: '',
        mensagem: '',
        conta: null,
        gemas: null,
        aplicativo: null,
    });
    return atual();
}

/** Botao "verificar agora" da tela de espera. */
async function reverificar(config) {
    pararEspera();
    await verificar(config, { apresentando: estado.fase === 'sem-token' || estado.erro === 'nao_conectado' });
    agendarEspera(config);
    return atual();
}

/**
 * Uma chamada qualquer do app tropecou numa recusa de autorizacao: o estado
 * tem de acompanhar, senao a tela continua dizendo "aprovado" enquanto nada
 * responde.
 */
async function registrarFalha(erro, config) {
    const codigo = (erro && erro.erro) || '';
    if (!['token_invalido', 'conta_inativa', 'assinatura_inativa', 'nao_conectado', 'aguardando_aprovacao', 'sem_vaga'].includes(codigo)) {
        return;
    }
    await tratarFalha(erro, config);
    agendarEspera(config);
}

/** Atualiza o saldo de gemas e os dados da conta, sem mexer na fase. */
async function atualizarConta(config) {
    if (estado.fase !== 'aprovado') return atual();
    try {
        const dados = await api.conta();
        publicar({
            conta: dados.conta || null,
            gemas: dados.gemas || null,
            aplicativo: dados.aplicativo || null,
            verificadoEm: new Date().toISOString(),
        });
    } catch (erro) {
        await registrarFalha(erro, config);
    }
    return atual();
}

function encerrar() {
    pararEspera();
}

module.exports = {
    configurar,
    iniciar,
    definirToken,
    esquecerToken,
    reverificar,
    registrarFalha,
    atualizarConta,
    encerrar,
    estado: atual,
    nomeDoAparelho,
    paginaAplicativos,
};
