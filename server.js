const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ── 기존: 주도섹터 데이터 ──────────────────────────────────
app.get('/api/data', async (req, res) => {
  try {
    const baseUrl = 'https://openapi.koreainvestment.com:9443';
    const apiUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=005930`;

    const response = await fetch(apiUrl, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'appkey':    process.env.APP_KEY,
        'appsecret': process.env.APP_SECRET,
        'tr_id':     'FHKST01010100'
      }
    });

    // ✅ 500 등 에러 발생 시 상세 로그 출력 후 빈 sectors 반환
    if (!response.ok) {
      const errText = await response.text();
      console.error(`한투 API 에러 ${response.status}:`, errText);
      // 앱이 멈추지 않도록 빈 데이터 반환 (프론트에서 샘플로 폴백)
      return res.json({ sectors: [] });
    }

    const data = await response.json();
    res.json(data);

  } catch (error) {
    console.error('데이터 통신 실패:', error);
    // ✅ 예외 발생 시도 500 대신 빈 데이터 반환
    res.json({ sectors: [] });
  }
});

// ── 신규: 거래량 순위 TOP10 (전체 시장, 필터 없음) ──────────
app.get('/api/volume-rank', async (req, res) => {
  try {
    const baseUrl = 'https://openapi.koreainvestment.com:9443';
    // FID_COND_MRKT_DIV_CODE=J(코스피)+Q(코스닥) 전체 조회
    // FHPST01720000 = 거래량 순위 조회 tr_id
    const params = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: 'J',  // J=코스피, Q=코스닥 → 둘 다 각각 호출 후 병합
      FID_COND_SCR_DIV_CODE: '20171',
      FID_INPUT_ISCD: '0000',        // 전체
      FID_DIV_CLS_CODE: '0',
      FID_BLNG_CLS_CODE: '0',
      FID_TRGT_CLS_CODE: '111111111',
      FID_TRGT_EXLS_CLS_CODE: '000000',
      FID_INPUT_PRICE_1: '',
      FID_INPUT_PRICE_2: '',
      FID_VOL_CNT: '',
      FID_INPUT_DATE_1: ''
    });

    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'appkey': process.env.APP_KEY,
      'appsecret': process.env.APP_SECRET,
      'tr_id': 'FHPST01720000',
      'custtype': 'P'
    };

    // 코스피 + 코스닥 각각 호출
    const [kospiRes, kosdaqRes] = await Promise.all([
      fetch(`${baseUrl}/uapi/domestic-stock/v1/ranking/volume?${params.toString()}`, { headers }),
      fetch(`${baseUrl}/uapi/domestic-stock/v1/ranking/volume?${params.toString().replace('DIV_CODE=J','DIV_CODE=Q')}`, { headers })
    ]);

    const kospiData = kospiRes.ok ? await kospiRes.json() : { output: [] };
    const kosdaqData = kosdaqRes.ok ? await kosdaqRes.json() : { output: [] };

    const merged = [
      ...(kospiData.output || []),
      ...(kosdaqData.output || [])
    ];

    // 거래량 내림차순 정렬 후 TOP10
    merged.sort((a, b) => parseInt(b.acml_vol || 0) - parseInt(a.acml_vol || 0));
    const top10 = merged.slice(0, 10);

    res.json({ output: top10 });
  } catch (error) {
    console.error('거래량 순위 통신 실패:', error);
    res.status(500).json({ error: '거래량 순위 통신 실패' });
  }
});

// ── 신규: 거래대금 순위 TOP10 (전체 시장, 필터 없음) ─────────
app.get('/api/amount-rank', async (req, res) => {
  try {
    const baseUrl = 'https://openapi.koreainvestment.com:9443';
    // FHPST01730000 = 거래대금 순위 조회 tr_id
    const makeParams = (mktDiv) => new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: mktDiv,
      FID_COND_SCR_DIV_CODE: '20172',
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

    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'appkey': process.env.APP_KEY,
      'appsecret': process.env.APP_SECRET,
      'tr_id': 'FHPST01730000',
      'custtype': 'P'
    };

    const [kospiRes, kosdaqRes] = await Promise.all([
      fetch(`${baseUrl}/uapi/domestic-stock/v1/ranking/trading-volume?${makeParams('J')}`, { headers }),
      fetch(`${baseUrl}/uapi/domestic-stock/v1/ranking/trading-volume?${makeParams('Q')}`, { headers })
    ]);

    const kospiData = kospiRes.ok ? await kospiRes.json() : { output: [] };
    const kosdaqData = kosdaqRes.ok ? await kosdaqRes.json() : { output: [] };

    const merged = [
      ...(kospiData.output || []),
      ...(kosdaqData.output || [])
    ];

    // 거래대금 내림차순 정렬 후 TOP10
    merged.sort((a, b) => parseInt(b.acml_tr_pbmn || 0) - parseInt(a.acml_tr_pbmn || 0));
    const top10 = merged.slice(0, 10);

    res.json({ output: top10 });
  } catch (error) {
    console.error('거래대금 순위 통신 실패:', error);
    res.status(500).json({ error: '거래대금 순위 통신 실패' });
  }
});

app.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 정상 작동 중입니다.`);
});
