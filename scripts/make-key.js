#!/usr/bin/env node
'use strict';

// Prints a key in the house style. With no arguments it makes a four-part
// owner key; `--visitor` makes a three-part one like your visitors get.
//
//   npm run key
//   node scripts/make-key.js --visitor

const crypto = require('node:crypto');
const { NOUNS, ACTIONS } = require('../server/words');

const pick = (list) => list[crypto.randomInt(list.length)];
const visitor = process.argv.includes('--visitor');

const parts = [pick(NOUNS), pick(ACTIONS)];
if (!visitor) parts.push(pick(ACTIONS));
parts.push(String(crypto.randomInt(100, 1000)));

process.stdout.write(`${parts.join('-')}\n`);
