const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// 임시 출입증(토큰)을 저장해둘 변수
let cachedToken = null;
let tokenExpiration = null;

// 1. 한국투자증권에서 토큰(Access Token) 발급받기
async function getAccessToken() {
    // 발급받은 토큰이 아직 유효하면 재사용
    if (cachedToken && tokenExpiration && Date.now() < tokenExpiration) {
        return cachedToken;
    }

    console.log("새로운 토큰을 발급받습니다...");
    const tokenUrl = 'https://openapi.koreainvestment.com:9443/oauth2/tokenP';
    const body = JSON.stringify({
        "grant_type": "client_credentials",
        "appkey": process.env.APP_KEY,
        "appsecret": process.env.APP_SECRET
    });

    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: body
    });

    if (!response.ok) {
        const errText = await response.text(); // 👈 이 줄 추가 (상세 에러 메세지 읽기)
        throw new Error(`토큰 발급 실패: ${response.status} - ${errText}`); // 👈 에러 메세지 같이 출력하도록 수정
    }

    const data = await response.json();
    cachedToken = data.access_token;
    // 만료 시간 설정 (여유있게 23시간 후로 설정)
    tokenExpiration = Date.now() + (data.expires_in * 1000) - 3600000; 
    
    console.log("토큰 발급 완료!");
    return cachedToken;
}

// 2. 프론트엔드에서 /api/data 로 요청하면 실행되는 중계 역할
app.get('/api/data', async (req, res) => {
    try {
        const token = await getAccessToken(); // 🔑 위에서 만든 토큰 가져오기

        const baseUrl = 'https://openapi.koreainvestment.com:9443';
        const apiUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=005930`;

        // 서버가 직접 한투 API로 요청 (토큰 포함)
        const response = await fetch(apiUrl, {
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'authorization': `Bearer ${token}`,    // ✨ 발급받은 출입증 제출
                'appkey': process.env.APP_KEY,         // Render 환경변수
                'appsecret': process.env.APP_SECRET,   // Render 환경변수
                'tr_id': 'FHKST01010100'
            }
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`한투 API 거절: ${response.status} - ${errText}`);
        }

        const data = await response.json();
        res.json(data);

    } catch (error) {
        console.error('서버 내부 데이터 통신 실패:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`서버가 포트 ${PORT}에서 정상 작동 중입니다.`);
});
