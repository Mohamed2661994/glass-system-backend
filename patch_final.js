const fs = require('fs');
const file = 'index.js';
let content = fs.readFileSync(file, 'utf8');

const t1 = '    const browser = await puppeteer.launch({';
const t2 = '    });';

let idx = content.indexOf('    const browser = await puppeteer.launch({', 5300);
if(idx !== -1) {
    let endIdx = content.indexOf('    });', idx);
    if(endIdx !== -1) {
        content = content.substring(0, idx) + '    const browser = await launchPuppeteer();' + content.substring(endIdx + 7);
    }
}

let idx2 = content.indexOf('    browser = await puppeteer.launch({', 5300);
if(idx2 !== -1) {
    let endIdx2 = content.indexOf('    });', idx2);
    if(endIdx2 !== -1) {
        content = content.substring(0, idx2) + '    browser = await launchPuppeteer();' + content.substring(endIdx2 + 7);
    }
}

fs.writeFileSync(file, content, 'utf8');
console.log('Replaced');
