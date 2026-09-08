#!/usr/bin/env node
import { manage } from '../src/manage.js';
try { console.log(await manage(process.cwd(), process.argv.slice(2).join(' '))); }
catch (e) { console.error(e.message); process.exitCode = 1; }
