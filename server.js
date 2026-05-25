const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS 허용 및 정적 파일(HTML) 연결
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// 프론트엔드에서 /api/data 로 요청하면 실행되는 중계 역할
app.get('/api/data', async (req, res) => {
    try {
        const baseUrl = 'https://openapi.koreainvestment.com:9443';
        
        // ⚠️ 주의: 한투 현재가 API는 종목코드(FID_INPUT_ISCD) 등 필수 파라미터가 있어야 정상 작동합니다.
        // 여기서는 예시로 삼성전자(005930) 파라미터를 붙여두었습니다.
        const apiUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=005930`;

        // 서버가 직접 한투 API로 요청
        const response = await fetch(apiUrl, {
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'appkey': process.env.APP_KEY,         // Render에서 설정할 환경변수
                'appsecret': process.env.APP_SECRET,   // Render에서 설정할 환경변수
                'tr_id': 'FHKST01010100'
            }
        });

        if (!response.ok) {
            throw new Error(`한투 API 에러: ${response.status}`);
        }

        // 성공적으로 받아온 데이터를 프론트엔드로 전달
        const data = await response.json();
        res.json(data);

    } catch (error) {
        console.error('데이터 통신 실패:', error);
        res.status(500).json({ error: '데이터 통신 실패' });
    }
});

// 서버 실행
app.listen(PORT, () => {
    console.log(`서버가 포트 ${PORT}에서 정상 작동 중입니다.`);
});