'use strict';
/** Utilidades compartilhadas pelos testes: dirigir o app pelo DevTools Protocol. */
const { execSync } = require('child_process');
const http = require('http');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function pegarJson(porta, caminho) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: porta, path: caminho }, (res) => {
            const p = [];
            res.on('data', (d) => p.push(d));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(p).toString()));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

class Alvo {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pendentes = new Map();
        this.ouvintes = new Map();
        ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.method) {
                for (const cb of this.ouvintes.get(msg.method) || []) cb(msg.params);
                return;
            }
            const p = this.pendentes.get(msg.id);
            if (!p) return;
            this.pendentes.delete(msg.id);
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        });
    }

    static async conectar(url) {
        const ws = new WebSocket(url);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', reject, { once: true });
        });
        return new Alvo(ws);
    }

    enviar(metodo, params = {}) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pendentes.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method: metodo, params }));
            setTimeout(() => {
                if (this.pendentes.delete(id)) reject(new Error(`timeout em ${metodo}`));
            }, 30000);
        });
    }

    /** Escuta um evento do CDP (ex.: Runtime.exceptionThrown). */
    ao(metodo, callback) {
        if (!this.ouvintes.has(metodo)) this.ouvintes.set(metodo, []);
        this.ouvintes.get(metodo).push(callback);
    }

    /** Coleta erros de console e excecoes nao tratadas da pagina. */
    vigiarErros(rotulo, destino) {
        this.ao('Runtime.exceptionThrown', (p) => {
            const d = p.exceptionDetails || {};
            destino.push(`${rotulo}: ${d.exception?.description || d.text || 'excecao'}`);
        });
        this.ao('Runtime.consoleAPICalled', (p) => {
            if (p.type !== 'error') return;
            const texto = (p.args || []).map((a) => a.description || a.value).join(' ');
            destino.push(`${rotulo}: ${texto}`);
        });
    }

    async avaliar(expressao) {
        const r = await this.enviar('Runtime.evaluate', {
            expression: expressao,
            awaitPromise: true,
            returnByValue: true,
        });
        if (r.exceptionDetails) {
            throw new Error(r.exceptionDetails.exception?.description || 'erro na avaliacao');
        }
        return r.result.value;
    }

    fechar() {
        try {
            this.ws.close();
        } catch {
            /* ja fechou */
        }
    }
}

async function acharAlvo(porta, filtro, tentativas = 80) {
    for (let i = 0; i < tentativas; i++) {
        try {
            const alvo = (await pegarJson(porta, '/json/list')).find(filtro);
            if (alvo) return alvo;
        } catch {
            /* o CDP ainda esta subindo */
        }
        await espera(500);
    }
    return null;
}

/**
 * Encerra o app de verdade.
 *
 * No Linux o app se relanca com --ozone-platform=x11, entao o processo que o
 * teste criou ja morreu e matar o handle dele nao adianta: quem esta rodando e
 * um "neto". O jeito limpo e pedir um Browser.close pelo proprio CDP; o pkill
 * abaixo e so rede de seguranca (o padrao usa colchetes para nao casar com a
 * propria linha de comando do shell que o executa).
 */
async function encerrarApp(porta, processo) {
    try {
        const versao = await pegarJson(porta, '/json/version');
        if (versao.webSocketDebuggerUrl) {
            const navegador = await Alvo.conectar(versao.webSocketDebuggerUrl);
            await navegador.enviar('Browser.close').catch(() => {});
            navegador.fechar();
        }
    } catch {
        /* CDP ja caiu */
    }

    if (processo) {
        try {
            processo.kill();
        } catch {
            /* ja morreu */
        }
    }

    await espera(1500);

    const varrer = (padrao) => {
        try {
            execSync(`pkill -f '${padrao}' 2>/dev/null || true`);
        } catch {
            /* nada rodando */
        }
    };
    varrer(`${RAIZ}/node_modules/electron/dist/electro[n]`);
    varrer('qbittorrent[-]nox --profile');
    await espera(500);
}

module.exports = { Alvo, acharAlvo, pegarJson, encerrarApp, espera, RAIZ };
