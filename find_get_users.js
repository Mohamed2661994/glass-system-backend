const fs = require('fs'); const lines = fs.readFileSync('index.js', 'utf8').split('\n'); for(let i=10080; i<10120; i++) { console.log(i + ': ' + lines[i].trim()); }
