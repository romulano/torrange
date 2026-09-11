'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ARQUIVO = () => path.join(app.getPath('userData'), 'config.json');

function padroes() {
    let videos;
    try {
        videos = app.getPath('videos');
    } catch {
        videos = app.getPath('home');
    }
    return {
        siteUrl: 'https://torrange.com/',
        pastaDownloads: path.join(videos, 'Torrange'),
        // Sequencial + primeira/ultima peca liberam o play antes do fim do download.
        downloadSequencial: true,
        // Plano B quando o video acoplado nao aparece (tela preta): o mpv abre
        // numa janela propria, ainda controlada pela interface.
        videoEmJanelaSeparada: false,
        limiteDownload: 0, // KiB/s, 0 = sem limite
        limiteUpload: 0,
        renomearBotaoBaixar: true,
        volume: 100,
        // Credenciais da WebUI do qBittorrent embutido. Vazias = o app gera uma
        // senha nova a cada execucao, que nunca sai da maquina. Preenchidas,
        // valem tanto para o qBittorrent embutido quanto para entrar na WebUI
        // dele pelo navegador.
        qbitUsuario: '',
        qbitSenha: '',
    };
}

let cache = null;

function ler() {
    if (cache) return cache;
    let salvo = {};
    try {
        salvo = JSON.parse(fs.readFileSync(ARQUIVO(), 'utf8'));
    } catch {
        salvo = {};
    }
    cache = Object.assign(padroes(), salvo);
    return cache;
}

function gravar(parcial) {
    cache = Object.assign(ler(), parcial || {});
    fs.mkdirSync(path.dirname(ARQUIVO()), { recursive: true });
    fs.writeFileSync(ARQUIVO(), JSON.stringify(cache, null, 2), 'utf8');
    return cache;
}

module.exports = { ler, gravar, padroes };
