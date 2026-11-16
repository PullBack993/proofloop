#!/usr/bin/env node
// Entry point. node:sqlite is still flagged experimental in Node 22; hide only that warning so
// hook output stays clean, then load the commands.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});
await import('./main.js');
