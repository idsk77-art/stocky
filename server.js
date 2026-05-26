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
    // 토큰 유효기간을 여유있게 23시간으로 설정
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
            'tr_id': 'FHKST01010100' 
        }
    });

    if (!response.ok) throw new Error(`종목코드 ${code} 조회 실패`);
    return await response.json();
}

// 유틸리티 함수: 숫자 포맷팅 (프론트엔드 맞춤형)
const formatChg = (val) => Number(val) > 0 ? `+${val}%` : `${val}%`;
const formatAmt = (val) => {
    const uk = Math.floor(Number(val) / 100000000); // 억 단위
    if (uk >= 10000) return `${(uk / 10000).toFixed(1)}조`;
    return `${uk}억`;
};
const formatMcap = (val) => {
    const uk = Number(val); // hts_avls는 이미 억 단위
    if (uk >= 10000) return `${(uk / 10000).toFixed(1)}조`;
    return `${uk}억`;
};

// 프론트엔드에 보여줄 관심 섹터 및 종목 매핑 (원하는 코드로 수정 가능)
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
                const output = kisData.output; 

                // 프론트엔드가 요구하는 JSON 포맷 조립
                results.push({
                    type: item.type,
                    name: item.name,
                    sector: item.sector,
                    reason: item.reason,
                    chg: formatChg(output.prdy_ctrt),          
                    volume: formatAmt(output.acml_tr_pbmn),    
                    marketCap: formatMcap(output.hts_avls),    
                    roi: formatChg(output.prdy_ctrt),          
                    tradeVolume: Number(output.acml_vol),      
                    strength: Number(output.vlnd_cmp_vwcd) || 100, 
                    stocks: [
                        { name: item.name, price: Number(output.stck_prpr).toLocaleString(), chg: formatChg(output.prdy_ctrt) },
                        { name: item.subName, price: '-', chg: '-' }
                    ]
                });
                
                // API 호출 간 0.1초 딜레이 (초당 10회 제한 방지)
                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (err) {
                console.error(`[${item.name}] 데이터 수집 에러:`, err.message);
                // 에러난 종목은 스킵
            }
        }

        // 🌟 수정된 부분: 한국투자증권 데이터 조회가 끝난 정확한 실제 시간
        const serverTime = new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });

        res.json({ 
            sectors: results,
            categories: {
                '테마': ['2차전지','로봇','바이오','AI','우주항공','원전'],
                '업종': ['반도체','자동차','금융','제약']
            },
            timestamp: serverTime 
        });

    } catch (error) {
        console.error('전체 데이터 통신 실패:', error);
        res.status(500).json({ error: '서버 내부 오류로 데이터를 가져올 수 없습니다.' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 서버가 포트 ${PORT}에서 정상 작동 중입니다.`);
});    cachedAccessToken = data.access_token;
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
                const output = kisData.output;

                results.push({
                    type: item.type,
                    name: item.name,
                    sector: item.sector,
                    reason: item.reason,
                    chg: formatChg(output.prdy_ctrt),
                    volume: formatAmt(output.acml_tr_pbmn),
                    marketCap: formatMcap(output.hts_avls),
                    roi: formatChg(output.prdy_ctrt),          
                    tradeVolume: Number(output.acml_vol),
                    strength: Number(output.vlnd_cmp_vwcd) || 100,
                    stocks: [
                        { name: item.name, price: Number(output.stck_prpr).toLocaleString(), chg: formatChg(output.prdy_ctrt) },
                        { name: item.subName, price: '-', chg: '-' }
                    ]
                });
                
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (err) {
                console.error(`[${item.name}] 데이터 수집 에러:`, err.message);
            }
        }

        // 🌟 수정된 부분: 한국 시간 기준으로 통신이 끝난 정확한 시간을 함께 보냅니다.
        const serverTime = new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
        
        res.json({ 
            sectors: results, 
            timestamp: serverTime // 실제 갱신 시간 추가
        });

    } catch (error) {
        console.error('전체 데이터 통신 실패:', error);
        res.status(500).json({ error: '서버 내부 오류로 데이터를 가져올 수 없습니다.' });
    }
});
