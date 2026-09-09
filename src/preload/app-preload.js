'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const eventos = [
    'site:navegou',
    'fila:atualizou',
    'biblioteca:atualizou',
    'player:evento',
    'aviso',
];

contextBridge.exposeInMainWorld('torrange', {
    ui: {
        aba: (nome) => ipcRenderer.send('ui:aba', nome),
        layout: (retangulos) => ipcRenderer.send('ui:layout', retangulos),
        telaCheia: (ligar) => ipcRenderer.send('ui:tela-cheia', ligar),
    },
    site: {
        navegar: (acao, url) => ipcRenderer.send('site:navegar', acao, url),
        sair: () => ipcRenderer.invoke('site:sair'),
    },
    fila: {
        listar: () => ipcRenderer.invoke('fila:listar'),
        pausar: (hash) => ipcRenderer.invoke('fila:pausar', hash),
        retomar: (hash) => ipcRenderer.invoke('fila:retomar', hash),
        remover: (hash, apagar) => ipcRenderer.invoke('fila:remover', hash, apagar),
        adicionarMagnet: (magnet) => ipcRenderer.invoke('fila:magnet', magnet),
    },
    biblioteca: {
        listar: () => ipcRenderer.invoke('biblioteca:listar'),
        abrirPasta: (caminho) => ipcRenderer.invoke('app:abrir-pasta', caminho),
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
    ao: (canal, callback) => {
        if (!eventos.includes(canal)) throw new Error(`canal desconhecido: ${canal}`);
        const ouvinte = (_e, dados) => callback(dados);
        ipcRenderer.on(canal, ouvinte);
        return () => ipcRenderer.removeListener(canal, ouvinte);
    },
});
