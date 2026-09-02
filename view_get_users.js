const fs = require('fs'); const content = fs.readFileSync('index.js', 'utf8'); const lines = content.split('\n'); for(let i=10080; i<10120; i++) { console.log(i + ': ' + lines[i].trim()); }
