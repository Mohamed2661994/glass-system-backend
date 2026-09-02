const fs = require('fs'); const lines = fs.readFileSync('index.js', 'utf8').split('\n'); for(let i=10165; i<10175; i++) { console.log(i + ': ' + lines[i]); }
