const fs = require('fs');
const file = 'index.js';
let content = fs.readFileSync(file, 'utf8');
content = content.replace(/const browser = await puppeteer\\.launch\\(\\{[\\s\\S]*?\\}\\);/, 'const browser = await launchPuppeteer();');
content = content.replace(/browser = await puppeteer\\.launch\\(\\{[\\s\\S]*?\\}\\);/, 'browser = await launchPuppeteer();');
fs.writeFileSync(file, content, 'utf8');
