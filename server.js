const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// 한국투자증권 API 기본 설정
const KIS_BASE_URL = 'https://openapi.koreainvestment.com:9443';
let cachedAccessToken = null;
let tokenExpiry = 0;

// 1. 접근 토큰(Access Token) 발급 및 관리 함수
async function getAccessToken() {
    // 토큰이 있고, 만료 시간이 지나지 않았다면 기존 토큰 재사용 (API 호출 절약)
    if (cachedAccessToken && Date.now() < tokenExpiry) {
        return cachedAccessToken;
    }

    console.log("새로운 KIS Access Token 발급 요청...");
    const response = await fetch(`${KIS_BASE_URL}/oauth2/tokenP`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'client_credentials',
            appkey: process.env.APP_KEY,
            appsecret: process.env.APP_SECRET
        })
    });

    if (!response.ok) throw new Error('토큰 발급 실패');
    
    const data = await response.json();
    cachedAccessToken = data.access_token;
    // 토큰 유효기간(보통 24시간)을 여유있게 23시간으로 설정
    tokenExpiry = Date.now() + (23 * 60 * 60 * 1000); 
    
    return cachedAccessToken;
}

// 2. 단일 종목 현재가 조회 함수
async function fetchStockPrice(code, token) {
    const url = `${KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`;
    const response = await fetch(url, {
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'authorization': `Bearer ${token}`,
            'appkey': process.env.APP_KEY,
            'appsecret': process.env.APP_SECRET,
            'tr_id': 'FHKST01010100' // 현재가 조회 TR ID
        }
    });

    if (!response.ok) throw new Error(`종목코드 ${code} 조회 실패`);
    return await response.json();
}

// 유틸리티 함수: 숫자 포맷팅 (프론트엔드 맞춤형)
const formatChg = (val) => Number(val) > 0 ? `+${val}%` : `${val}%`;
const formatAmt = (val) => {
    const uk = Math.floor(Number(val) / 100000000); // 누적거래대금을 '억' 단위로 변환
    if (uk >= 10000) return `${(uk / 10000).toFixed(1)}조`;
    return `${uk}억`;
};
const formatMcap = (val) => {
    const uk = Number(val); // KIS API hts_avls는 이미 '억' 단위
    if (uk >= 10000) return `${(uk / 10000).toFixed(1)}조`;
    return `${uk}억`;
};

// 프론트엔드에 보여줄 관심 섹터 및 대표 종목 매핑 (원하시는 대로 수정 가능)
const TARGET_SECTORS = [
    { type: '업종', sector: '반도체', name: '삼성전자', code: '005930', reason: '메모리 턴어라운드 기대', subName: 'SK하이닉스' },
    { type: '테마', sector: '2차전지', name: '에코프로', code: '086520', reason: '리튬 가격 반등 수혜', subName: '에코프로비엠' },
    { type: '테마', sector: '바이오', name: '알테오젠', code: '196170', reason: '플랫폼 기술 수출 가속', subName: '삼성바이오로직스' },
    { type: '업종', sector: '자동차', name: '현대차', code: '005380', reason: '주주환원 확대', subName: '기아' },
    { type: '업종', sector: '금융', name: 'KB금융', code: '105560', reason: '밸류업 프로그램 대장주', subName: '신한지주' },
    { type: '테마', sector: '로봇', name: '레인보우로보틱스', code: '277810', reason: '자동화 투자 확대', subName: '두산로보틱스' }
];

// 프론트엔드 연동 API 라우터
app.get('/api/data', async (req, res) => {
    try {
        const token = await getAccessToken();
        const results = [];

        // KIS API 트래픽 제한(Rate Limit)을 피하기 위해 순차적으로 호출
        for (const item of TARGET_SECTORS) {
            try {
                const kisData = await fetchStockPrice(item.code, token);
                const output = kisData.output; // KIS API 핵심 데이터 객체

                // 프론트엔드가 요구하는 JSON 포맷으로 완벽하게 조립
                results.push({
                    type: item.type,
                    name: item.name,
                    sector: item.sector,
                    reason: item.reason,
                    chg: formatChg(output.prdy_ctrt),          // 전일 대비율
                    volume: formatAmt(output.acml_tr_pbmn),    // 누적 거래대금
                    marketCap: formatMcap(output.hts_avls),    // 시가총액
                    roi: formatChg(output.prdy_ctrt),          
                    tradeVolume: Number(output.acml_vol),      // 누적 거래량
                    strength: Number(output.vlnd_cmp_vwcd) || 100, // 체결강도
                    stocks: [
                        { 
                            name: item.name, 
                            price: Number(output.stck_prpr).toLocaleString(), // 콤마 포함 현재가
                            chg: formatChg(output.prdy_ctrt) 
                        },
                        { 
                            name: item.subName, 
                            price: '-', // 보조 종목은 API 호출 절약을 위해 생략
                            chg: '-' 
                        }
                    ]
                });
                
                // API 호출 간 0.1초 딜레이 (초당 10회 제한 방지)
                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (err) {
                console.error(`[${item.name}] 데이터 수집 에러:`, err.message);
                // 에러난 종목은 스킵하고 진행
            }
        }

        // 완성된 객체를 프론트엔드로 전달
        res.json({ sectors: results });

    } catch (error) {
        console.error('전체 데이터 통신 실패:', error);
        res.status(500).json({ error: '서버 내부 오류로 데이터를 가져올 수 없습니다.' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 서버가 포트 ${PORT}에서 정상 작동 중입니다.`);
});
