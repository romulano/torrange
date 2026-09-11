'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const eventos = [
    'conexao:estado',
    'fila:atualizou',
    'biblioteca:atualizou',
    'player:evento',
    'qbit:estado',
    'aviso',
];

contextBridge.exposeInMainWorld('torrange', {
    ui: {
        aba: (nome) => ipcRenderer.send('ui:aba', nome),
        layout: (retangulos) => ipcRenderer.send('ui:layout', retangulos),
        telaCheia: (ligar) => ipcRenderer.send('ui:tela-cheia', ligar),
    },
    /**
     * Conexao com o site. Repare no que NAO esta aqui: nao ha como ler o
     * token. A interface so o escreve e ve a forma mascarada -- o segredo
     * nunca chega ao renderer.
     */
    conexao: {
        estado: () => ipcRenderer.invoke('conexao:estado'),
        definirToken: (texto) => ipcRenderer.invoke('conexao:definir-token', texto),
        esquecer: () => ipcRenderer.invoke('conexao:esquecer'),
        verificar: () => ipcRenderer.invoke('conexao:verificar'),
        abrirSite: () => ipcRenderer.invoke('conexao:abrir-site'),
    },
    acervo: {
        listar: (filtros) => ipcRenderer.invoke('acervo:listar', filtros),
        titulo: (chave) => ipcRenderer.invoke('acervo:titulo', chave),
        favoritos: (pagina) => ipcRenderer.invoke('acervo:favoritos', pagina),
        baixados: (pagina) => ipcRenderer.invoke('acervo:baixados', pagina),
        favoritar: (chave, item) => ipcRenderer.invoke('acervo:favoritar', chave, item),
        baixar: (item) => ipcRenderer.invoke('acervo:baixar', item),
        confirmar: (item, preco) => ipcRenderer.invoke('acervo:confirmar', item, preco),
    },
    fila: {
        listar: () => ipcRenderer.invoke('fila:listar'),
        pausar: (hash) => ipcRenderer.invoke('fila:pausar', hash),
        retomar: (hash) => ipcRenderer.invoke('fila:retomar', hash),
        remover: (hash, apagar) => ipcRenderer.invoke('fila:remover', hash, apagar),
        adicionarMagnet: (magnet) => ipcRenderer.invoke('fila:magnet', magnet),
        adicionarUrl: (endereco) => ipcRenderer.invoke('fila:url', endereco),
        escolherArquivo: () => ipcRenderer.invoke('fila:arquivo'),
    },
    qbit: {
        estado: () => ipcRenderer.invoke('qbit:estado'),
        tentarDeNovo: () => ipcRenderer.invoke('qbit:tentar'),
        registro: () => ipcRenderer.invoke('qbit:registro'),
    },
    biblioteca: {
        listar: () => ipcRenderer.invoke('biblioteca:listar'),
        abrirPasta: (caminho) => ipcRenderer.invoke('app:abrir-pasta', caminho),

        pastas: () => ipcRenderer.invoke('biblioteca:pastas'),
        criarPasta: (dados) => ipcRenderer.invoke('biblioteca:criar-pasta', dados),
        editarPasta: (id, campos) => ipcRenderer.invoke('biblioteca:editar-pasta', id, campos),
        removerPasta: (id) => ipcRenderer.invoke('biblioteca:remover-pasta', id),

        editarTitulo: (hash, campos) => ipcRenderer.invoke('biblioteca:editar-titulo', hash, campos),
        editarArquivo: (hash, caminho, nome) =>
            ipcRenderer.invoke('biblioteca:editar-arquivo', hash, caminho, nome),

        definirCapa: (alvo, origem) => ipcRenderer.invoke('biblioteca:capa', alvo, origem),
        removerCapa: (alvo) => ipcRenderer.invoke('biblioteca:remover-capa', alvo),
    },
    player: {
        abrir: (opcoes) => ipcRenderer.invoke('player:abrir', opcoes),
        comando: (...args) => ipcRenderer.invoke('player:comando', args),
        faixas: () => ipcRenderer.invoke('player:faixas'),
        diagnostico: () => ipcRenderer.invoke('player:diagnostico'),
        fechar: () => ipcRenderer.invoke('player:fechar'),
        salvarPosicao: (dados) => ipcRenderer.send('player:posicao', dados),
    },
    config: {
        ler: () => ipcRenderer.invoke('config:ler'),
        gravar: (parcial) => ipcRenderer.invoke('config:gravar', parcial),
        escolherPasta: () => ipcRenderer.invoke('config:escolher-pasta'),
    },
    info: () => ipcRenderer.invoke('app:info'),
    diagnostico: {
        gerar: (opcoes) => ipcRenderer.invoke('app:diagnostico', opcoes || {}),
        abrirArquivo: (caminho) => ipcRenderer.invoke('app:abrir-arquivo', caminho),
        anotar: (origem, texto) => ipcRenderer.send('app:log', { origem, texto }),
    },
    ao: (canal, callback) => {
        if (!eventos.includes(canal)) throw new Error(`canal desconhecido: ${canal}`);
        const ouvinte = (_e, dados) => callback(dados);
        ipcRenderer.on(canal, ouvinte);
        return () => ipcRenderer.removeListener(canal, ouvinte);
    },
});
