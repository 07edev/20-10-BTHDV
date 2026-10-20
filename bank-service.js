const express = require('express');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 4002);
const LIMIT = 20_000_000;
const delayMs = Math.max(0, Number(process.env.DELAY_MS || 0));
const failRate = readRate('FAIL_RATE');
const dropRate = readRate('DROP_RATE');

const chargesByKey = new Map();
const chargesByReference = new Map();
const stats = {
  connections: 0,
  requests: 0,
  charges: 0,
  duplicates: 0
};

function readRate(name) {
  const value = Number(process.env[name] || 0);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.post('/charges', async (req, res) => {
  stats.requests += 1;
  const { reference, amount } = req.body || {};
  const key = req.get('Idempotency-Key');

  if (!reference || typeof reference !== 'string') {
    res.status(400).json({ error: 'reference is required' });
    return;
  }

  if (key && chargesByKey.has(key)) {
    res.status(201).json(chargesByKey.get(key));
    return;
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    res.status(400).json({ error: 'amount must be a positive integer' });
    return;
  }

  if (amount > LIMIT) {
    res.status(402).json({ error: 'bank limit exceeded', limit: LIMIT });
    return;
  }

  if (delayMs > 0) {
    await wait(delayMs);
  }

  if (Math.random() < failRate) {
    res.status(500).json({ error: 'temporary bank failure' });
    return;
  }

  const existing = chargesByReference.get(reference);
  if (existing) {
    if (key) chargesByKey.set(key, existing);
    res.status(201).json(existing);
    return;
  }

  const charge = {
    chargeId: `C${stats.charges + 1}`,
    reference,
    amount
  };
  chargesByReference.set(reference, charge);
  if (key) chargesByKey.set(key, charge);
  stats.charges += 1;

  if (Math.random() < dropRate) {
    res.destroy();
    return;
  }

  res.status(201).json(charge);
});

app.get('/stats', (req, res) => {
  res.json(stats);
});

const server = app.listen(PORT, () => {
  console.log(`Bank Service listening on http://localhost:${PORT}`);
  console.log(`DELAY_MS=${delayMs} FAIL_RATE=${failRate} DROP_RATE=${dropRate}`);
});

server.keepAliveTimeout = 5000;
server.headersTimeout = 6000;
server.on('connection', (socket) => {
  stats.connections += 1;
  console.log(`[bank] new TCP connection (#${stats.connections})`);
  socket.on('error', () => {});
});
