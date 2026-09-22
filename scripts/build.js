'use strict';
/* Sanity build: validates every JS file parses and the frontend entry exists.
 * (No transpilation needed — plain Node + vanilla JS, so "build" = verify.) */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const files = [];
for (const dir of ['server', 'server/notify', 'public/js', 'scripts']) {
  for (const f of fs.readdirSync(path.join(root, dir))) {
    if (f.endsWith('.js')) files.push(path.join(root, dir, f));
  }
}
let failed = 0;
for (const f of files) {
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); }
  catch (e) { failed++; console.error(`✗ ${path.relative(root, f)}\n${e.stderr}`); }
}
if (!fs.existsSync(path.join(root, 'public/index.html'))) { failed++; console.error('✗ public/index.html missing'); }
if (failed) { console.error(`Build failed: ${failed} problem(s)`); process.exit(1); }
console.log(`✓ Build OK — ${files.length} JS files validated, frontend entry present.`);
