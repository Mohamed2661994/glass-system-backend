const fs = require('fs'); const lines = fs.readFileSync('index.js', 'utf8').split('\n'); for(let i=10490; i<10520; i++) { console.log(i + ': ' + lines[i].trim()); }
