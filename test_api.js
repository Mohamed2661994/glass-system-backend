const https = require('https');

const token = "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MiwidXNlcm5hbWUiOiJob2dsYXNzX3N5c3RlbSIsInBlcm1pc3Npb25zIjp7ImNhbl9lZGl0Ijp0cnVlLCJpc19hZG1pbiI6ZmFsc2UsImFsbG93ZWRfdGFibGVzIjpbIioiXSwiYW5hbHl0aWNzX2FjY2VzcyI6dHJ1ZSwiYW5hbHl0aWNzX2Nhbl9lZGl0Ijp0cnVlLCJkYXRhYmFzZV9jb25uZWN0aW9uIjp7Imhvc3QiOiJkYnN0dWRpby5oZy1hbHNob3VyLm9ubGluZSIsInBvcnQiOiI1NDMyIiwiZGJfbmFtZSI6ImdsYXNzX3N5c3RlbSIsImRiX3VzZXIiOiJnbGFzc19iYWNrZW5kIiwiZW5hYmxlZCI6dHJ1ZSwiY2x1c3Rlcl9tb2RlIjoiSGlnaCBBdmFpbGFiaWxpdHkgTXVsdGktU2VydmVyIChBY3RpdmUgUGdwb29sLUlJIEdhdGV3YXkpIiwiY29ubmVjdGlvbl9zdHJpbmciOiJwb3N0Z3Jlc3FsOi8vZ2xhc3NfYmFja2VuZDpTZWNHbGFzc18yMDI2X1Bvc3RncmVzX0hBQGRic3R1ZGlvLmhnLWFsc2hvdXIub25saW5lOjU0MzIvZ2xhc3Nfc3lzdGVtIn0sImFuYWx5dGljc19hbGxvd2VkX3RhYmxlcyI6WyIqIl19LCJpYXQiOjE3ODk5MTI0MzksImV4cCI6MjEwNTI3MjQzOX0.FeK3RD2170WIAJRTKJKeCotT8MjcnRqBgnau7o63_xI";

async function request(path, method = 'GET', body = null) {
  return new Promise((resolve) => {
    const url = new URL(path, 'https://srstudio.hg-alshour.online');
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    req.on('error', (err) => resolve({ error: err.message }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function test() {
  const paths = [
    '/api/tables',
    '/api/schema',
    '/api/database/tables',
    '/api/explorer/tables',
    '/api/data/invoices',
    '/api/data/products',
    '/api/query'
  ];

  for (const p of paths) {
    const res = await request(p);
    console.log(`PATH: ${p} -> Status: ${res.status}`);
    if (res.data) {
      console.log('Sample data:', res.data.substring(0, 200));
    }
  }
}

test();
