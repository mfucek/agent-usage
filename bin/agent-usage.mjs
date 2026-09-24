#!/usr/bin/env node
// agent-usage — live Claude (Max/Pro OAuth) quota in the terminal, multi-account.
// See ../README.md. Node >= 18 (or bun).
import { main } from '../src/app.mjs';

main().catch(err => { console.error(`agent-usage: ${err.message}`); process.exit(1); });
