const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const BASE_URL = 'https://openapi.koreainvestment.com:9443';

// ── Access Token 캐싱 (만료 전까지 재사용) ──────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) return cachedToken;

  const res = await fetch(`${BASE_URL}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: process.env.APP_KEY,
      appsecret: process.env.APP_SECRET
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`토큰 발급 실패 ${res.status}: ${txt}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // 만료 22시간 후로 설정 (실제 만료 24시간, 여유 2시간)
  tokenExpiry = now + 22 * 60 * 60 * 1000;
  console.log('✅ Access Token 발급 성공');
  return cachedToken;
}

// ── 공통 헤더 생성 ────────────────────────────────────────────
function makeHeaders(token, trId) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'authorization': `Bearer ${token}`,
    'appkey': process.env.APP_KEY,
    'appsecret': process.env.APP_SECRET,
    'tr_id': trId,
    'custtype': 'P'
  };
}

// ── 거래량 순위 (코스피+코스닥 전체, 상위 30개 병합 → 상위 10) ──
app.get('/api/volume-rank', async (req, res) => {
  try {
    const token = await getAccessToken();

    const makeParams = (mktDiv) => new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: mktDiv,
      FID_COND_SCR_DIV_CODE: '20171',
      FID_INPUT_ISCD: '0000',
      FID_DIV_CLS_CODE: '0',
      FID_BLNG_CLS_CODE: '0',
      FID_TRGT_CLS_CODE: '111111111',
      FID_TRGT_EXLS_CLS_CODE: '000000',
      FID_INPUT_PRICE_1: '',
      FID_INPUT_PRICE_2: '',
      FID_VOL_CNT: '',
      FID_INPUT_DATE_1: ''
    }).toString();

    const headers = makeHeaders(token, 'FHPST01720000');

    const [r1, r2] = await Promise.all([
      fetch(`${BASE_URL}/uapi/domestic-stock/v1/quotations/volume-rank?${makeParams('J')}`, { headers }),
      fetch(`${BASE_URL}/uapi/domestic-stock/v1/quotations/volume-rank?${makeParams('Q')}`, { headers })
    ]);

    const d1 = r1.ok ? await r1.json() : { output: [] };
    const d2 = r2.ok ? await r2.json() : { output: [] };

    const merged = [...(d1.output || []), ...(d2.output || [])];
    merged.sort((a, b) => parseInt(b.acml_vol || 0) - parseInt(a.acml_vol || 0));

    res.json({ output: merged.slice(0, 10) });
  } catch (err) {
    console.error('거래량 순위 오류:', err.message);
    res.json({ output: [] });
  }
});

// ── 거래대금 순위 (코스피+코스닥 전체, 상위 30개 병합 → 상위 10) ─
app.get('/api/amount-rank', async (req, res) => {
  try {
    const token = await getAccessToken();

    const makeParams = (mktDiv) => new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: mktDiv,
      FID_COND_SCR_DIV_CODE: '20171',
      FID_INPUT_ISCD: '0000',
      FID_DIV_CLS_CODE: '0',
      FID_BLNG_CLS_CODE: '0',
      FID_TRGT_CLS_CODE: '111111111',
      FID_TRGT_EXLS_CLS_CODE: '000000',
      FID_INPUT_PRICE_1: '',
      FID_INPUT_PRICE_2: '',
      FID_VOL_CNT: '',
      FID_INPUT_DATE_1: ''
    }).toString();

    const headers = makeHeaders(token, 'FHPST01720000');

    const [r1, r2] = await Promise.all([
      fetch(`${BASE_URL}/uapi/domestic-stock/v1/quotations/volume-rank?${makeParams('J')}`, { headers }),
      fetch(`${BASE_URL}/uapi/domestic-stock/v1/quotations/volume-rank?${makeParams('Q')}`, { headers })
    ]);

    const d1 = r1.ok ? await r1.json() : { output: [] };
    const d2 = r2.ok ? await r2.json() : { output: [] };

    const merged = [...(d1.output || []), ...(d2.output || [])];
    // 거래대금(acml_tr_pbmn) 기준 정렬
    merged.sort((a, b) => parseInt(b.acml_tr_pbmn || 0) - parseInt(a.acml_tr_pbmn || 0));

    res.json({ output: merged.slice(0, 10) });
  } catch (err) {
    console.error('거래대금 순위 오류:', err.message);
    res.json({ output: [] });
  }
});

// ── 기존 주도섹터 데이터 (에러 시 빈 배열 반환으로 수정) ────────
app.get('/api/data', async (req, res) => {
  try {
    const token = await getAccessToken();
    const apiUrl = `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=005930`;

    const response = await fetch(apiUrl, {
      headers: makeHeaders(token, 'FHKST01010100')
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`한투 API 에러 ${response.status}:`, errText);
      return res.json({ sectors: [] });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('데이터 통신 실패:', error.message);
    res.json({ sectors: [] });
  }
});

app.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 정상 작동 중입니다.`);
});
