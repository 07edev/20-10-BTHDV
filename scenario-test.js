const http = require('http');

const feeUrl = process.env.FEE_URL || 'http://localhost:4001';

function request(path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request(`${feeUrl}${path}`, {
      method,
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : {}
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const started = Date.now();
  const result = await request('/students/1/payments', 'POST', { amount: 1000 });
  console.log(JSON.stringify({ elapsedMs: Date.now() - started, ...result }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
