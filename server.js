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
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

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

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  return Number(String(v).replace(/[^0-9.-]/g, '')) || 0;
}

function formatSignedPct(n) {
  const v = Number(n || 0);
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

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

function isValidCode(code) {
  return /^\d{6}$/.test(String(code || ''));
}

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
  if (entry.expireAt <= Date.now()) {
    map.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(map, key, data, ttlMs) {
  map.set(key, { data, expireAt: Date.now() + ttlMs });
  return data;
}

function absoluteUrl(base, href) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  return new URL(href, base).toString();
}

function extractCode(text = '') {
  const m1 = text.match(/code=(\d{6})/);
  if (m1) return m1[1];
  const m2 = text.match(/\/stock\/(\d{6})/);
  if (m2) return m2[1];
  return '';
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function runner() {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await worker(items[current], current);
      } catch (e) {
        results[current] = null;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runner())
  );

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
        body: JSON.stringify({
          grant_type: 'client_credentials',
          appkey: process.env.APP_KEY,
          appsecret: process.env.APP_SECRET
        })
      });

      const text = await res.text();
      let json = {};
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new Error(`토큰 파싱 실패: ${text}`);
      }

      if (!res.ok || !json.access_token) {
        throw new Error(`토큰 발급 실패(${res.status}): ${text}`);
      }

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
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`KIS JSON 파싱 실패: ${text}`);
  }

  if (!res.ok) {
    throw new Error(`KIS HTTP ${res.status}: ${text}`);
  }
  if (json.rt_cd && json.rt_cd !== '0') {
    throw new Error(`KIS rt_cd ${json.rt_cd}: ${json.msg1 || text}`);
  }

  return json;
}

async function fetchKisQuote(code, fallbackName = '') {
  const cached = cacheGet(quoteCache, code);
  if (cached) return cached;

  const data = await kisGet(
    '/uapi/domestic-stock/v1/quotations/inquire-price',
    {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: code
    },
    'FHKST01010100'
  );

  const out = data.output || {};
  const item = {
    market: '국내주식',
    code,
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

  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      'referer': referer
    }
  });

  if (!res.ok) {
    throw new Error(`HTML fetch 실패(${res.status}): ${url}`);
  }

  const ab = await res.arrayBuffer();
  const buffer = Buffer.from(ab);
  const contentType = String(res.headers.get('content-type') || '');

  let html = '';
  if (/euc-kr|cp949|ms949/i.test(contentType)) {
    html = iconv.decode(buffer, 'euc-kr');
  } else {
    const utf8Text = buffer.toString('utf8');
    if (/charset=["']?(euc-kr|cp949|ms949)/i.test(utf8Text)) {
      html = iconv.decode(buffer, 'euc-kr');
    } else {
      html = utf8Text;
    }
  }

  return cacheSet(htmlCache, url, html, 1000 * 30);
}

function parseThemeIndustryLinks(html, kind) {
  const $ = cheerio.load(html);
  const items = [];

  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const name = normalizeText($(a).text());

    if (!name) return;

    const isTheme =
      /theme_detail\.naver/i.test(href) ||
      /sise_group_detail\.naver\?type=theme/i.test(href);

    const isUpjong =
      /sise_group_detail\.naver\?type=upjong/i.test(href);

    if (kind === '테마' && !isTheme) return;
    if (kind === '업종' && !isUpjong) return;

    items.push({
      type: kind,
      name,
      href: absoluteUrl(NAVER_FINANCE_BASE, href)
    });
  });

  return uniqueBy(items, (x) => x.href).slice(0, 15);
}

async function fetchThemeIndustryList(kind) {
  const key = `rank:${kind}`;
  const cached = cacheGet(dataCache, key);
  if (cached) return cached;

  const url =
    kind === '테마'
      ? `${NAVER_FINANCE_BASE}/sise/theme.naver`
      : `${NAVER_FINANCE_BASE}/sise/sise_group.naver?type=upjong`;

  const html = await fetchHtml(url, NAVER_FINANCE_BASE);
  const items = parseThemeIndustryLinks(html, kind);

  return cacheSet(dataCache, key, items, 1000 * 60 * 5);
}

function parseMembersFromDetailHtml(html) {
  const $ = cheerio.load(html);
  const items = [];

  const selectors = [
    'table.type_5 a[href*="item/main.naver?code="]',
    'table.type_1 a[href*="item/main.naver?code="]',
    'a[href*="item/main.naver?code="]'
  ];

  selectors.forEach((selector) => {
    $(selector).each((_, a) => {
      const href = $(a).attr('href') || '';
      const code = extractCode(href);
      const name = normalizeText($(a).text());
      if (!isValidCode(code)) return;
      if (!isRealDomesticStockName(name)) return;
      items.push({ code, name });
    });
  });

  if (items.length >= 3) {
    return uniqueBy(items, (x) => x.code).slice(0, 30);
  }

  const rawCodes = [];
  const re = /code=(\d{6})/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    rawCodes.push(m[1]);
  }

  rawCodes.forEach((code) => {
    if (isValidCode(code)) items.push({ code, name: '' });
  });

  return uniqueBy(items, (x) => x.code).slice(0, 30);
}

async function fetchMembersFromDetail(detailUrl) {
  const key = `members:${detailUrl}`;
  const cached = cacheGet(dataCache, key);
  if (cached) return cached;

  const html = await fetchHtml(detailUrl, NAVER_FINANCE_BASE);
  const members = parseMembersFromDetailHtml(html);

  return cacheSet(dataCache, key, members, 1000 * 60 * 5);
}

async function buildLeaderItem(rankItem) {
  const members = await fetchMembersFromDetail(rankItem.href);
  if (!members.length) return null;

  const quotes = await mapLimit(members.slice(0, 20), 5, async (member) => {
    await sleep(20);
    try {
      const q = await fetchKisQuote(member.code, member.name);
      if (!isRealDomesticStockName(q.name)) return null;
      return q;
    } catch (e) {
      return null;
    }
  });

  const realQuotes = quotes
    .filter(Boolean)
    .sort((a, b) =>
      (b.volume || 0) - (a.volume || 0) ||
      (b.amount || 0) - (a.amount || 0) ||
      (b.changeRate || 0) - (a.changeRate || 0)
    );

  if (!realQuotes.length) return null;

  const topStocks = realQuotes.slice(0, 10);
  const totalAmount = realQuotes.reduce((sum, x) => sum + (x.amount || 0), 0);
  const totalVolume = realQuotes.reduce((sum, x) => sum + (x.volume || 0), 0);
  const totalMcap = realQuotes.reduce((sum, x) => sum + (x.marketCapEok || 0), 0);
  const avgRate = realQuotes.reduce((sum, x) => sum + (x.changeRate || 0), 0) / realQuotes.length;

  return {
    type: rankItem.type,
    name: rankItem.name,
    sector: rankItem.name,
    reason: `네이버 ${rankItem.type} 분류 종목 → 한국투자증권 시세 연동 · 구성종목은 거래량 순`,
    chg: formatSignedPct(avgRate),
    volume: formatAmountLabel(totalAmount),
    marketCap: formatMarketCapLabel(totalMcap),
    tradeVolume: totalVolume,
    strength: Math.max(100, Math.round(100 + avgRate * 5)),
    stocks: topStocks.map((x) => ({
      name: x.name,
      code: x.code,
      price: Number(x.price || 0).toLocaleString(),
      chg: formatSignedPct(x.changeRate),
      volume: Number(x.volume || 0).toLocaleString(),
      amount: formatAmountLabel(x.amount || 0)
    }))
  };
}

async function buildLeaderPayload() {
  const cached = cacheGet(dataCache, 'leaderPayload');
  if (cached) return cached;

  const [themes, upjongs] = await Promise.all([
    fetchThemeIndustryList('테마'),
    fetchThemeIndustryList('업종')
  ]);

  const merged = [...themes, ...upjongs];

  const sectors = await mapLimit(merged, 4, async (item) => {
    await sleep(30);
    return buildLeaderItem(item);
  });

  const payload = {
    categories: {
      테마: themes.map((x) => x.name),
      업종: upjongs.map((x) => x.name)
    },
    sectors: sectors.filter(Boolean),
    meta: {
      source: 'real',
      updatedAt: nowIso(),
      message: '네이버 테마/업종 분류 + 한국투자증권 종목 데이터'
    }
  };

  return cacheSet(dataCache, 'leaderPayload', payload, 1000 * 45);
}

async function fetchGlobalRankSeeds(kind) {
  const key = `seed:${kind}`;
  const cached = cacheGet(dataCache, key);
  if (cached) return cached;

  const data = await kisGet(
    '/uapi/domestic-stock/v1/quotations/volume-rank',
    {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_COND_SCR_DIV_CODE: '20171',
      FID_INPUT_ISCD: '0000',
      FID_DIV_CLS_CODE: '0',
      FID_BLNG_CLS_CODE: '0',
      FID_TRGT_CLS_CODE: '111111111',
      FID_TRGT_EXLS_CLS_CODE: '000010111',
      FID_INPUT_PRICE_1: '',
      FID_INPUT_PRICE_2: '',
      FID_VOL_CNT: '',
      FID_INPUT_DATE_1: '',
      FID_RANK_SORT_CLS_CODE: kind === 'volume' ? '0' : '3'
    },
    'FHPST01720000'
  );

  const items = (data.output || [])
    .map((row) => ({
      code: row.stck_shrn_iscd || row.mksc_shrn_iscd || '',
      name: row.hts_kor_isnm || row.prdt_name || ''
    }))
    .filter((x) => isValidCode(x.code) && isRealDomesticStockName(x.name))
    .slice(0, 20);

  return cacheSet(dataCache, key, items, 1000 * 20);
}

async function buildRankPayload(kind) {
  const key = `market:${kind}`;
  const cached = cacheGet(dataCache, key);
  if (cached) return cached;

  const seeds = await fetchGlobalRankSeeds(kind);

  const quotes = await mapLimit(seeds, 5, async (item) => {
    await sleep(20);
    try {
      return await fetchKisQuote(item.code, item.name);
    } catch (e) {
      return null;
    }
  });

  const items = quotes
    .filter(Boolean)
    .filter((x) => isRealDomesticStockName(x.name))
    .sort((a, b) => {
      if (kind === 'volume') return (b.volume || 0) - (a.volume || 0);
      return (b.amount || 0) - (a.amount || 0);
    })
    .slice(0, 10)
    .map((x) => ({
      market: '국내주식',
      code: x.code,
      name: x.name,
      price: x.price,
      changeRate: x.changeRate,
      changeValue: x.changeValue,
      volume: x.volume,
      amount: x.amount
    }));

  const payload = {
    items,
    meta: {
      source: 'real',
      updatedAt: nowIso(),
      message:
        kind === 'volume'
          ? '한국투자증권 전체 거래량 상위 10'
          : '한국투자증권 전체 거래대금 상위 10'
    }
  };

  return cacheSet(dataCache, key, payload, 1000 * 20);
}

app.get('/', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  res.status(404).send('public/index.html not found');
});

app.get('/api/data', async (req, res) => {
  try {
    const data = await buildLeaderPayload();
    res.json(data);
  } catch (error) {
    console.error('leader error:', error.message);
    res.json({
      categories: { 테마: [], 업종: [] },
      sectors: [],
      meta: {
        source: 'sample',
        updatedAt: nowIso(),
        message: `API 에러: ${error.message}`
      }
    });
  }
});

app.get('/api/market/volume-top', async (req, res) => {
  try {
    const data = await buildRankPayload('volume');
    res.json(data);
  } catch (error) {
    console.error('volume-top error:', error.message);
    res.json({
      items: [],
      meta: {
        source: 'sample',
        updatedAt: nowIso(),
        message: `API 에러: ${error.message}`
      }
    });
  }
});

app.get('/api/market/amount-top', async (req, res) => {
  try {
    const data = await buildRankPayload('amount');
    res.json(data);
  } catch (error) {
    console.error('amount-top error:', error.message);
    res.json({
      items: [],
      meta: {
        source: 'sample',
        updatedAt: nowIso(),
        message: `API 에러: ${error.message}`
      }
    });
  }
});

app.listen(PORT, async () => {
  console.log(`server listening on ${PORT}`);
  try {
    await getAccessToken();
    console.log('KIS token ready');
  } catch (err) {
    console.error('초기 토큰 발급 실패:', err.message);
  }
});
