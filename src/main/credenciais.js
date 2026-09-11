'use strict';
/**
 * O segredo do app: o token da conta e o identificador desta instalacao.
 *
 * O token e uma senha -- quem o tem pede acesso a conta inteira. Por isso ele
 * e gravado cifrado pelo cofre do sistema (safeStorage: Keychain no macOS,
 * DPAPI no Windows, libsecret/kwallet no Linux) e NUNCA aparece em log, em
 * URL, no arquivo de diagnostico ou em mensagem de erro. Para a tela existe
 * apenas a forma mascarada.
 *
 * O identificador da instalacao nao e segredo, mas TEM de ser estavel: ele diz
 * ao site qual aparelho esta falando. Um id novo a cada abertura gastaria as
 * tres vagas da conta em tres execucoes -- por isso ele e gravado em disco na
 * primeira vez e nunca mais muda.
 */
const { app, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** O token do site: 100 caracteres alfanumericos, nao expira (RN-095). */
const TAMANHO_TOKEN = 100;

/**
 * O identificador da instalacao.
 *
 * O pedido original falava em 100 caracteres, mas a API aceita de 8 a 64 em
 * [A-Za-z0-9._:-] e recusa o que passar disso com 400 instalacao_ausente.
 * Usamos o maximo que ela aceita; se um dia o limite subir, basta trocar aqui.
 */
const TAMANHO_INSTALACAO = 64;
const ALFABETO_INSTALACAO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const ARQUIVO_INSTALACAO = () => path.join(app.getPath('userData'), 'instalacao.json');
const ARQUIVO_TOKEN = () => path.join(app.getPath('userData'), 'token.bin');

let instalacaoCache = null;
let tokenCache = null;       // null = ainda nao lido do disco
let protegidoPeloCofre = null;

// --------------------------------------------------------------------------
// Identificador da instalacao

function sortearId() {
    const bytes = crypto.randomBytes(TAMANHO_INSTALACAO);
    let texto = '';
    for (let i = 0; i < TAMANHO_INSTALACAO; i++) {
        texto += ALFABETO_INSTALACAO[bytes[i] % ALFABETO_INSTALACAO.length];
    }
    return texto;
}

function idInstalacaoValido(texto) {
    return typeof texto === 'string' && /^[A-Za-z0-9._:-]{8,64}$/.test(texto);
}

/** O id deste aparelho. Criado na primeira chamada, estavel para sempre. */
function idInstalacao() {
    if (instalacaoCache) return instalacaoCache;

    const arquivo = ARQUIVO_INSTALACAO();
    try {
        const salvo = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
        if (idInstalacaoValido(salvo && salvo.id)) {
            instalacaoCache = salvo.id;
            return instalacaoCache;
        }
    } catch {
        /* primeira execucao, ou arquivo estragado: geramos abaixo */
    }

    instalacaoCache = sortearId();
    try {
        fs.mkdirSync(path.dirname(arquivo), { recursive: true });
        fs.writeFileSync(
            arquivo,
            JSON.stringify({ id: instalacaoCache, criadoEm: new Date().toISOString() }, null, 2),
            'utf8'
        );
    } catch (erro) {
        // Sem gravar, o id muda na proxima abertura e gasta outra vaga das
        // tres da conta -- vale gritar no log.
        console.error('nao consegui gravar o id da instalacao:', erro.message);
    }
    return instalacaoCache;
}

// --------------------------------------------------------------------------
// Token

function normalizarToken(texto) {
    // O usuario cola do site: espaco, quebra de linha e aspas vem junto.
    return String(texto == null ? '' : texto).replace(/[\s"']/g, '');
}

function tokenValido(texto) {
    const limpo = normalizarToken(texto);
    return limpo.length === TAMANHO_TOKEN && /^[A-Za-z0-9]+$/.test(limpo);
}

/** Por que este token nao serve -- em portugues, para a tela mostrar. */
function motivoDoTokenInvalido(texto) {
    const limpo = normalizarToken(texto);
    if (!limpo) return 'Cole o token que o site mostra em Aplicativos.';
    if (!/^[A-Za-z0-9]+$/.test(limpo)) {
        return 'O token tem só letras e números — parece que veio texto a mais junto.';
    }
    if (limpo.length !== TAMANHO_TOKEN) {
        return `O token tem ${TAMANHO_TOKEN} caracteres; este tem ${limpo.length}. Copie o valor inteiro.`;
    }
    return '';
}

function cofreDisponivel() {
    if (protegidoPeloCofre !== null) return protegidoPeloCofre;
    try {
        protegidoPeloCofre = safeStorage.isEncryptionAvailable();
    } catch {
        protegidoPeloCofre = false;
    }
    return protegidoPeloCofre;
}

/**
 * O arquivo guarda um cabecalho de uma linha dizendo como o resto foi gravado:
 *   cofre:<base64 cifrado>   -- protegido pelo sistema
 *   claro:<token>            -- maquina sem cofre (Linux sem chaveiro)
 * Assim uma leitura nunca confunde os dois formatos.
 */
function lerToken() {
    if (tokenCache !== null) return tokenCache;

    let bruto;
    try {
        bruto = fs.readFileSync(ARQUIVO_TOKEN(), 'utf8');
    } catch {
        tokenCache = '';
        return tokenCache;
    }

    const corte = bruto.indexOf(':');
    const formato = corte > 0 ? bruto.slice(0, corte) : '';
    const conteudo = corte > 0 ? bruto.slice(corte + 1) : '';

    if (formato === 'cofre') {
        try {
            tokenCache = safeStorage.decryptString(Buffer.from(conteudo, 'base64'));
        } catch (erro) {
            // Cofre trocado (usuario mudou de chaveiro, perfil copiado para
            // outra maquina): o token nao volta. Pedir de novo e o certo.
            console.error('nao consegui decifrar o token guardado:', erro.message);
            tokenCache = '';
        }
    } else if (formato === 'claro') {
        tokenCache = normalizarToken(conteudo);
    } else {
        tokenCache = '';
    }
    return tokenCache;
}

function gravarToken(texto) {
    const limpo = normalizarToken(texto);
    if (!tokenValido(limpo)) throw new Error(motivoDoTokenInvalido(limpo) || 'Token inválido.');

    const arquivo = ARQUIVO_TOKEN();
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });

    let conteudo;
    if (cofreDisponivel()) {
        conteudo = `cofre:${safeStorage.encryptString(limpo).toString('base64')}`;
    } else {
        conteudo = `claro:${limpo}`;
    }
    fs.writeFileSync(arquivo, conteudo, { encoding: 'utf8', mode: 0o600 });
    try {
        fs.chmodSync(arquivo, 0o600); // no Windows o mode do writeFile e ignorado
    } catch {
        /* sistema sem permissoes POSIX */
    }

    tokenCache = limpo;
    return { protegido: cofreDisponivel() };
}

function apagarToken() {
    tokenCache = '';
    try {
        fs.unlinkSync(ARQUIVO_TOKEN());
    } catch {
        /* ja nao existia */
    }
}

function temToken() {
    return !!lerToken();
}

/** 4kP9…c2Za -- o suficiente para o dono conferir que e o token certo. */
function mascarar(texto) {
    const limpo = normalizarToken(texto || lerToken());
    if (!limpo) return '';
    if (limpo.length <= 12) return `${limpo.slice(0, 2)}…${limpo.slice(-2)}`;
    return `${limpo.slice(0, 4)}…${limpo.slice(-4)}`;
}

/** O que a tela e o diagnostico podem ver. Nunca o token em si. */
function resumo() {
    const tem = temToken();
    return {
        temToken: tem,
        tokenMascarado: tem ? mascarar() : '',
        protegidoPeloCofre: tem ? cofreDisponivel() : null,
        instalacao: idInstalacao(),
    };
}

module.exports = {
    idInstalacao,
    idInstalacaoValido,
    lerToken,
    gravarToken,
    apagarToken,
    temToken,
    tokenValido,
    normalizarToken,
    motivoDoTokenInvalido,
    mascarar,
    resumo,
    cofreDisponivel,
    TAMANHO_TOKEN,
    TAMANHO_INSTALACAO,
};
