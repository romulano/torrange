'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const emDesenvolvimento = !app.isPackaged;

/** win | mac | linux -- o nome da pasta de binarios de cada plataforma. */
const pastaPlataforma =
    process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';

/** Raiz dos binarios de terceiros empacotados (qbittorrent-nox, mpv). */
function raizBinarios() {
    return emDesenvolvimento
        ? path.join(app.getAppPath(), 'resources', 'bin', pastaPlataforma)
        : path.join(process.resourcesPath, 'bin');
}

/**
 * Onde procurar um binario que o pacote nao trouxe.
 *
 * No Windows e no Linux tudo vai empacotado e esta lista fica vazia. No macOS
 * nao existe build pronto de qbittorrent-nox, e o mpv que circula e antigo:
 * la o app aceita o que estiver instalado no sistema (Homebrew, MacPorts,
 * Nix) em vez de simplesmente nao funcionar.
 */
const PASTAS_DO_SISTEMA =
    process.platform === 'darwin'
        ? [
              '/opt/homebrew/bin', // Homebrew em Apple Silicon
              '/usr/local/bin', // Homebrew em Intel
              '/opt/local/bin', // MacPorts
              path.join(process.env.HOME || '', '.nix-profile', 'bin'), // Nix
              '/run/current-system/sw/bin',
          ]
        : [];

/** Primeiro caminho que existe; se nenhum existir, devolve o preferido. */
function primeiroQueExiste(caminhos, preferido) {
    for (const caminho of caminhos) {
        if (!caminho) continue;
        try {
            if (fs.existsSync(caminho)) return caminho;
        } catch {
            /* caminho inacessivel: tenta o proximo */
        }
    }
    return preferido;
}

function noSistema(nome) {
    return PASTAS_DO_SISTEMA.map((pasta) => path.join(pasta, nome));
}

/**
 * Caminho do executavel do qbittorrent-nox.
 * TORRANGE_QBIT troca o binario embutido por outro -- serve para os testes
 * exercitarem o que acontece quando ele demora ou nao sobe.
 */
function binarioQbit() {
    if (process.env.TORRANGE_QBIT) return process.env.TORRANGE_QBIT;
    const nome = process.platform === 'win32' ? 'qbittorrent-nox.exe' : 'qbittorrent-nox';
    const empacotado = path.join(raizBinarios(), 'qbittorrent', nome);
    return primeiroQueExiste([empacotado, ...noSistema(nome)], empacotado);
}

/**
 * Caminho do executavel do mpv.
 *  - Windows: mpv.exe
 *  - Linux:   AppRun da AppImage extraida (ele ajusta o LD_LIBRARY_PATH)
 *  - macOS:   o binario de dentro do mpv.app empacotado, ou o do sistema
 */
function binarioMpv() {
    if (process.env.TORRANGE_MPV) return process.env.TORRANGE_MPV;
    const raiz = raizBinarios();
    if (process.platform === 'win32') return path.join(raiz, 'mpv', 'mpv.exe');
    if (process.platform === 'darwin') {
        return primeiroQueExiste(
            [
                path.join(raiz, 'mpv', 'mpv.app', 'Contents', 'MacOS', 'mpv'),
                path.join(raiz, 'mpv', 'mpv'),
                '/Applications/mpv.app/Contents/MacOS/mpv',
                ...noSistema('mpv'),
            ],
            path.join(raiz, 'mpv', 'mpv.app', 'Contents', 'MacOS', 'mpv')
        );
    }
    return path.join(raiz, 'mpv', 'AppRun');
}

/**
 * Texto de ajuda para quando um binario nao aparece. No macOS a instrucao e
 * diferente das outras plataformas justamente porque nada vem empacotado.
 */
function comoInstalar(qual) {
    if (process.platform !== 'darwin') {
        return 'Rode "npm run binaries" antes, ou reinstale o aplicativo.';
    }
    return qual === 'mpv'
        ? 'No macOS o player vem do sistema: instale com "brew install mpv".'
        : 'No macOS o qBittorrent vem do sistema: instale o qbittorrent-nox ' +
              '(MacPorts: "sudo port install qbittorrent-nox"; Nix: ' +
              '"nix profile install nixpkgs#qbittorrent-nox") ou coloque o ' +
              'binário em resources/bin/mac/qbittorrent/.';
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
    pastaPlataforma,
    raizBinarios,
    binarioQbit,
    binarioMpv,
    comoInstalar,
    pastaDados,
    garantirPasta,
};
