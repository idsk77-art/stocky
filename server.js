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
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let cachedToken = null;
let tokenExpireAt = 0;
let tokenFetchPromise = null;

// 네이버 테마 데이터를 30초마다 갱신하여 저장할 전역 변수
let globalNaverThemes = []; 

const quoteCache = new Map();
const dataCache = new Map();

const EXCLUDE_PATTERNS = [
  /KODEX/i, /TIGER/i, /KOSEF/i, /KINDEX/i, /KBSTAR/i, /ARIRANG/i, /HANARO/i,
  /ACE/i, /SOL/i, /TIMEFOLIO/i, /TREX/i, /ETF/i, /ETN/i, /스팩/,
  /레버리지/, /인버스/, /선물/, /채권/, /국고채/
];

function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function normalizeText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function toNum(v) { return Number(String(v).replace(/[^0-9.-]/g, '')) || 0; }
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

// ----------------------------------------------------
// 1. 한국투자증권 API 통신부
// ----------------------------------------------------
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
      tokenExpireAt = now + 1000 * 60 * 60 * 20; // 20시간
      return cachedToken;
    } finally {
      tokenFetchPromise = null;
    }
  })();
  return tokenFetchPromise;
}

async function kisGet(pathname, params, trId) {
  const token = await getAccessToken();
  const url = `${KIS_BASE_URL}${pathname}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, { 
    method: 'GET', 
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: process.env.APP_KEY,
      appsecret: process.env.APP_SECRET,
      tr_id: trId,
      custtype: 'P'
    } 
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch (e) {}
  if (!res.ok) throw new Error(`KIS HTTP ${res.status}`);
  return json;
}

async function fetchKisQuote(code, fallbackName = '') {
  const cached = cacheGet(quoteCache, code);
  if (cached) return cached;

  const data = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-price', { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code }, 'FHKST01010100');
  const out = data.output || {};
  const item = {
    code,
    name: out.hts_kor_isnm || fallbackName || code,
    price: toNum(out.stck_prpr),
    changeRate: Number(out.prdy_ctrt || 0),
    changeValue: toNum(out.prdy_vrss),
    volume: toNum(out.acml_vol),
    amount: toNum(out.acml_tr_pbmn),
    marketCapEok: toNum(out.hts_avls)
  };
  return cacheSet(quoteCache, code, item, 1000 * 20); // 20초 단기 캐시
}


// ----------------------------------------------------
// 2. 네이버 크롤링 백그라운드 워커 (30초마다 갱신)
// ----------------------------------------------------
async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'referer': NAVER_FINANCE_BASE } });
  if (!res.ok) throw new Error(`HTML fetch 실패(${res.status})`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = String(res.headers.get('content-type') || '');
  if (/euc-kr|cp949|ms949/i.test(contentType) || /charset=["']?(euc-kr|cp949|ms949)/i.test(buffer.toString('utf8'))) {
    return iconv.decode(buffer, 'euc-kr');
  }
  return buffer.toString('utf8');
}

async function updateNaverThemesBackground() {
  try {
    const html = await fetchHtml(`${NAVER_FINANCE_BASE}/sise/theme.naver`);
    const $ = cheerio.load(html);
    const themes = [];

    $('table.type_1 tr').each((_, tr) => {
      const $a = $(tr).find('td.col_type1 a');
      if ($a.length > 0) {
        const href = $a.attr('href') || '';
        const name = normalizeText($a.text());
        if (name && href) themes.push({ name, href: `${NAVER_FINANCE_BASE}${href}` });
      }
    });

    const topThemes = themes.slice(0, 10); // 상위 10개 테마 추출

    // 각 테마별 구성 종목 크롤링
    for (let t of topThemes) {
      const detailHtml = await fetchHtml(t.href);
      const $detail = cheerio.load(detailHtml);
      const members = [];
      $detail('table.type_5 tbody tr').each((_, tr) => {
        const $a = $detail(tr).find('td.name div.name_area a');
        if ($a.length > 0) {
          const m = ($a.attr('href') || '').match(/code=(\d{6})/);
          const name = normalizeText($a.text());
          if (m && isRealDomesticStockName(name)) members.push({ code: m[1], name });
        }
      });
      t.members = uniqueBy(members, (x) => x.code).slice(0, 15);
      await sleep(150); // 서버 부하 방지
    }

    globalNaverThemes = topThemes;
    console.log(`[Background] 네이버 테마 갱신 완료 (${new Date().toLocaleTimeString()})`);
  } catch (e) {
    console.error(`[Background] 네이버 갱신 에러: ${e.message}`);
  }
}


// ----------------------------------------------------
// 3. 클라이언트 API 로직 (한투 실시간 시세 연동)
// ----------------------------------------------------
async function buildLeaderPayload() {
  if (!globalNaverThemes || globalNaverThemes.length === 0) {
    throw new Error('네이버 데이터 로딩 중입니다.');
  }

  // 캐싱된 네이버 테마 리스트를 기반으로 한투 실시간 시세 조회
  const sectors = await mapLimit(globalNaverThemes, 4, async (theme) => {
    if (!theme.members || !theme.members.length) return null;

    const quotes = await mapLimit(theme.members, 5, async (member) => {
      try { return await fetchKisQuote(member.code, member.name); } catch (e) { return null; }
    });

    let realQuotes = quotes.filter(Boolean);
    if (!realQuotes.length) return null;

    // 테마 내 종목들을 거래량 순으로 내림차순 정렬
    realQuotes.sort((a, b) => (b.volume || 0) - (a.volume || 0));

    const totalAmount = realQuotes.reduce((sum, x) => sum + (x.amount || 0), 0);
    const avgRate = realQuotes.reduce((sum, x) => sum + (x.changeRate || 0), 0) / realQuotes.length;

    return {
      name: theme.name,
      reason: `네이버 테마 랭킹 · 한투 실시간 거래량 순 정렬`,
      chg: formatSignedPct(avgRate),
      volume: formatAmountLabel(totalAmount),
      stocks: realQuotes.slice(0, 10).map((x) => ({
        code: x.code,
        name: x.name,
        price: Number(x.price || 0).toLocaleString(),
        changeRate: x.changeRate,
        changeValue: x.changeValue,
        volume: x.volume,
        amount: x.amount
      }))
    };
  });

  return {
    categories: globalNaverThemes.map((x) => x.name),
    sectors: sectors.filter(Boolean),
    meta: { source: 'real', updatedAt: nowIso(), message: '정상 데이터 연동' }
  };
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
  }).slice(0, 10);

  const payload = { items, meta: { source: 'real', updatedAt: nowIso() } };
  return cacheSet(dataCache, key, payload, 1000 * 20);
}


// --- 라우트 ---
app.get('/', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  res.status(404).send('public/index.html not found');
});

app.get('/api/data', async (req, res) => {
  try { res.json(await buildLeaderPayload()); } 
  catch (error) { res.json({ categories: [], sectors: [], meta: { source: 'sample', message: `대기중: ${error.message}` }}); }
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
  try { 
    await getAccessToken(); 
    console.log('KIS token ready'); 
    
    // 서버 시작 시 네이버 크롤링 최초 1회 실행 후 30초 간격 무한 반복
    await updateNaverThemesBackground();
    setInterval(updateNaverThemesBackground, 30000);

  } catch (err) { console.error('초기 설정 실패:', err.message); }
});
