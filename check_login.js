const fs = require('fs'); const lines = fs.readFileSync('index.js', 'utf8').split('\n'); for(let i=10524; i<=10528; i++) { console.log(i + ': ' + lines[i]); }
