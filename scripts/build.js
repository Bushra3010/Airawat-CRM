'use strict';
// Netlify build step: copy the browser barcode scanner library into the static site.
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'public', 'vendor');
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(require.resolve('html5-qrcode/html5-qrcode.min.js'), path.join(out, 'html5-qrcode.min.js'));
console.log('Copied html5-qrcode to public/vendor');
