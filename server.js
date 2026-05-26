const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const KIS_BASE_URL = process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
const NAVER_FINANCE_BASE = 'https://finance.naver.com';
const NAVER_STOCK_BASE = 'https://stock.naver.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let cachedToken = null;
let tokenExpireAt = 0;
let tokenFetchPromise = null;

const htmlCache = new Map();
const dataCache = new Map();
const quoteCache = new Map();

const EXCLUDE_PATTERNS = [
  /KODEX/i, /TIGER/i, /KOSEF/i, /KINDEX/i, /KBSTAR/i, /ARIRANG/i, /HANARO/i,
  /ACE/i, /SOL/i, /TIMEFOLIO/i, /TREX/i, /ETF/i, /ETN/i, /스팩/,
  /레버리지/, /인버스/, /선물/, /채권/, /국고채/
];

function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function normalizeText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  return Number(String(v).replace(/[^0-9.-]/g, '')) || 0;
}
function formatSignedPct(n) { return `${Number(n || 0) > 0 ? '+' : ''}${Number(n || 0).toFixed(2)}%`; }
function formatAmountLabel(won) {
  const n = Number(won || 0);
  if (n >= 1_0000_0000_0000) return `${(n / 1_0000_0000_0000).toFixed(1)}조`;
  if (n >= 1_0000_0000) return `${Math.round(n / 1_0000_0000).toLocaleString()}억`;
  return '0억';
}
function formatMarketCapLabel(eok) {
  const n = Number(eok || 0);
  if (n >= 10000) return `${(n / 10000).toFixed(1)}조`;
  if (n >= 1) return `${Math.round(n).toLocaleString()}억`;
  return '0억';
}
function isValidCode(code) { return /^\d{6}$/.test(String(code || '')); }
function isRealDomesticStockName(name) {
  const n = normalizeText(name);
  if (!n) return false;
  return !EXCLUDE_PATTERNS.some((re) => re.test(n));
}
function uniqueBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter((x) => {
    const key = keyFn(x);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function cacheGet(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.expireAt <= Date.now()) { map.delete(key); return null; }
  return entry.data;
}
function cacheSet(map, key, data, ttlMs) {
  map.set(key, { data, expireAt: Date.now() + ttlMs });
  return data;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function runner() {
    while (index < items.length) {
      const current = index++;
      try { results[current] = await worker(items[current], current); } 
      catch (e) { results[current] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
  return results;
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpireAt) return cachedToken;
  if (tokenFetchPromise) return tokenFetchPromise;

  tokenFetchPromise = (async () => {
    try {
      const res = await fetch(`${KIS_BASE_URL}/oauth2/tokenP`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ grant_type: 'client_credentials', appkey: process.env.APP_KEY, appsecret: process.env.APP_SECRET })
      });
      const text = await res.text();
      let json = {};
      try { json = JSON.parse(text); } catch (e) { throw new Error(`토큰 파싱 실패: ${text}`); }
      if (!res.ok || !json.access_token) throw new Error(`토큰 발급 실패(${res.status}): ${text}`);
      
      cachedToken = json.access_token;
      tokenExpireAt = now + 1000 * 60 * 60 * 20;
      return cachedToken;
    } finally {
      tokenFetchPromise = null;
    }
  })();
  return tokenFetchPromise;
}

function kisHeaders(token, trId) {
  return {
    'content-type': 'application/json; charset=utf-8',
    authorization: `Bearer ${token}`,
    appkey: process.env.APP_KEY,
    appsecret: process.env.APP_SECRET,
    tr_id: trId,
    custtype: 'P'
  };
}

async function kisGet(pathname, params, trId) {
  const token = await getAccessToken();
  const url = `${KIS_BASE_URL}${pathname}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, { method: 'GET', headers: kisHeaders(token, trId) });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch (e) { throw new Error(`KIS JSON 실패: ${text}`); }
  if (!res.ok) throw new Error(`KIS HTTP ${res.status}: ${text}`);
  if (json.rt_cd && json.rt_cd !== '0') throw new Error(`KIS rt_cd ${json.rt_cd}: ${json.msg1 || text}`);
  return json;
}

async function fetchKisQuote(code, fallbackName = '') {
  const cached = cacheGet(quoteCache, code);
  if (cached) return cached;

  const data = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-price', { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code }, 'FHKST01010100');
  const out = data.output || {};
  const item = {
    market: '국내주식', code,
    name: out.hts_kor_isnm || fallbackName || code,
    price: toNum(out.stck_prpr),
    changeRate: Number(out.prdy_ctrt || 0),
    changeValue: toNum(out.prdy_vrss),
    volume: toNum(out.acml_vol),
    amount: toNum(out.acml_tr_pbmn),
    marketCapEok: toNum(out.hts_avls)
  };
  return cacheSet(quoteCache, code, item, 1000 * 30);
}

async function fetchHtml(url, referer = NAVER_FINANCE_BASE) {
  const cached = cacheGet(htmlCache, url);
  if (cached) return cached;

  const res = await fetch(url, { headers: { 'user-agent': UA, 'referer': referer } });
  if (!res.ok) throw new Error(`HTML fetch 실패(${res.status}): ${url}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = String(res.headers.get('content-type') || '');
  let html = '';
  
  if (/euc-kr|cp949|ms949/i.test(contentType) || /charset=["']?(euc-kr|cp949|ms949)/i.test(buffer.toString('utf8'))) {
    html = iconv.decode(buffer, 'euc-kr');
  } else {
    html = buffer.toString('utf8');
  }
  return cacheSet(htmlCache, url, html, 1000 * 30);
}

// 테마/업종 1~10위 추출
async function fetchThemeIndustryList(kind) {
  const key = `rankList:${kind}`;
  const cached = cacheGet(dataCache, key);
  if (cached) return cached;

  const url = kind === '테마' ? `${NAVER_FINANCE_BASE}/sise/theme.naver` : `${NAVER_FINANCE_BASE}/sise/sise_group.naver?type=upjong`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const rows = [];

  $('table.type_1 tr').each((_, tr) => {
    const $a = $(tr).find('td.col_type1 a');
    if ($a.length > 0) {
      const href = $a.attr('href') || '';
      const name = normalizeText($a.text());
      if (name && href) rows.push({ type: kind, name, href: `${NAVER_FINANCE_BASE}${href}` });
    }
  });

  return cacheSet(dataCache, key, rows.slice(0, 10), 1000 * 60 * 5); // 1~10위까지만 제한
}

async function fetchMembersFromDetail(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const members = [];

  $('table.type_5 tbody tr').each((_, tr) => {
    const $a = $(tr).find('td.name div.name_area a');
    if ($a.length > 0) {
      const m = ($a.attr('href') || '').match(/code=(\d{6})/);
      const name = normalizeText($a.text());
      if (m && isRealDomesticStockName(name)) members.push({ code: m[1], name });
    }
  });

  return uniqueBy(members, (x) => x.code).slice(0, 15);
}

async function buildLeaderItem(rankItem) {
  const members = await fetchMembersFromDetail(rankItem.href);
  if (!members.length) return null;

  const quotes = await mapLimit(members, 5, async (member) => {
    try { return await fetchKisQuote(member.code, member.name); } catch (e) { return null; }
  });

  let realQuotes = quotes.filter(Boolean);
  if (!realQuotes.length) return null;

  realQuotes.sort((a, b) => (b.volume || 0) - (a.volume || 0));

  const totalAmount = realQuotes.reduce((sum, x) => sum + (x.amount || 0), 0);
  const avgRate = realQuotes.reduce((sum, x) => sum + (x.changeRate || 0), 0) / realQuotes.length;

  return {
    type: rankItem.type,
    name: rankItem.name,
    sector: rankItem.name,
    reason: `네이버 ${rankItem.type} 정보 · 한국투자증권 실시간 연동`,
    chg: formatSignedPct(avgRate),
    volume: formatAmountLabel(totalAmount),
    // 통일된 주식 스키마 적용
    stocks: realQuotes.slice(0, 10).map((x) => ({
      market: '국내주식',
      code: x.code,
      name: x.name,
      price: x.price,
      changeRate: x.changeRate,
      changeValue: x.changeValue,
      volume: x.volume,
      amount: x.amount
    }))
  };
}

async function buildLeaderPayload() {
  const cached = cacheGet(dataCache, 'leaderPayload');
  if (cached) return cached;

  const [themes, industries] = await Promise.all([ fetchThemeIndustryList('테마'), fetchThemeIndustryList('업종') ]);
  const allItems = [...themes, ...industries];

  const sectors = await mapLimit(allItems, 4, async (item) => {
    await sleep(50);
    return buildLeaderItem(item);
  });

  const payload = {
    categories: { 테마: themes.map((x) => x.name), 업종: industries.map((x) => x.name) },
    sectors: sectors.filter(Boolean),
    meta: { source: 'real', updatedAt: nowIso(), message: '정상 데이터 연동' }
  };
  return cacheSet(dataCache, 'leaderPayload', payload, 1000 * 30);
}

async function buildRankPayload(kind) {
  const key = `marketRank:${kind}`;
  const cached = cacheGet(dataCache, key);
  if (cached) return cached;

  const data = await kisGet('/uapi/domestic-stock/v1/quotations/volume-rank', {
      FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '20171', FID_INPUT_ISCD: '0000',
      FID_DIV_CLS_CODE: '0', FID_BLNG_CLS_CODE: '0', FID_TRGT_CLS_CODE: '111111111',
      FID_TRGT_EXLS_CLS_CODE: '000010111', FID_INPUT_PRICE_1: '', FID_INPUT_PRICE_2: '',
      FID_VOL_CNT: '', FID_INPUT_DATE_1: '', FID_RANK_SORT_CLS_CODE: kind === 'volume' ? '0' : '3'
  }, 'FHPST01720000');

  const rawItems = (data.output || [])
    .map((row) => ({ code: row.stck_shrn_iscd || '', name: row.hts_kor_isnm || '' }))
    .filter((x) => isValidCode(x.code) && isRealDomesticStockName(x.name))
    .slice(0, 20);

  const quotes = await mapLimit(rawItems, 5, async (item) => {
    try { return await fetchKisQuote(item.code, item.name); } catch (e) { return null; }
  });

  const items = quotes.filter(Boolean).sort((a, b) => {
    if (kind === 'volume') return (b.volume || 0) - (a.volume || 0);
    return (b.amount || 0) - (a.amount || 0);
  }).slice(0, 15);

  const payload = { items, meta: { source: 'real', updatedAt: nowIso() } };
  return cacheSet(dataCache, key, payload, 1000 * 20);
}

app.get('/', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  res.status(404).send('public/index.html not found');
});

app.get('/api/data', async (req, res) => {
  try { res.json(await buildLeaderPayload()); } 
  catch (error) { res.json({ categories: { 테마: [], 업종: [] }, sectors: [], meta: { source: 'sample', message: `에러: ${error.message}` }}); }
});
app.get('/api/market/volume-top', async (req, res) => {
  try { res.json(await buildRankPayload('volume')); } 
  catch (error) { res.json({ items: [], meta: { source: 'sample', message: `에러: ${error.message}` }}); }
});
app.get('/api/market/amount-top', async (req, res) => {
  try { res.json(await buildRankPayload('amount')); } 
  catch (error) { res.json({ items: [], meta: { source: 'sample', message: `에러: ${error.message}` }}); }
});

app.listen(PORT, async () => {
  console.log(`server listening on ${PORT}`);
  try { await getAccessToken(); console.log('KIS token ready'); } 
  catch (err) { console.error('초기 토큰 발급 실패:', err.message); }
});
