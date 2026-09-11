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
        // Endereco do site, usado para abrir a pagina de aplicativos no
        // navegador do sistema (e onde o dono copia o token e autoriza).
        siteUrl: 'https://torrange.com/',
        // Base da API do aplicativo. Todo o acervo passa por aqui.
        apiUrl: 'https://torrange.com/api/aplicativo',
        // Nome que o dono le no site ao lado do botao Permitir. Vazio = o app
        // monta um a partir do nome da maquina.
        nomeDoAparelho: '',
        pastaDownloads: path.join(videos, 'Torrange'),
        // Sequencial + primeira/ultima peca liberam o play antes do fim do download.
        downloadSequencial: true,
        // Plano B quando o video acoplado nao aparece (tela preta): o mpv abre
        // numa janela propria, ainda controlada pela interface.
        videoEmJanelaSeparada: false,
        limiteDownload: 0, // KiB/s, 0 = sem limite
        limiteUpload: 0,
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
