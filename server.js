const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const KIS_BASE_URL = process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';

// ── Access Token 관리 ─────────────────────────────────────────
let cachedToken = null;
let tokenExpireAt = 0;
let tokenFetchPromise = null;

function nowIso() { return new Date().toISOString(); }
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  return Number(String(v).replace(/[^0-9.-]/g, '')) || 0;
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
      try { json = JSON.parse(text); } catch (e) { throw new Error(`토큰 파싱 실패: ${text}`); }

      if (!res.ok || !json.access_token) {
        if (json.error_code === 'EGW00133' && cachedToken) {
          console.log('토큰 1분 제한 걸림, 기존 캐시 반환');
          return cachedToken;
        }
        throw new Error(`토큰 발급 실패(${res.status}): ${text}`);
      }

      cachedToken = json.access_token;
      tokenExpireAt = now + 1000 * 60 * 60 * 20;
      console.log('✅ Access Token 신규 발급 완료');
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
  try { json = JSON.parse(text); } catch (e) { throw new Error(`KIS 응답 파싱 실패: ${text}`); }

  if (!res.ok) throw new Error(`KIS HTTP ${res.status}: ${text}`);
  if (json.rt_cd && json.rt_cd !== '0') throw new Error(`KIS rt_cd ${json.rt_cd}: ${json.msg1 || text}`);

  return json;
}

function normalizeRankItem(row) {
  // 응답 데이터 포맷에 맞춰 유연하게 파싱
  const market = row.stck_shrn_iscd ? (row.stck_shrn_iscd.startsWith('0') ? 'KOSPI' : 'KOSDAQ') : '국내주식';
  return {
    market,
    code: row.stck_shrn_iscd || row.mksc_shrn_iscd || row.iscd || row.stck_iscd || '',
    name: row.hts_kor_isnm || row.stck_shrn_iscd_name || row.iscd_name || row.prdt_name || '종목명없음',
    price: toNum(row.stck_prpr),
    changeRate: Number(row.prdy_ctrt || 0),
    changeValue: toNum(row.prdy_vrss),
    changeSign: row.prdy_vrss_sign || '3',
    volume: toNum(row.acml_vol),
    amount: toNum(row.acml_tr_pbmn),
    raw: row
  };
}

// ── 거래량 순위 단일 호출 (J 시장구분 하나만 사용, ETF/ETN/스팩 제외) ──
async function fetchMergedVolumeRank() {
  const commonParams = {
    FID_COND_MRKT_DIV_CODE: 'J', 
    FID_COND_SCR_DIV_CODE: '20171',
    FID_INPUT_ISCD: '0000',
    FID_DIV_CLS_CODE: '0',
    FID_BLNG_CLS_CODE: '0',
    FID_TRGT_CLS_CODE: '111111111', 
    // 투자주의/경고, 관리, 정리매매, 불성실, 우선주, 거래정지, ETF, 스팩, ETN 등을 제외 (1: 제외)
    // 000000 -> 제외 안함 이었음.
    // 투자위험/경고/주의, 관리, 정리매매, 불성실, 우선주, 거래정지, ETF, 스팩, ETN, 선박/투자회사 등등 상세 제외
    // 한국투자증권 API 스펙에 따라 우선주(5번째), ETF(7번째), 스팩(8번째), ETN(9번째) 제외
    // 0:포함, 1:제외. '000010111' 
    FID_TRGT_EXLS_CLS_CODE: '000010111', // 우선주, ETF, 스팩, ETN 제외
    FID_INPUT_PRICE_1: '',
    FID_INPUT_PRICE_2: '',
    FID_VOL_CNT: '',
    FID_INPUT_DATE_1: '',
    FID_RANK_SORT_CLS_CODE: '0'
  };

  const response = await kisGet(
    '/uapi/domestic-stock/v1/quotations/volume-rank',
    commonParams,
    'FHPST01720000'
  );

  let items = (response.output || [])
    .map(x => normalizeRankItem(x))
    .filter(x => x.name && (x.volume > 0 || x.amount > 0));
    
  // 안전장치: 혹시라도 파라미터 제외가 제대로 안 먹힐 경우를 대비해 이름으로 한번 더 필터링
  items = items.filter(x => {
    const n = x.name;
    return !n.includes('KODEX') && !n.includes('TIGER') && !n.includes('KINDEX') && 
           !n.includes('KBSTAR') && !n.includes('ARIRANG') && !n.includes('KOSEF') && 
           !n.includes('HANARO') && !n.includes('ACE') && !n.includes('스팩') &&
           !n.includes('선물인버스') && !n.includes('레버리지');
  });

  return { updatedAt: nowIso(), items };
}

// 샘플 데이터
const SAMPLE_LEADER_DATA = {
  categories: { 테마: ['MLCC', '2차전지', '로봇', '바이오'], 업종: ['반도체', '자동차'] },
  sectors: [
    { type: '테마', name: '삼화콘덴서', sector: 'MLCC', reason: 'AI/전장용 수요 급증', chg: '+29.9%', volume: '5,362억', marketCap: '1.6조', tradeVolume: 5362000, strength: 150, programNet: 120000, stocks: [{ name: '삼화콘덴서', price: '102,000', chg: '+29.9%' }] },
    { type: '테마', name: '에코프로', sector: '2차전지', reason: 'ESS·리사이클 기대', chg: '+8.5%', volume: '8.7조', marketCap: '38조', tradeVolume: 12000000, strength: 120, programNet: 320000, stocks: [{ name: '에코프로', price: '121,000', chg: '+12.5%' }] }
  ]
};
const SAMPLE_VOLUME_ITEMS = [ { market: 'KOSPI', code: '005930', name: '삼성전자', price: 72000, changeRate: 1.69, changeValue: 1200, volume: 85230000, amount: 6138000000 } ];
const SAMPLE_AMOUNT_ITEMS = [ { market: 'KOSPI', code: '005490', name: 'POSCO홀딩스', price: 380000, changeRate: 2.15, changeValue: 8000, volume: 42100000, amount: 15998000000 } ];

app.get('/api/data', async (req, res) => {
  res.json({ ...SAMPLE_LEADER_DATA, meta: { source: 'sample', updatedAt: nowIso(), message: '주도섹터 샘플 규칙' } });
});

app.get('/api/market/volume-top', async (req, res) => {
  try {
    const merged = await fetchMergedVolumeRank();
    const items = [...merged.items].sort((a, b) => b.volume - a.volume).slice(0, 10);
    res.json({ items, meta: { source: 'real', updatedAt: merged.updatedAt, message: '실시간 연동 성공' } });
  } catch (error) {
    console.error('volume-top error:', error.message);
    res.json({ items: SAMPLE_VOLUME_ITEMS, meta: { source: 'sample', updatedAt: nowIso(), message: `API 에러: ${error.message}` } });
  }
});

app.get('/api/market/amount-top', async (req, res) => {
  try {
    const merged = await fetchMergedVolumeRank();
    const items = [...merged.items].sort((a, b) => b.amount - a.amount).slice(0, 10);
    res.json({ items, meta: { source: 'real', updatedAt: merged.updatedAt, message: '실시간 연동 성공' } });
  } catch (error) {
    console.error('amount-top error:', error.message);
    res.json({ items: SAMPLE_AMOUNT_ITEMS, meta: { source: 'sample', updatedAt: nowIso(), message: `API 에러: ${error.message}` } });
  }
});

app.listen(PORT, async () => {
  console.log(`server listening on ${PORT}`);
  try {
    await getAccessToken();
  } catch (err) {
    console.error("초기 토큰 발급 실패 (앱키 확인 필요):", err.message);
  }
});
