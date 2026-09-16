const https = require('https');

function checkUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, raw: data.substring(0, 200) });
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log('Checking live backend...');
  const res = await checkUrl('https://api.hg-alshour.online/health');
  console.log('Live backend response:', res);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
