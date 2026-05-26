const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const KIS_BASE_URL = 'https://openapi.koreainvestment.com:9443';
let cachedAccessToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
    if (cachedAccessToken && Date.now() < tokenExpiry) return cachedAccessToken;

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
    tokenExpiry = Date.now() + (23 * 60 * 60 * 1000); 
    return cachedAccessToken;
}

// 1. 단일 종목 현재가 (기존 주도섹터용)
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

// 2. 진짜 시장 전체 거래량 상위 (새로 추가)
async function fetchMarketVolumeRank(token) {
    const params = new URLSearchParams({
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_COND_SCR_DIV_CODE: '20171',
        FID_INPUT_ISCD: '0000', 
        FID_DIV_CLS_CODE: '0', 
        FID_BLNG_CLS_CODE: '0', 
        FID_TRGT_CLS_CODE: '1', 
        FID_TRGT_EXLS_CLS_CODE: '0', 
        FID_INPUT_PRICE_1: '', 
        FID_INPUT_PRICE_2: '', 
        FID_VOL_CNT: '', 
        FID_INPUT_DATE_1: ''
    });

    const url = `${KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/volume-rank?${params.toString()}`;
    const response = await fetch(url, {
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'authorization': `Bearer ${token}`,
            'appkey': process.env.APP_KEY,
            'appsecret': process.env.APP_SECRET,
            'tr_id': 'FHPST01710000',
            'custtype': 'P'
        }
    });
    if (!response.ok) throw new Error(`시장 순위 API 실패 (${response.status})`);
    return await response.json();
}

const formatChg = (val) => Number(val) > 0 ? `+${val}%` : `${val}%`;
const formatAmt = (val) => {
    const uk = Math.floor(Number(val) / 100000000); 
    if (uk >= 10000) return `${(uk / 10000).toFixed(1)}조`;
    return `${uk}억`;
};
const formatMcap = (val) => {
    const uk = Number(val); 
    if (uk >= 10000) return `${(uk / 10000).toFixed(1)}조`;
    return `${uk}억`;
};

// 사용자가 추적하는 주도섹터 목록
const TARGET_SECTORS = [
    { type: '업종', sector: '반도체', name: '삼성전자', code: '005930', reason: '메모리 턴어라운드 기대', subName: 'SK하이닉스' },
    { type: '테마', sector: '2차전지', name: '에코프로', code: '086520', reason: '리튬 가격 반등 수혜', subName: '에코프로비엠' },
    { type: '테마', sector: '바이오', name: '알테오젠', code: '196170', reason: '플랫폼 기술 수출 가속', subName: '삼성바이오로직스' },
    { type: '업종', sector: '자동차', name: '현대차', code: '005380', reason: '주주환원 확대', subName: '기아' },
    { type: '업종', sector: '금융', name: 'KB금융', code: '105560', reason: '밸류업 프로그램 대장주', subName: '신한지주' },
    { type: '테마', sector: '로봇', name: '레인보우로보틱스', code: '277810', reason: '자동화 투자 확대', subName: '두산로보틱스' }
];

app.get('/api/data', async (req, res) => {
    try {
        const token = await getAccessToken();
        const results = [];

        // 1. 커스텀 주도섹터 데이터 수집
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
                await new Promise(resolve => setTimeout(resolve, 50));
            } catch (err) {}
        }

        // 2. 진짜 시장 전체 상위 랭킹 수집 (KIS volume-rank API)
        let marketTop = [];
        try {
            const kisRankData = await fetchMarketVolumeRank(token);
            if (kisRankData && kisRankData.output) {
                marketTop = kisRankData.output.map(item => {
                    let itemType = '기타';
                    let itemSector = '분류없음'; // KIS는 테마를 알려주지 않음
                    
                    // 기존 관심종목에 있다면 테마명 씌우기
                    const matched = TARGET_SECTORS.find(t => t.name === item.hts_kor_isnm);
                    if (matched) {
                        itemType = matched.type;
                        itemSector = matched.sector;
                    }

                    return {
                        type: itemType,
                        name: item.hts_kor_isnm,
                        sector: itemSector,
                        reason: '시장 랭킹 진입',
                        chg: formatChg(item.prdy_ctrt),
                        volume: formatAmt(item.acml_tr_pbmn),
                        marketCap: '-', // 랭킹 API에서는 시가총액 정보가 없음
                        tradeVolume: Number(item.acml_vol),
                        strength: 100,
                        stocks: [
                            { name: item.hts_kor_isnm, price: Number(item.stck_prpr).toLocaleString(), chg: formatChg(item.prdy_ctrt) }
                        ]
                    };
                });
            }
        } catch (rankErr) {
            console.error('시장 랭킹 수집 에러:', rankErr.message);
        }

        const serverTime = new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });

        res.json({ 
            sectors: results,          // 주도섹터용 데이터
            marketTop: marketTop,      // 진짜 시장 랭킹 데이터
            categories: {
                '테마': ['2차전지','로봇','바이오','AI','우주항공','원전'],
                '업종': ['반도체','자동차','금융','제약']
            },
            timestamp: serverTime 
        });

    } catch (error) {
        res.status(500).json({ error: '데이터 통신 실패' });
    }
});

app.listen(PORT, () => console.log(`🚀 서버가 포트 ${PORT}에서 작동 중`));
