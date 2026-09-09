#!/usr/bin/env node
'use strict';
/**
 * Sobe o app em modo de desenvolvimento.
 *
 * Existe por um motivo especifico: terminais embutidos em editores baseados em
 * Electron (VS Code, por exemplo) exportam ELECTRON_RUN_AS_NODE=1, e nesse modo
 * o Electron roda como Node puro -- `require('electron').app` vira undefined e o
 * app quebra na primeira linha. Aqui a variavel e removida antes de subir.
 */
const { spawn } = require('child_process');
const electron = require('electron');

const ambiente = Object.assign({}, process.env);
delete ambiente.ELECTRON_RUN_AS_NODE;

const filho = spawn(electron, ['.', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: ambiente,
});

filho.on('exit', (codigo, sinal) => process.exit(sinal ? 1 : codigo ?? 0));
