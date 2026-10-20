const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const root = __dirname;
const results = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(baseUrl, requestPath, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const payload = body ? JSON.stringify(body) : '';
    const requestObject = http.request(`${baseUrl}${requestPath}`, {
      method,
      agent: false,
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : {}
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
        resolve({ status: response.statusCode, body: parsed, elapsedMs: Date.now() - started });
      });
    });
    requestObject.setTimeout(10000, () => requestObject.destroy(new Error('client timeout')));
    requestObject.on('error', reject);
    if (payload) requestObject.write(payload);
    requestObject.end();
  });
}

function bankRequest(baseUrl, requestPath, body, idempotencyKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const requestObject = http.request(`${baseUrl}${requestPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Idempotency-Key': idempotencyKey
      }
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        body: text ? JSON.parse(text) : {}
      }));
    });
    requestObject.on('error', reject);
    requestObject.write(payload);
    requestObject.end();
  });
}

function start(script, env) {
  const child = spawn(process.execPath, [path.join(root, script)], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true
  });
  return child;
}

async function waitFor(baseUrl, requestPath) {
  for (let i = 0; i < 30; i += 1) {
    try {
      await request(baseUrl, requestPath);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`service did not start: ${baseUrl}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await sleep(200);
}

async function scenario(name, bankEnv, test) {
  const bankPort = 4102;
  const feePort = 4101;
  const bank = start('bank-service.js', { PORT: bankPort, ...bankEnv });
  const fee = start('fee-service.js', {
    PORT: feePort,
    BANK_URL: `http://localhost:${bankPort}`
  });
  try {
    await waitFor(`http://localhost:${feePort}`, '/students/1/fees');
    const result = await test(`http://localhost:${feePort}`, `http://localhost:${bankPort}`);
    results.push({ scenario: name, ...result });
  } finally {
    await stop(fee);
    await stop(bank);
  }
}

async function main() {
  await scenario('1 - bank unavailable', {}, async () => {
    const unavailableFee = start('fee-service.js', {
      PORT: 4103,
      BANK_URL: 'http://localhost:4999'
    });
    try {
      await waitFor('http://localhost:4103', '/students/1/fees');
      const started = Date.now();
      const payment = await request('http://localhost:4103', '/students/1/payments', 'POST', { amount: 1000 });
      const fees = await request('http://localhost:4103', '/students/1/fees');
      return {
        paymentStatus: payment.status,
        paymentBodyStatus: payment.body.status,
        elapsedMs: Date.now() - started,
        feesStatus: fees.status
      };
    } finally {
      await stop(unavailableFee);
    }
  });

  await scenario('2 - delayed bank', { DELAY_MS: '5000' }, async (feeUrl) => {
    const started = Date.now();
    const payments = Array.from({ length: 20 }, () =>
      request(feeUrl, '/students/1/payments', 'POST', { amount: 1000 }));
    await sleep(100);
    const feeReadStarted = Date.now();
    const fees = await request(feeUrl, '/students/1/fees');
    const feeReadMs = Date.now() - feeReadStarted;
    const responses = await Promise.all(payments);
    return {
      total: responses.length,
      timeoutResponses: responses.filter((item) => item.status === 504).length,
      elapsedMs: Date.now() - started,
      maxPaymentMs: Math.max(...responses.map((item) => item.elapsedMs || 0)),
      feeReadMs,
      feesStatus: fees.status
    };
  });

  await scenario('3 - keep alive', {}, async (feeUrl, bankUrl) => {
    const initialFees = await Promise.all([
      request(feeUrl, '/students/1/fees'),
      request(feeUrl, '/students/2/fees'),
      request(feeUrl, '/students/3/fees')
    ]);
    const idempotentFirst = await bankRequest(
      bankUrl, '/charges', { reference: 'IDEMPOTENCY-CHECK', amount: 1000 }, 'IDEMPOTENCY-CHECK'
    );
    const idempotentSecond = await bankRequest(
      bankUrl, '/charges', { reference: 'IDEMPOTENCY-CHECK', amount: 1000 }, 'IDEMPOTENCY-CHECK'
    );
    let successful = 0;
    for (let batch = 0; batch < 20; batch += 1) {
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => request(feeUrl, '/students/1/payments', 'POST', { amount: 1000 }))
      );
      successful += responses.filter((item) => item.status === 201).length;
    }
    const beforeIdle = await request(bankUrl, '/stats');
    await sleep(6000);
    const afterIdle = await Promise.all([
      request(feeUrl, '/students/1/payments', 'POST', { amount: 1000 }),
      request(feeUrl, '/students/1/payments', 'POST', { amount: 1000 })
    ]);
    const afterStats = await request(bankUrl, '/stats');
    return {
      successfulBeforeIdle: successful,
      successfulAfterIdle: afterIdle.filter((item) => item.status === 201).length,
      initialDebts: initialFees.map((item) => item.body.debt),
      idempotencyStatuses: [idempotentFirst.status, idempotentSecond.status],
      sameChargeId: idempotentFirst.body.chargeId === idempotentSecond.body.chargeId,
      connectionsBeforeIdle: beforeIdle.body.connections,
      connectionsAfterIdle: afterStats.body.connections,
      duplicates: afterStats.body.duplicates
    };
  });

  await scenario('4a - drop after charge', { DROP_RATE: '0.3' }, async (feeUrl, bankUrl) => {
    const responses = await Promise.all(
      Array.from({ length: 60 }, () => request(feeUrl, '/students/1/payments', 'POST', { amount: 1000 }))
    );
    const stats = await request(bankUrl, '/stats');
    return {
      total: responses.length,
      paid: responses.filter((item) => item.status === 201).length,
      pending: responses.filter((item) => item.body.status === 'PENDING').length,
      charges: stats.body.charges,
      duplicates: stats.body.duplicates
    };
  });

  await scenario('4b - temporary failures', { FAIL_RATE: '0.3' }, async (feeUrl, bankUrl) => {
    const responses = await Promise.all(
      Array.from({ length: 60 }, () => request(feeUrl, '/students/1/payments', 'POST', { amount: 1000 }))
    );
    const stats = await request(bankUrl, '/stats');
    return {
      total: responses.length,
      paid: responses.filter((item) => item.status === 201).length,
      failed: responses.filter((item) => item.body.status === 'FAILED').length,
      charges: stats.body.charges,
      duplicates: stats.body.duplicates
    };
  });

  await scenario('4c - over bank limit', {}, async (feeUrl, bankUrl) => {
    const payment = await request(feeUrl, '/students/1/payments', 'POST', { amount: 25_000_000 });
    const stats = await request(bankUrl, '/stats');
    return { paymentStatus: payment.status, paymentBodyStatus: payment.body.status, bankRequests: stats.body.requests };
  });

  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
