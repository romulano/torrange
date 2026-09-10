'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const emDesenvolvimento = !app.isPackaged;
const pastaPlataforma = process.platform === 'win32' ? 'win' : 'linux';

/** Raiz dos binarios de terceiros empacotados (qbittorrent-nox, mpv). */
function raizBinarios() {
    return emDesenvolvimento
        ? path.join(app.getAppPath(), 'resources', 'bin', pastaPlataforma)
        : path.join(process.resourcesPath, 'bin');
}

/**
 * Caminho do executavel do qbittorrent-nox.
 * TORRANGE_QBIT troca o binario embutido por outro -- serve para os testes
 * exercitarem o que acontece quando ele demora ou nao sobe.
 */
function binarioQbit() {
    if (process.env.TORRANGE_QBIT) return process.env.TORRANGE_QBIT;
    const nome = process.platform === 'win32' ? 'qbittorrent-nox.exe' : 'qbittorrent-nox';
    return path.join(raizBinarios(), 'qbittorrent', nome);
}

/**
 * Caminho do executavel do mpv.
 * No Linux usamos o AppRun da AppImage extraida (ele ajusta LD_LIBRARY_PATH).
 */
function binarioMpv() {
    return process.platform === 'win32'
        ? path.join(raizBinarios(), 'mpv', 'mpv.exe')
        : path.join(raizBinarios(), 'mpv', 'AppRun');
}

/** Pasta de dados do app (perfil do qBittorrent, biblioteca, config). */
function pastaDados(...partes) {
    const p = path.join(app.getPath('userData'), ...partes);
    fs.mkdirSync(path.dirname(p) === p ? p : path.dirname(p), { recursive: true });
    return p;
}

function garantirPasta(p) {
    fs.mkdirSync(p, { recursive: true });
    return p;
}

module.exports = {
    emDesenvolvimento,
    raizBinarios,
    binarioQbit,
    binarioMpv,
    pastaDados,
    garantirPasta,
};
