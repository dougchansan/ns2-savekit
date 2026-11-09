'use strict';
const fs = require('node:fs');
const path = require('node:path');
function discoverRuns({repo, cwd = process.cwd(), home = process.env.HOME || '', override = process.env.NS2_RUNS} = {}) {
  const bases = [override, path.join(home, 'ns2jb-rpc/runs'), path.join(home, 'ns2jb/runs')];
  for (const start of [cwd, repo]) {
    for (let dir = path.resolve(start);;) {
      bases.push(path.join(dir, 'runs'), path.join(dir, 'ns2jb/runs'), path.join(dir, 'ns2jb-rpc/runs'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const found = new Map();
  function inspect(dir) {
    try {
      const acquisition = path.join(dir, 'switch2/current-acquisition.json');
      const proof = path.join(dir, 'switch2/ro/root/current-root.json');
      const connection = path.join(dir, 'connection.json');
      const connect = path.join(dir, 'connect.txt');
      if (![acquisition, proof, connection, connect].some(f => fs.existsSync(f))) return;
      const promoted = fs.existsSync(proof);
      const state = promoted ? 'root-ready' : fs.existsSync(connection) ? 'initializing' :
        fs.existsSync(acquisition) ? 'root-not-ready' : 'waiting-for-console';
      const stamp = [acquisition, proof, connection, connect].filter(f => fs.existsSync(f));
      found.set(fs.realpathSync(dir), {dir: fs.realpathSync(dir), promoted, state,
        when: Math.max(...stamp.map(f => fs.statSync(f).mtimeMs))});
    } catch { /* inaccessible or concurrently removed run */ }
  }
  for (const base of new Set(bases.filter(Boolean))) {
    inspect(base); // NS2_RUNS can also name a particular run.
    try { for (const entry of fs.readdirSync(base, {withFileTypes: true})) {
      if (entry.isDirectory() || entry.isSymbolicLink()) inspect(path.join(base, entry.name));
    } } catch { /* optional search root */ }
  }
  return [...found.values()].sort((a, b) => b.when - a.when);
}
module.exports = {discoverRuns};
