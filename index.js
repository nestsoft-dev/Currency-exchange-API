// server.cjs  (or server.js if your package.json is NOT "type": "module")
// Global FX Rates API – Real-time USD/EUR/JPY/GBP ↔ any currency
// Node 18+, Express 4+, axios, lru-cache@7, ioredis (optional)

const express = require('express');
const axios = require('axios');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const LRU = require('lru-cache');           // use lru-cache@7 for CJS
const crypto = require('crypto');
const dotenv = require('dotenv');
const serverless = require('serverless-http');
dotenv.config();

let Redis, redis;
try {
  // Optional Redis for shared cache
  Redis = require('ioredis');
} catch (e) {
  // optional
}

const app = express();

// -------------------- Config --------------------
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'dev-key-change-me';

// Provider API keys (optional depending on providers you enable)
const OPENEXCHANGE_APP_ID = process.env.OPENEXCHANGE_APP_ID || ''; // https://openexchangerates.org/ (paid/free)
const EXCHANGERATE_HOST_URL = process.env.EXCHANGERATE_HOST_URL || 'https://api.exchangerate.host';
const REDIS_URL = process.env.REDIS_URL || '';

const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 120);  // 2 minutes for live rates
const HIST_TTL_SEC  = Number(process.env.HIST_TTL_SEC  || 3600); // 1 hour for timeseries cache
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);

// Limit which bases we consider “primary/fast”
const PRIMARY_BASES = new Set(['USD', 'EUR', 'JPY', 'GBP']);

// -------------------- Security & Infra --------------------
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(morgan('tiny'));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 90, // 90 req/min per IP (tune for RapidAPI tiers)
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Simple API-key auth (RapidAPI can set this for you, or you can keep your own)
// app.use((req, res, next) => {
//   const key = req.get('x-api-key') || '';
//   if (!API_KEY || key !== API_KEY) {
//     return res.status(401).json({ error: 'Unauthorized: invalid API key' });
//   }
//   next();
// });



// -------------------- Cache Layer --------------------
let memoryCache = new LRU({
  ttl: CACHE_TTL_SEC * 1000,
  max: 5000,
});
if (REDIS_URL && Redis) {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, enableReadyCheck: true });
}

async function cacheGet(key) {
  if (redis) {
    const v = await redis.get(key);
    return v ? JSON.parse(v) : null;
  }
  return memoryCache.get(key) || null;
}
async function cacheSet(key, val, ttlSec) {
  if (redis) {
    await redis.set(key, JSON.stringify(val), 'EX', ttlSec);
  } else {
    memoryCache.set(key, val, { ttl: (ttlSec || CACHE_TTL_SEC) * 1000 });
  }
}

// -------------------- Utilities --------------------
const ISO = /^[A-Z]{3}$/;
function normCode(code) {
  if (!code || typeof code !== 'string') return '';
  const c = code.trim().toUpperCase();
  if (!ISO.test(c)) throw new Error(`Invalid currency code: ${code}`);
  return c;
}
function parseSymbols(q) {
  if (!q) return [];
  return q.split(',').map(s => normCode(s)).filter(Boolean);
}
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] != null) out[k] = obj[k];
  return out;
}
function http() {
  return axios.create({ timeout: REQUEST_TIMEOUT_MS });
}

// -------------------- Providers (with fallback) --------------------
// 1) exchangerate.host (free, good for many FX + historical)
// async function providerExchangeRateHost_latest(base, symbols) {
//   const cl = http();
//   const url = `${EXCHANGERATE_HOST_URL}/latest`;
//   const params = { base, symbols: symbols?.join(',') || undefined };
//   const { data } = await cl.get(url, { params });
//   if (!data || !data.rates) throw new Error('ERH: bad payload');
//   return {
//     base: data.base,
//     date: data.date,
//     rates: data.rates,
//     provider: 'exchangerate.host',
//   };
// }


async function providerExchangeRateHost_timeseries(base, symbols, start, end) {
    const cl = http();
    const url = `https://api.frankfurter.app/${start}..${end}`;
    const params = { from: base, to: symbols && symbols.length ? symbols.join(',') : undefined };
    const resp = await cl.get(url, { params });
    const data = resp.data;
    console.log('data', data);
    console.log('Url', url);
    console.log('params', params);
    console.log('resp', resp);
    
    if (!data || !data.rates || typeof data.rates !== 'object') {
      throw new Error(`Frankfurter TS: bad payload (${resp.status}) ${briefBody(data)}`);
    }
    return {
      base: data.base || base,
      start_date: data.start_date || start,
      end_date: data.end_date || end,
      series: data.rates
     // provider: 'frankfurter.app',
    };
  }

//   const TS_PIPELINE = [
//     providerFrankfurter_timeseries,
//     providerExchangeRateHost_timeseries,
//     // (optional) add OpenExchangeRates historical next if you upgrade there
//   ];

const ERH_ACCESS_KEY = process.env.EXCHANGERATE_HOST_ACCESS_KEY || '';

// helper to merge params with access_key if present
function withERHAuth(params = {}) {
  return ERH_ACCESS_KEY ? { access_key: ERH_ACCESS_KEY, ...params } : params;
}


// latest
async function providerExchangeRateHost_latest(base, symbols) {
    const cl = http();
    const url = `${EXCHANGERATE_HOST_URL}/latest`;
    const params = withERHAuth({
      base,
      symbols: symbols && symbols.length ? symbols.join(',') : undefined
    });
    const resp = await cl.get(url, { params });
    const data = resp.data;
    if (!data || data.success === false || !data.rates || typeof data.rates !== 'object') {
      throw new Error(`ERH: bad payload (${resp.status}) ${briefBody(data)}`);
    }
    return { base: data.base, date: data.date, rates: data.rates,  };
  }
  
  // timeseries (max 365 days per request per docs)
//   async function providerExchangeRateHost_timeseries(base, symbols, start, end) {
//     const cl = http();
//     const url = `${EXCHANGERATE_HOST_URL}/timeseries`;
//     const params = withERHAuth({
//       base,
//       symbols: symbols && symbols.length ? symbols.join(',') : undefined,
//       start_date: start,
//       end_date: end
//     });
//     const resp = await cl.get(url, { params });
//     const data = resp.data;
//     if (!data || data.success === false || !data.rates || typeof data.rates !== 'object') {
//       throw new Error(`ERH: bad payload (${resp.status}) ${briefBody(data)}`);
//     }
//     return {
//       base: data.base,
//       start_date: data.start_date,
//       end_date: data.end_date,
//       series: data.rates,
//       provider: 'exchangerate.host',
//     };
//   }


// 2) OpenExchangeRates (better reliability; needs APP ID; base: USD for free plans)
async function providerOpenExchange_latest(base, symbols) {
  if (!OPENEXCHANGE_APP_ID) throw new Error('OXR: missing app id');
  const cl = http();
  // OpenExchangeRates free tier supports USD base; for other bases we convert
  const { data } = await cl.get('https://openexchangerates.org/api/latest.json', {
    params: { app_id: OPENEXCHANGE_APP_ID, symbols: symbols?.join(',') },
  });
  if (!data || !data.rates || !data.base) throw new Error('OXR: bad payload');
  let rates = data.rates;
  const oxrBase = data.base || 'USD';

  if (base !== oxrBase) {
    if (!rates[base]) throw new Error(`OXR: cannot rebase to ${base}`);
    const baseRate = rates[base];
    // rebase all rates to desired base
    rates = Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, v / baseRate]));
  }
  // if symbols provided, filter
  if (symbols?.length) {
    rates = pick(rates, symbols);
  }
  return {
    base,
    date: new Date(data.timestamp * 1000).toISOString().slice(0, 10),
    rates,
    provider: 'openexchangerates',
  };
}

// 3) ECB (free, EUR base only, good reliability)
async function providerECB_latest(base, symbols) {
  // Doc reference: https://www.ecb.europa.eu/stats/eurofxref/
  const cl = http();
  const { data } = await cl.get('https://api.exchangerate.host/latest', { params: { base: 'EUR' } });
  if (!data || !data.rates) throw new Error('ECB proxy: bad payload');
  let rates = data.rates;
  if (base !== 'EUR') {
    if (!rates[base]) throw new Error(`ECB: cannot rebase to ${base}`);
    const baseRate = rates[base];
    rates = Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, v / baseRate]));
  }
  if (symbols?.length) rates = pick(rates, symbols);
  return {
    base,
    date: data.date,
    rates,
    provider: 'ecb',
  };
}

// Provider pipeline (latest)
const LATEST_PIPELINE = [
  providerExchangeRateHost_latest,
  providerOpenExchange_latest,
  providerECB_latest,
];

// Timeseries pipeline
const TS_PIPELINE = [
  providerExchangeRateHost_timeseries,
  // (Add other providers’ historical if you enable them)
];

// Helper to try providers in order
async function tryProvidersLatest(base, symbols) {
  const errs = [];
  for (const fn of LATEST_PIPELINE) {
    try {
      return await fn(base, symbols);
    } catch (e) {
      errs.push(e.message);
    }
  }
  throw new Error(`All providers failed: ${errs.join(' | ')}`);
}
async function tryProvidersTimeseries(base, symbols, start, end) {
  const errs = [];
  for (const fn of TS_PIPELINE) {
    try {
      return await fn(base, symbols, start, end);
    } catch (e) {
      errs.push(e.message);
    }
  }
  throw new Error(`All providers failed: ${errs.join(' | ')}`);
}

// -------------------- Core Service --------------------
async function getLatestRates(base, symbols) {
  base = normCode(base);
  const key = `fx:latest:${base}:${symbols?.join(',') || '*'}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  const res = await tryProvidersLatest(base, symbols);
  if (!res.rates || typeof res.rates !== 'object') throw new Error('No rates returned');

  await cacheSet(key, res, CACHE_TTL_SEC);
  return res;
}

async function convertAmount(from, to, amount) {
  from = normCode(from);
  to = normCode(to);
  const amt = Number(amount);
  if (!Number.isFinite(amt)) throw new Error('Amount must be a number');

  if (from === to) return { from, to, amount: amt, rate: 1, result: amt };

  const base = PRIMARY_BASES.has(from) ? from : (PRIMARY_BASES.has('USD') ? 'USD' : from);
  const symbols = new Set([from, to]);
  const { rates, provider, date } = await getLatestRates(base, Array.from(symbols));

  let rate;
  if (base === from) {
    if (!rates[to]) throw new Error(`Missing rate for ${to}`);
    rate = rates[to];
  } else {
    if (!rates[from] || !rates[to]) throw new Error(`Missing rates for pair ${from}/${to}`);
    rate = (1 / rates[from]) * rates[to];
  }
  const result = amt * rate;
  return { from, to, amount: amt, rate, result, asOf: date };
}

async function getTimeseries(base, symbols, start, end) {
  base = normCode(base);
  symbols = symbols?.map(normCode);
  if (!start || !end) throw new Error('start and end are required (YYYY-MM-DD)');

  const key = `fx:ts:${base}:${symbols?.join(',') || '*'}:${start}:${end}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  const res = await tryProvidersTimeseries(base, symbols, start, end);
  await cacheSet(key, res, HIST_TTL_SEC);
  return res;
}

// -------------------- Routes --------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// GET /v1/rates?base=USD&symbols=EUR,NGN,JPY
app.get('/v1/rates', async (req, res) => {
  try {
    const base = normCode(req.query.base || 'USD');
    const symbols = parseSymbols(req.query.symbols || '');
    console.log('base', base);
    console.log('symbols', symbols);
    const data = await getLatestRates(base, symbols.length ? symbols : undefined);
    console.log('data', data);
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// GET /v1/convert?from=USD&to=NGN&amount=100
app.get('/v1/convert', async (req, res) => {
  try {
    const from = normCode(req.query.from);
    const to = normCode(req.query.to);
    const amount = req.query.amount;
    const data = await convertAmount(from, to, amount);
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// GET /v1/timeseries?base=USD&symbols=NGN,EUR&start=2025-01-01&end=2025-09-23
app.get('/v1/timeseries', async (req, res) => {
  try {
    const base = normCode(req.query.base || 'USD');
    const symbols = parseSymbols(req.query.symbols || '');
    const start = req.query.start;
    const end = req.query.end;
    const data = await getTimeseries(base, symbols, start, end);
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('ERR', err);
  res.status(500).json({ error: 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`FX API listening on :${PORT}`);
});


module.exports.handler= serverless(app)

/*
echo "# Currency-exchange-API" >> README.md
git init
git add README.md
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/nestsoft-dev/Currency-exchange-API.git
git push -u origin main
*/