const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 4001);
const BANK_URL = process.env.BANK_URL || 'http://localhost:4002';
const REQUEST_TIMEOUT_MS = 4000;
const bankUrl = new URL(BANK_URL);
const transport = bankUrl.protocol === 'https:' ? https : http;
const bankAgent = bankUrl.protocol === 'https:'
  ? new https.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 20 })
  : new http.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 20 });

const debts = new Map([
  ['1', 50_000_000],
  ['2', 0],
  ['3', 3_200_000]
]);
const payments = new Map();
const pendingByStudent = new Map();
let nextPaymentId = 1;

function getDebt(studentId) {
  return debts.get(studentId) || 0;
}

function sendError(res, statusCode, paymentId, status, error) {
  res.status(statusCode).json({ error, paymentId, status });
}

function callBank(paymentId, amount) {
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: bankUrl.protocol,
      hostname: bankUrl.hostname,
      port: bankUrl.port,
      path: `${bankUrl.pathname.replace(/\/$/, '')}/charges`,
      method: 'POST',
      agent: bankAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify({ reference: paymentId, amount })),
        'Idempotency-Key': paymentId
      },
      timeout: REQUEST_TIMEOUT_MS
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        let parsed;
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          reject(Object.assign(new Error('invalid bank response'), { kind: 'unknown' }));
          return;
        }
        resolve({ code: response.statusCode, body: parsed });
      });
    });

    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('bank request timed out'), {
        code: 'ETIMEDOUT',
        kind: 'timeout'
      }));
    });
    request.on('error', (error) => {
      if (error.kind === 'timeout' || error.code === 'ETIMEDOUT') {
        reject(Object.assign(error, { kind: 'timeout' }));
        return;
      }
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        reject(Object.assign(error, { kind: 'unavailable' }));
      } else {
        reject(Object.assign(error, { kind: 'unknown' }));
      }
    });
    request.write(JSON.stringify({ reference: paymentId, amount }));
    request.end();
  });
}

async function callBankWithRetry(paymentId, amount) {
  let lastResult;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await callBank(paymentId, amount);
      if (result.code !== 500 || attempt === 3) {
        return result;
      }
      lastResult = result;
    } catch (error) {
      if (error.kind === 'timeout' || attempt === 2) {
        throw error;
      }
      lastResult = error;
    }
  }
  return lastResult;
}

app.get('/students/:id/fees', (req, res) => {
  const studentId = req.params.id;
  res.json({ studentId, debt: getDebt(studentId) });
});

app.post('/students/:id/payments', async (req, res) => {
  const studentId = req.params.id;
  const amount = req.body && req.body.amount;
  const debt = getDebt(studentId);
  const pending = pendingByStudent.get(studentId) || 0;

  if (!Number.isInteger(amount) || amount <= 0) {
    sendError(res, 400, null, 'FAILED', 'amount must be a positive integer');
    return;
  }
  if (amount > debt - pending) {
    sendError(res, 400, null, 'FAILED', 'amount exceeds outstanding debt');
    return;
  }

  const paymentId = `P${nextPaymentId++}`;
  const payment = { paymentId, studentId, amount, status: 'PENDING' };
  payments.set(paymentId, payment);
  pendingByStudent.set(studentId, pending + amount);

  try {
    const bankResponse = await callBankWithRetry(paymentId, amount);
    if (bankResponse.code === 201) {
      payment.status = 'PAID';
      debts.set(studentId, debt - amount);
      pendingByStudent.set(studentId, (pendingByStudent.get(studentId) || 0) - amount);
      res.status(201).json({ ...payment, chargeId: bankResponse.body.chargeId });
      return;
    }

    payment.status = 'FAILED';
    pendingByStudent.set(studentId, (pendingByStudent.get(studentId) || 0) - amount);
    sendError(res, bankResponse.code || 502, paymentId, 'FAILED',
      bankResponse.body.error || 'bank rejected payment');
  } catch (error) {
    if (error.kind === 'unavailable') {
      payment.status = 'FAILED';
      pendingByStudent.set(studentId, (pendingByStudent.get(studentId) || 0) - amount);
      sendError(res, 503, paymentId, 'FAILED', 'bank is unavailable');
      return;
    }

    payment.status = 'PENDING';
    sendError(res, 504, paymentId, 'PENDING', 'bank result is unknown');
  }
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && error.type === 'entity.parse.failed') {
    sendError(res, 400, null, 'FAILED', 'request body must be valid JSON');
    return;
  }
  next(error);
});

const server = app.listen(PORT, () => {
  console.log(`Fee Service listening on http://localhost:${PORT}`);
  console.log(`BANK_URL=${BANK_URL}`);
});

server.maxConnections = 100;
server.on('error', (error) => {
  console.error('[fee] server error', error);
  process.exitCode = 1;
});
