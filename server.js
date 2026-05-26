const express = require('express');
const cors = require('cors');
const path = require('path');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const KIS_BASE_URL = process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
const NAVER_BASE_URL = 'https://stock.naver.com';
const NAVER_FINANCE_BASE_URL = 'https://finance.naver.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let cachedToken = null;
let tokenExpireAt = 0;
let tokenFetchPromise = null;

const responseCache = new Map();
const quoteCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function cacheGet(key) {
  const item = responseCache.get(key);
  if (!item) return null;
  if (item.expireAt <= Date.now()) {
    responseCache.delete(key);
    return null;
  }
  return item.data;
}

function cacheSet(key, data, ttlMs) {
  responseCache.set(key, { data, expireAt: Date.now() + ttlMs });
  return data;
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  return Number(String(v).replace(/[^0-9.-]/g, '')) || 0;
}

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function uniqueBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter((x) => {
    const k = keyFn(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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

const EXCLUDE_PATTERNS = [
  /KODEX/i, /TIGER/i, /KOSEF/i, /KINDEX/i, /KBSTAR/i, /ARIRANG/i, /HANARO/i,
  /ACE/i, /SOL/i, /TIMEFOLIO/i, /TREX/i, /FOCUS/i, /PLUS /i,
  /ETF/i, /ETN/i, /스팩/, /레버리지/, /인버스/, /선물/, /채권/, /국고채/
];

function isRealDomesticStockName(name) {
  const n = normalizeText(name);
  if (!n) return false;
  return !EXCLUDE_PATTERNS.some((re) => re.test(n));
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
        if (json.error_code === 'EGW00133' && cachedToken) return cachedToken;
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

  const res = await fetch(url, {
    method: 'GET',
    headers: kisHeaders(token, trId)
  });

  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`KIS 응답 파싱 실패: ${text}`);
  }

  if (!res.ok) throw new Error(`KIS HTTP ${res.status}: ${text}`);
  if (json.rt_cd && json.rt_cd !== '0') throw new Error(`KIS rt_cd ${json.rt_cd}: ${json.msg1 || text}`);

  return json;
}

async function fetchKisQuote(code, fallbackName = '') {
  const cached = quoteCache.get(code);
  if (cached && cached.expireAt > Date.now()) return cached.data;

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

  quoteCache.set(code, { data: item, expireAt: Date.now() + 1000 * 30 });
  return item;
}

async function fetchHtml(url) {
  const cached = cacheGet(`html:${url}`);
  if (cached) return cached;

  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      'referer': NAVER_BASE_URL
    }
  });

  if (!res.ok) throw new Error(`네이버 HTML 실패(${res.status}): ${url}`);

  const ab = await res.arrayBuffer();
  const buffer = Buffer.from(ab);
  const contentType = String(res.headers.get('content-type') || '');

  let html;
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

  cacheSet(`html:${url}`, html, 1000 * 20);
  return html;
}

function extractCodeFromHref(href = '') {
  const codeMatch = href.match(/code=(\d{6})/);
  if (codeMatch) return codeMatch[1];

  const pathMatch = href.match(/\/domestic\/stock\/(\d{6})/);
  if (pathMatch) return pathMatch[1];

  return '';
}

function extractJsonBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

function parseStockLinksFromHtml(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = normalizeText($(a).text());
    const code = extractCodeFromHref(href);
    if (!isValidCode(code)) return;
    if (!text) return;
    items.push({ code, name: text });
  });

  return uniqueBy(items, (x) => x.code);
}

function parseCodesFromRawHtml(html) {
  const found = [];
  const re = /"itemCode"\s*:\s*"(\d{6})"|"stockCode"\s*:\s*"(\d{6})"|code=(\d{6})|\/domestic\/stock\/(\d{6})/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const code = m[1] || m[2] || m[3] || m[4];
    if (isValidCode(code)) found.push(code);
  }
  return uniqueBy(found.map((code) => ({ code, name: '' })), (x) => x.code);
}

async function fetchLegacyThemeList(kind) {
  const url =
    kind === '테마'
      ? `${NAVER_FINANCE_BASE_URL}/sise/theme.naver`
      : `${NAVER_FINANCE_BASE_URL}/sise/sise_group.naver?type=upjong`;

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const rows = [];

  $('table.type_1 tr').each((_, tr) => {
    const link = $(tr).find('a').first();
    const href = link.attr('href') || '';
    const name = normalizeText(link.text());
    if (!name || !href) return;

    if (kind === '테마' && !/theme_detail\.naver/i.test(href)) return;
    if (kind === '업종' && !/sise_group_detail\.naver/i.test(href)) return;

    rows.push({
      type: kind,
      name,
      href: /^https?:\/\//i.test(href) ? href : `${NAVER_FINANCE_BASE_URL}${href}`,
      rank: rows.length + 1
    });
  });

  return rows.slice(0, 12);
}

async function fetchNaverThemeIndustryList(kind) {
  const cacheKey = `rank:${kind}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const rows = await fetchLegacyThemeList(kind);
  return cacheSet(cacheKey, rows, 1000 * 60);
}

async function fetchMemberStocksFromLegacyDetail(url) {
  const html = await fetchHtml(url);
  const parsedLinks = parseStockLinksFromHtml(html);
  if (parsedLinks.length) {
    return uniqueBy(
      parsedLinks.filter((x) => isRealDomesticStockName(x.name || '')),
      (x) => x.code
    ).slice(0, 12);
  }

  const rawCodes = parseCodesFromRawHtml(html).slice(0, 12);
  const filled = await mapLimit(rawCodes, 4, async (item) => {
    try {
      const quote = await fetchKisQuote(item.code, item.name);
      return { code: quote.code, name: quote.name };
    } catch (e) {
      return null;
    }
  });

  return filled.filter(Boolean);
}

async function fetchRankStocksFromNaverStockPage(kind) {
  const url =
    kind === 'volume'
      ? 'https://stock.naver.com/market/stock/kr/stocklist/trading'
      : 'https://stock.naver.com/market/stock/kr/stocklist/priceTop';

  const html = await fetchHtml(url);
  const parsedLinks = parseStockLinksFromHtml(html).filter((x) => isRealDomesticStockName(x.name));

  if (parsedLinks.length >= 10) {
    return uniqueBy(parsedLinks, (x) => x.code).slice(0, 30);
  }

  const rawCodes = parseCodesFromRawHtml(html);
  const filled = await mapLimit(rawCodes.slice(0, 40), 5, async (item) => {
    try {
      const quote = await fetchKisQuote(item.code, item.name);
      if (!isRealDomesticStockName(quote.name)) return null;
      return { code: quote.code, name: quote.name };
    } catch (e) {
      return null;
    }
  });

  return filled.filter(Boolean).slice(0, 30);
}

async function buildLeaderSector(rankItem) {
  const members = await fetchMemberStocksFromLegacyDetail(rankItem.href);
  if (!members.length) return null;

  const quotes = await mapLimit(members, 5, async (member) => {
    try {
      return await fetchKisQuote(member.code, member.name);
    } catch (e) {
      return null;
    }
  });

  const realQuotes = quotes
    .filter(Boolean)
    .filter((x) => isRealDomesticStockName(x.name))
    .sort((a, b) =>
      (b.amount || 0) - (a.amount || 0) ||
      (b.volume || 0) - (a.volume || 0) ||
      (b.changeRate || 0) - (a.changeRate || 0)
    );

  if (!realQuotes.length) return null;

  const totalAmount = realQuotes.reduce((sum, x) => sum + (x.amount || 0), 0);
  const totalVolume = realQuotes.reduce((sum, x) => sum + (x.volume || 0), 0);
  const totalMcap = realQuotes.reduce((sum, x) => sum + (x.marketCapEok || 0), 0);
  const avgRate =
    realQuotes.reduce((sum, x) => sum + (x.changeRate || 0), 0) / realQuotes.length;

  return {
    type: rankItem.type,
    name: rankItem.name,
    sector: rankItem.name,
    reason: `네이버 ${rankItem.type} 순위 기준 · 한투 실종목 거래대금 정렬`,
    chg: formatSignedPct(avgRate),
    volume: formatAmountLabel(totalAmount),
    marketCap: formatMarketCapLabel(totalMcap),
    tradeVolume: totalVolume,
    strength: Math.max(100, Math.round(100 + avgRate * 5)),
    programNet: 1,
    stocks: realQuotes.slice(0, 8).map((x) => ({
      name: x.name,
      code: x.code,
      price: Number(x.price || 0).toLocaleString(),
      chg: formatSignedPct(x.changeRate)
    }))
  };
}

async function buildLeaderPayload() {
  const cached = cacheGet('leaderPayload');
  if (cached) return cached;

  const [themes, industries] = await Promise.all([
    fetchNaverThemeIndustryList('테마'),
    fetchNaverThemeIndustryList('업종')
  ]);

  const all = [
    ...themes.map((x) => ({ ...x, type: '테마' })),
    ...industries.map((x) => ({ ...x, type: '업종' }))
  ];

  const sectors = await mapLimit(all, 4, async (item) => buildLeaderSector(item));

  const payload = {
    categories: {
      테마: themes.map((x) => x.name),
      업종: industries.map((x) => x.name)
    },
    sectors: sectors.filter(Boolean),
    meta: {
      source: 'real',
      updatedAt: nowIso(),
      message: '네이버 순위 + 한국투자증권 종목 시세'
    }
  };

  return cacheSet('leaderPayload', payload, 1000 * 50);
}

async function buildNaverRankedMarket(kind) {
  const cacheKey = `market:${kind}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const seedStocks = await fetchRankStocksFromNaverStockPage(kind);
  const quotes = await mapLimit(seedStocks.slice(0, 30), 5, async (item) => {
    try {
      return await fetchKisQuote(item.code, item.name);
    } catch (e) {
      return null;
    }
  });

  const items = quotes
    .filter(Boolean)
    .filter((x) => isRealDomesticStockName(x.name))
    .sort((a, b) =>
      kind === 'volume'
        ? (b.volume || 0) - (a.volume || 0)
        : (b.amount || 0) - (a.amount || 0)
    )
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
          ? '네이버 거래량 순위 + 한국투자증권 시세'
          : '네이버 거래대금 순위 + 한국투자증권 시세'
    }
  };

  return cacheSet(cacheKey, payload, 1000 * 30);
}

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
    const data = await buildNaverRankedMarket('volume');
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
    const data = await buildNaverRankedMarket('amount');
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
