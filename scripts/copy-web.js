// Copies the phone version into www/ for the native apps (Capacitor).
// mobile.html becomes www/index.html, so the app opens straight into the touch version.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'www');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const files = ['handheld.js', 'three.min.js', 'mobile.css', 'ui-mobile.js', 'manifest.webmanifest'];
for (const f of files) fs.copyFileSync(path.join(root, f), path.join(out, f));
fs.copyFileSync(path.join(root, 'mobile.html'), path.join(out, 'index.html'));
fs.cpSync(path.join(root, 'game'), path.join(out, 'game'), { recursive: true });
fs.cpSync(path.join(root, 'icons'), path.join(out, 'icons'), { recursive: true });

console.log('www/ ready (phone version). Next: npx cap sync');
