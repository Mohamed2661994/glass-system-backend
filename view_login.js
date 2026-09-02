const fs = require('fs'); const lines = fs.readFileSync('index.js', 'utf8').split('\n'); for(let i=10540; i<10570; i++) { console.log(i + ': ' + lines[i]); }
