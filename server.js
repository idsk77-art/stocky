const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 모의투자/실전투자 도메인 환경변수로 설정 가능 (기본값: 실전투자)
const KIS_BASE_URL = process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';

// ── Access Token 캐싱 ─────────────────────────────────────────
let cachedToken = null;
let tokenExpireAt = 0;

function nowIso() {
  return new Date().toISOString();
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  return Number(String(v).replace(/[^0-9.-]/g, '')) || 0;
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpireAt) return cachedToken;

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
    throw new Error(`토큰 응답 파싱 실패: ${text}`);
  }

  // 1분당 1회 제한 에러(EGW00133) 발생 시, 기존 캐시가 있다면 그걸 반환
  if (!res.ok || !json.access_token) {
    if (json.error_code === 'EGW00133' && cachedToken) {
      console.log('토큰 1분 제한 걸림, 기존 캐시된 토큰 재사용');
      return cachedToken;
    }
    throw new Error(`토큰 발급 실패(${res.status}): ${text}`);
  }

  cachedToken = json.access_token;
  tokenExpireAt = now + 1000 * 60 * 60 * 20; // 20시간 후 만료 (원래 만료시간 24시간)
  return cachedToken;
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

// ── KIS API 호출 공통 함수 ────────────────────────────────────
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

  if (!res.ok) {
    throw new Error(`KIS HTTP ${res.status}: ${text}`);
  }

  if (json.rt_cd && json.rt_cd !== '0') {
    throw new Error(`KIS rt_cd ${json.rt_cd}: ${json.msg1 || text}`);
  }

  return json;
}

// ── 종목 데이터 정규화 ─────────────────────────────────────────
function normalizeRankItem(row, market) {
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

// ── 거래량/거래대금 데이터 조회 (코스피 + 코스닥 병합) ──────────
async function fetchMergedVolumeRank() {
  // 에러 발생했던 누락 필드(FID_RANK_SORT_CLS_CODE) 추가 완료
  const commonParams = {
    FID_COND_SCR_DIV_CODE: '20171',
    FID_INPUT_ISCD: '0000',
    FID_DIV_CLS_CODE: '0',
    FID_BLNG_CLS_CODE: '0',
    FID_TRGT_CLS_CODE: '111111111',
    FID_TRGT_EXLS_CLS_CODE: '000000',
    FID_INPUT_PRICE_1: '',
    FID_INPUT_PRICE_2: '',
    FID_VOL_CNT: '',
    FID_INPUT_DATE_1: '',
    FID_RANK_SORT_CLS_CODE: '0' // 0: 거래량 순 (이 파라미터가 빠져서 에러가 났음)
  };

  // KOSPI(J), KOSDAQ(Q) 각각 호출
  const [kospi, kosdaq] = await Promise.all([
    kisGet(
      '/uapi/domestic-stock/v1/quotations/volume-rank',
      { ...commonParams, FID_COND_MRKT_DIV_CODE: 'J' },
      'FHPST01720000'
    ),
    kisGet(
      '/uapi/domestic-stock/v1/quotations/volume-rank',
      { ...commonParams, FID_COND_MRKT_DIV_CODE: 'Q' },
      'FHPST01720000'
    )
  ]);

  const merged = [
    ...((kospi.output || []).map((x) => normalizeRankItem(x, 'KOSPI'))),
    ...((kosdaq.output || []).map((x) => normalizeRankItem(x, 'KOSDAQ')))
  ].filter((x) => x.name && (x.volume > 0 || x.amount > 0));

  return {
    updatedAt: nowIso(),
    items: merged
  };
}

// ── 샘플 데이터 (폴백용) ───────────────────────────────────────
const SAMPLE_LEADER_DATA = {
  categories: {
    테마: ['MLCC', '2차전지', '로봇', '바이오', 'AI', '우주항공', '원전', '신재생', '보안', '초전도체'],
    업종: ['반도체', '자동차', '금융', '제약', '철강', '통신', '화학', '조선', '건설', 'IT소프트웨어']
  },
  sectors: [
    {
      type: '테마', name: '삼화콘덴서', sector: 'MLCC', reason: 'AI/전장용 수요 급증', chg: '+29.9%', volume: '5,362억', marketCap: '1.6조', roi: '+29.9%', tradeVolume: 5362000, strength: 150, programNet: 120000,
      stocks: [ { name: '삼화콘덴서', price: '102,000', chg: '+29.9%' }, { name: '아비코전자', price: '11,900', chg: '+8.1%' } ]
    },
    {
      type: '업종', name: '삼성전자', sector: '반도체', reason: '메모리 턴어라운드', chg: '+9.7%', volume: '12.5조', marketCap: '458조', roi: '+1.8%', tradeVolume: 15000000, strength: 125, programNet: 920000,
      stocks: [ { name: '삼성전자', price: '72,000', chg: '+1.8%' }, { name: 'SK하이닉스', price: '168,000', chg: '+2.3%' } ]
    }
  ]
};

const SAMPLE_VOLUME_ITEMS = [
  { market: 'KOSPI', code: '005930', name: '삼성전자', price: 72000, changeRate: 1.69, changeValue: 1200, changeSign: '2', volume: 85230000, amount: 6138000000 },
  { market: 'KOSDAQ', code: '247540', name: '에코프로비엠', price: 238000, changeRate: 2.15, changeValue: 5000, changeSign: '2', volume: 31200000, amount: 7425600000 }
];

const SAMPLE_AMOUNT_ITEMS = [
  { market: 'KOSPI', code: '005490', name: 'POSCO홀딩스', price: 380000, changeRate: 2.15, changeValue: 8000, changeSign: '2', volume: 42100000, amount: 15998000000 },
  { market: 'KOSPI', code: '373220', name: 'LG에너지솔루션', price: 398000, changeRate: 1.79, changeValue: 7000, changeSign: '2', volume: 17500000, amount: 6965000000 }
];

// ── API 라우터 ───────────────────────────────────────────────

app.get('/api/data', async (req, res) => {
  res.json({
    ...SAMPLE_LEADER_DATA,
    meta: {
      source: 'sample',
      updatedAt: nowIso(),
      message: '주도섹터는 현재 서버 샘플 규칙 데이터입니다.'
    }
  });
});

app.get('/api/market/volume-top', async (req, res) => {
  try {
    const merged = await fetchMergedVolumeRank();
    const items = [...merged.items]
      .sort((a, b) => b.volume - a.volume) // 거래량 기준 정렬
      .slice(0, 10); // 상위 10개 자르기

    res.json({
      items,
      meta: {
        source: 'real',
        updatedAt: merged.updatedAt,
        message: '한국투자증권 실시간 연동 성공'
      }
    });
  } catch (error) {
    console.error('volume-top error:', error.message);
    res.json({
      items: SAMPLE_VOLUME_ITEMS,
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
    const merged = await fetchMergedVolumeRank();
    const items = [...merged.items]
      .sort((a, b) => b.amount - a.amount) // 거래대금 기준 정렬
      .slice(0, 10); // 상위 10개 자르기

    res.json({
      items,
      meta: {
        source: 'real',
        updatedAt: merged.updatedAt,
        message: '한국투자증권 실시간 연동 성공'
      }
    });
  } catch (error) {
    console.error('amount-top error:', error.message);
    res.json({
      items: SAMPLE_AMOUNT_ITEMS,
      meta: {
        source: 'sample',
        updatedAt: nowIso(),
        message: `API 에러: ${error.message}`
      }
    });
  }
});

app.get('/api/health', async (req, res) => {
  res.json({ ok: true, updatedAt: nowIso() });
});

app.listen(PORT, () => {
  console.log(`server listening on ${PORT}`);
});
