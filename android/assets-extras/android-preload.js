'use strict';
/*
 * A metade de cima da ponte.
 *
 * No desktop este arquivo era o `src/preload/app-preload.js`, e expunha
 * `window.torrange` com o contextBridge do Electron. Aqui ele monta o MESMO
 * objeto, com os mesmos nomes de metodo e os mesmos canais, em cima do objeto
 * `TorrangePonte` que a Activity injeta na WebView.
 *
 * Manter o formato identico e o que permite `app.js` -- a interface inteira do
 * desktop, 2.243 linhas -- rodar aqui sem uma linha alterada.
 *
 * Repare no que NAO esta aqui, como no desktop: nao ha como LER o token. A
 * interface so o escreve e ve a forma mascarada.
 */
(function () {
    const pendentes = new Map();
    let proximoId = 1;

    /** Uma chamada que espera resposta (o `ipcRenderer.invoke` do desktop). */
    function chamar(canal, ...argumentos) {
        return new Promise((resolve, reject) => {
            const id = proximoId++;
            pendentes.set(id, { resolve, reject });
            try {
                TorrangePonte.chamar(id, canal, JSON.stringify(argumentos));
            } catch (erro) {
                pendentes.delete(id);
                reject(erro);
            }
        });
    }

    /** Um recado sem resposta (o `ipcRenderer.send` do desktop). */
    function enviar(canal, ...argumentos) {
        try {
            TorrangePonte.enviar(canal, JSON.stringify(argumentos));
        } catch (erro) {
            /* a tela pode ter sido destruida no meio */
        }
    }

    // O Kotlin devolve por aqui. `valor` ja vem como JSON literal.
    window.__torrangeResposta = function (id, ok, valor) {
        const pendente = pendentes.get(id);
        if (!pendente) return;
        pendentes.delete(id);
        if (ok) pendente.resolve(valor);
        else pendente.reject(new Error(typeof valor === 'string' ? valor : 'falha na chamada'));
    };

    // ----------------------------------------------------------------- eventos

    const CANAIS = [
        'conexao:estado',
        'fila:atualizou',
        'biblioteca:atualizou',
        'player:evento',
        'qbit:estado',
        'aviso',
    ];
    const ouvintes = new Map(CANAIS.map((c) => [c, new Set()]));

    window.__torrangeEvento = function (canal, dados) {
        const conjunto = ouvintes.get(canal);
        if (!conjunto) return;
        for (const callback of conjunto) {
            try {
                callback(dados);
            } catch (erro) {
                enviar('app:log', { origem: 'interface', texto: `ouvinte de ${canal}: ${erro.message}` });
            }
        }
    };

    // --------------------------------------------------------------- a fachada

    window.torrange = {
        ui: {
            aba: (nome) => enviar('ui:aba', nome),
            layout: (retangulos) => enviar('ui:layout', retangulos),
            telaCheia: (ligar) => enviar('ui:tela-cheia', ligar),
        },
        conexao: {
            estado: () => chamar('conexao:estado'),
            definirToken: (texto) => chamar('conexao:definir-token', texto),
            esquecer: () => chamar('conexao:esquecer'),
            verificar: () => chamar('conexao:verificar'),
            abrirSite: () => chamar('conexao:abrir-site'),
        },
        acervo: {
            listar: (filtros) => chamar('acervo:listar', filtros),
            titulo: (chave) => chamar('acervo:titulo', chave),
            favoritos: (pagina) => chamar('acervo:favoritos', pagina),
            baixados: (pagina) => chamar('acervo:baixados', pagina),
            favoritar: (chave, item) => chamar('acervo:favoritar', chave, item),
            baixar: (item) => chamar('acervo:baixar', item),
            confirmar: (item, preco) => chamar('acervo:confirmar', item, preco),
        },
        fila: {
            listar: () => chamar('fila:listar'),
            pausar: (hash) => chamar('fila:pausar', hash),
            retomar: (hash) => chamar('fila:retomar', hash),
            remover: (hash, apagar) => chamar('fila:remover', hash, apagar),
            adicionarMagnet: (magnet) => chamar('fila:magnet', magnet),
            adicionarUrl: (endereco) => chamar('fila:url', endereco),
            escolherArquivo: () => chamar('fila:arquivo'),
        },
        qbit: {
            estado: () => chamar('qbit:estado'),
            tentarDeNovo: () => chamar('qbit:tentar'),
            registro: () => chamar('qbit:registro'),
        },
        biblioteca: {
            listar: () => chamar('biblioteca:listar'),
            abrirPasta: (caminho) => chamar('app:abrir-pasta', caminho),

            pastas: () => chamar('biblioteca:pastas'),
            criarPasta: (dados) => chamar('biblioteca:criar-pasta', dados),
            editarPasta: (id, campos) => chamar('biblioteca:editar-pasta', id, campos),
            removerPasta: (id) => chamar('biblioteca:remover-pasta', id),

            editarTitulo: (hash, campos) => chamar('biblioteca:editar-titulo', hash, campos),
            editarArquivo: (hash, caminho, nome) =>
                chamar('biblioteca:editar-arquivo', hash, caminho, nome),

            definirCapa: (alvo, origem) => chamar('biblioteca:capa', alvo, origem),
            removerCapa: (alvo) => chamar('biblioteca:remover-capa', alvo),
        },
        player: {
            abrir: (opcoes) => chamar('player:abrir', opcoes),
            // Os argumentos do mpv viajam num array so, como no desktop.
            comando: (...args) => chamar('player:comando', args),
            faixas: () => chamar('player:faixas'),
            diagnostico: () => chamar('player:diagnostico'),
            fechar: () => chamar('player:fechar'),
            salvarPosicao: (dados) => enviar('player:posicao', dados),
        },
        config: {
            ler: () => chamar('config:ler'),
            gravar: (parcial) => chamar('config:gravar', parcial),
            escolherPasta: () => chamar('config:escolher-pasta'),
        },
        info: () => chamar('app:info'),
        diagnostico: {
            gerar: (opcoes) => chamar('app:diagnostico', opcoes || {}),
            abrirArquivo: (caminho) => chamar('app:abrir-arquivo', caminho),
            anotar: (origem, texto) => enviar('app:log', { origem, texto }),
        },
        ao: (canal, callback) => {
            const conjunto = ouvintes.get(canal);
            if (!conjunto) throw new Error(`canal desconhecido: ${canal}`);
            conjunto.add(callback);
            return () => conjunto.delete(callback);
        },
    };
})();
