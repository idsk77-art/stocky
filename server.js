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
const NAVER_BASE_URL = 'https://finance.naver.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let cachedToken = null;
let tokenExpireAt = 0;
let tokenFetchPromise = null;

let leaderCache = { data: null, expireAt: 0 };
let marketCache = { data: null, expireAt: 0 };
const quoteCache = new Map();

// ── KODEX, TIGER 등 ETF/ETN 필터링 ──────────────────────────
const EXCLUDE_PATTERNS = [
  /KODEX/i, /TIGER/i, /KOSEF/i, /KINDEX/i, /KBSTAR/i, /ARIRANG/i, /HANARO/i,
  /ACE/i, /SOL/i, /FOCUS/i, /TIMEFOLIO/i, /TREX/i, /ETF/i, /ETN/i,
  /스팩/, /레버리지/, /인버스/, /선물/, /채권/, /국고채/, /금선물/, /은선물/
];

function isRealDomesticStockName(name) {
  const n = normalizeText(name);
  if (!n) return false;
  return !EXCLUDE_PATTERNS.some((re) => re.test(n));
}

// ── 유틸리티 함수 ─────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  return Number(String(v).replace(/[^0-9.-]/g, '')) || 0;
}
function normalizeText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function formatSignedPct(n) { const v = Number(n || 0); return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`; }
function formatAmountLabel(won) {
  const n = Number(won || 0);
  if (n >= 1_0000_0000_0000) return `${(n / 1_0000_0000_0000).toFixed(1)}조`;
  if (n >= 1_0000_0000) return `${Math.round(n / 1_0000_0000).toLocaleString()}억`;
  return '0억';
}
function formatEokLabel(eok) {
  const n = Number(eok || 0);
  if (n >= 10000) return `${(n / 10000).toFixed(1)}조`;
  if (n >= 1) return `${Math.round(n).toLocaleString()}억`;
  return '0억';
}
function formatPriceText(price) { return Number(price || 0).toLocaleString(); }
function dedupeBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function absUrl(href) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  return `${NAVER_BASE_URL}${href}`;
}
function extractFirstPercent(text) {
  const m = String(text || '').match(/[-+]?\d+(?:\.\d+)?%/);
  return m ? parseFloat(m[0].replace('%', '')) : 0;
}

// 비동기 제한 처리 (API 과부하 방지)
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

// ── KIS API 연동 ─────────────────────────────────────────
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
      try { json = JSON.parse(text); } catch (e) { throw new Error(`토큰 파싱 실패: ${text}`); }

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
  const res = await fetch(url, { method: 'GET', headers: kisHeaders(token, trId) });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch (e) { throw new Error(`KIS 응답 파싱 실패: ${text}`); }
  if (!res.ok) throw new Error(`KIS HTTP ${res.status}: ${text}`);
  if (json.rt_cd && json.rt_cd !== '0') throw new Error(`KIS rt_cd ${json.rt_cd}: ${json.msg1 || text}`);
  return json;
}

// ── KIS API: 특정 종목 현재가 조회 ──────────────────────────
async function fetchKisQuote(code, fallbackName = '') {
  const cached = quoteCache.get(code);
  if (cached && cached.expireAt > Date.now()) return cached.data;

  const data = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-price', { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code }, 'FHKST01010100');
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

// ── KIS API: 거래량 기반 순위 ────────────────────────────
async function fetchVolumeRankBase() {
  const data = await kisGet(
    '/uapi/domestic-stock/v1/quotations/volume-rank',
    {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_COND_SCR_DIV_CODE: '20171',
      FID_INPUT_ISCD: '0000',
      FID_DIV_CLS_CODE: '0',
      FID_BLNG_CLS_CODE: '0',
      FID_TRGT_CLS_CODE: '111111111',
      FID_TRGT_EXLS_CLS_CODE: '000010111', // 우선주, ETF, 스팩, ETN 제외
      FID_INPUT_PRICE_1: '',
      FID_INPUT_PRICE_2: '',
      FID_VOL_CNT: '',
      FID_INPUT_DATE_1: '',
      FID_RANK_SORT_CLS_CODE: '0'
    },
    'FHPST01720000'
  );

  return (data.output || [])
    .map(row => ({
      market: '국내주식',
      code: row.stck_shrn_iscd || row.mksc_shrn_iscd || row.iscd || row.stck_iscd || '',
      name: row.hts_kor_isnm || row.stck_shrn_iscd_name || row.iscd_name || row.prdt_name || '종목명없음',
      price: toNum(row.stck_prpr),
      changeRate: Number(row.prdy_ctrt || 0),
      changeValue: toNum(row.prdy_vrss),
      volume: toNum(row.acml_vol),
      amount: toNum(row.acml_tr_pbmn)
    }))
    .filter((x) => x.code && isRealDomesticStockName(x.name)); // 이름으로 한 번 더 제외
}

async function buildMarketBoard() {
  if (marketCache.data && marketCache.expireAt > Date.now()) return marketCache.data;

  const baseItems = await fetchVolumeRankBase();
  const items = baseItems.filter(Boolean).filter((x) => (x.volume || 0) > 0 || (x.amount || 0) > 0);

  marketCache = { data: items, expireAt: Date.now() + 1000 * 30 };
  return items;
}

// ── 네이버 크롤링 연동 ────────────────────────────────────
async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'referer': NAVER_BASE_URL } });
  if (!res.ok) throw new Error(`네이버 HTML 실패(${res.status}): ${url}`);
  const ab = await res.arrayBuffer();
  const buffer = Buffer.from(ab);
  const contentType = String(res.headers.get('content-type') || '');
  if (/euc-kr|cp949|ms949/i.test(contentType)) return iconv.decode(buffer, 'euc-kr');
  const utf8Text = buffer.toString('utf8');
  if (/charset=["']?(euc-kr|cp949|ms949)/i.test(utf8Text)) return iconv.decode(buffer, 'euc-kr');
  return utf8Text;
}

async function fetchNaverRankList(kind) {
  const url = kind === '테마' ? 'https://finance.naver.com/sise/theme.naver' : 'https://finance.naver.com/sise/sise_group.naver?type=upjong';
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const rows = [];

  $('table.type_1 tr').each((_, tr) => {
    const link = $(tr).find('a').first();
    const href = link.attr('href') || '';
    const name = normalizeText(link.text());
    if (!name || !href) return;

    const isThemeRow = /theme_detail\.naver/i.test(href);
    const isUpjongRow = /sise_group_detail\.naver/i.test(href);

    if (kind === '테마' && !isThemeRow) return;
    if (kind === '업종' && !isUpjongRow) return;

    const rowText = normalizeText($(tr).text());
    const changeRate = extractFirstPercent(rowText);
    rows.push({ type: kind, name, href: absUrl(href), changeRate });
  });

  return dedupeBy(rows, (x) => x.href).slice(0, 15).map((x, i) => ({ ...x, rank: i + 1 }));
}

async function fetchNaverMemberStocks(detailUrl) {
  const html = await fetchHtml(detailUrl);
  const $ = cheerio.load(html);
  const items = [];

  $('table.type_5 tr').each((_, tr) => {
    const link = $(tr).find('a[href*="item/main.naver?code="]').first();
    const href = link.attr('href') || '';
    const name = normalizeText(link.text());
    const codeMatch = href.match(/code=(\d{6})/);

    if (!name || !codeMatch) return;
    if (!isRealDomesticStockName(name)) return; // ETF/ETN 제외
    items.push({ code: codeMatch[1], name });
  });

  return dedupeBy(items, (x) => x.code).slice(0, 8);
}

// 테마 정보와 KIS 시세 데이터 결합
async function buildLeaderSector(rankItem) {
  const members = await fetchNaverMemberStocks(rankItem.href);
  if (!members.length) return null;

  const quotes = await mapLimit(members, 4, async (member) => {
    try { return await fetchKisQuote(member.code, member.name); } 
    catch (e) { return null; }
  });

  const realQuotes = quotes
    .filter(Boolean)
    .filter((x) => isRealDomesticStockName(x.name))
    .sort((a, b) => (b.amount || 0) - (a.amount || 0) || (b.changeRate || 0) - (a.changeRate || 0));

  if (!realQuotes.length) return null;

  const shown = realQuotes.slice(0, 5);
  const totalAmount = shown.reduce((sum, x) => sum + (x.amount || 0), 0);
  const totalVolume = shown.reduce((sum, x) => sum + (x.volume || 0), 0);
  const totalMcapEok = shown.reduce((sum, x) => sum + (x.marketCapEok || 0), 0);

  return {
    type: rankItem.type,
    name: rankItem.name,
    sector: rankItem.name,
    reason: `네이버 ${rankItem.type} ${rankItem.rank}위`,
    chg: formatSignedPct(rankItem.changeRate),
    volume: formatAmountLabel(totalAmount),
    marketCap: formatEokLabel(totalMcapEok),
    tradeVolume: totalVolume,
    strength: 100, // 테마 전체 강도 계산용 (프론트 표시용)
    programNet: 1, // 수급조건 임시 통과
    stocks: shown.map((x) => ({
      name: x.name,
      code: x.code,
      price: formatPriceText(x.price),
      chg: formatSignedPct(x.changeRate)
    }))
  };
}

async function buildLeaderPayload() {
  if (leaderCache.data && leaderCache.expireAt > Date.now()) return leaderCache.data;

  const [themeRanks, upjongRanks] = await Promise.all([
    fetchNaverRankList('테마'),
    fetchNaverRankList('업종')
  ]);

  const allRanks = [
    ...themeRanks.map((x) => ({ ...x, type: '테마' })),
    ...upjongRanks.map((x) => ({ ...x, type: '업종' }))
  ];

  const sectors = await mapLimit(allRanks, 4, async (rankItem) => {
    return await buildLeaderSector(rankItem);
  });

  const payload = {
    categories: {
      테마: themeRanks.map((x) => x.name),
      업종: upjongRanks.map((x) => x.name)
    },
    sectors: sectors.filter(Boolean),
    meta: {
      source: 'real',
      updatedAt: nowIso(),
      message: '네이버 실시간 순위 연동 성공'
    }
  };

  leaderCache = { data: payload, expireAt: Date.now() + 1000 * 60 };
  return payload;
}

// ── API 엔드포인트 ──────────────────────────────────────────
const SAMPLE_VOLUME_ITEMS = [{ market: '국내주식', code: '005930', name: '삼성전자', price: 72000, changeRate: 1.69, changeValue: 1200, volume: 85230000, amount: 6138000000 }];

app.get('/api/data', async (req, res) => {
  try {
    const data = await buildLeaderPayload();
    res.json(data);
  } catch (error) {
    console.error('leader error:', error.message);
    res.json({ categories: { 테마: [], 업종: [] }, sectors: [], meta: { source: 'sample', updatedAt: nowIso(), message: `API 에러: ${error.message}` } });
  }
});

app.get('/api/market/volume-top', async (req, res) => {
  try {
    const items = await buildMarketBoard();
    res.json({
      items: [...items].sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 10),
      meta: { source: 'real', updatedAt: nowIso(), message: '한국투자증권 실시간 연동 (ETF 제외)' }
    });
  } catch (error) {
    console.error('volume-top error:', error.message);
    res.json({ items: SAMPLE_VOLUME_ITEMS, meta: { source: 'sample', updatedAt: nowIso(), message: `API 에러: ${error.message}` } });
  }
});

app.get('/api/market/amount-top', async (req, res) => {
  try {
    const items = await buildMarketBoard();
    res.json({
      items: [...items].sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 10),
      meta: { source: 'real', updatedAt: nowIso(), message: '한국투자증권 실시간 연동 (ETF 제외)' }
    });
  } catch (error) {
    console.error('amount-top error:', error.message);
    res.json({ items: SAMPLE_VOLUME_ITEMS, meta: { source: 'sample', updatedAt: nowIso(), message: `API 에러: ${error.message}` } });
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
