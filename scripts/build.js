#!/usr/bin/env node
// Assemble le userscript : en-tête + logique métier + interface.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const header = read('src/header.js').replace('{{VERSION}}', pkg.version);
const out = [header, read('src/core.js'), read('src/ui.js')].join('\n');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/rdv-paris.user.js'), out);
console.log('dist/rdv-paris.user.js (' + out.length + ' octets)');
