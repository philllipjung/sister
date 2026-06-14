require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const app = express();
const PORT = 5000;

// 미들웨어
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// SQLite 데이터베이스 초기화
const db = new Database('locations.db');

// origins (출발지) 테이블 생성
db.exec(`
    CREATE TABLE IF NOT EXISTS origins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        location_name TEXT NOT NULL,
        worker_name TEXT NOT NULL,
        longitude REAL NOT NULL,
        latitude REAL NOT NULL,
        UNIQUE(location_name, worker_name)
    )
`);

// destinations (목적지) 테이블 생성
db.exec(`
    CREATE TABLE IF NOT EXISTS destinations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        location_name TEXT NOT NULL,
        place_name TEXT NOT NULL,
        longitude REAL NOT NULL,
        latitude REAL NOT NULL,
        UNIQUE(location_name, place_name)
    )
`);

// 초기 데이터 마이그레이션 (테이블이 비어있을 경우)
const initialOrigins = [
    { location_name: "종로", worker_name: "김철수", longitude: 126.9799, latitude: 37.5698 },
    { location_name: "잠실", worker_name: "이영희", longitude: 127.1054, latitude: 37.5130 },
    { location_name: "정자역", worker_name: "박민수", longitude: 127.1123, latitude: 37.3588 },
    { location_name: "신도림", worker_name: "최수진", longitude: 126.8888, latitude: 37.5096 }
];

const initialDestinations = [
    { location_name: "사당", place_name: "사당교육지원청", longitude: 126.9816, latitude: 37.4763 },
    { location_name: "수원", place_name: "수원교육지원청", longitude: 127.0175, latitude: 37.2638 },
    { location_name: "왕십리", place_name: "왕십리교육지원청", longitude: 127.0399, latitude: 37.5613 },
    { location_name: "신촌", place_name: "신촌교육지원청", longitude: 126.9420, latitude: 37.5550 },
    { location_name: "송도", place_name: "송도교육지원청", longitude: 126.6439, latitude: 37.3818 }
];

// 기존 데이터 확인
const existingOrigins = db.prepare('SELECT COUNT(*) as count FROM origins').get().count;
const existingDests = db.prepare('SELECT COUNT(*) as count FROM destinations').get().count;

if (existingOrigins === 0) {
    const insertStmt = db.prepare('INSERT INTO origins (location_name, worker_name, longitude, latitude) VALUES (?, ?, ?, ?)');
    const insertMany = db.transaction((locs) => {
        for (const loc of locs) {
            insertStmt.run(loc.location_name, loc.worker_name, loc.longitude, loc.latitude);
        }
    });
    insertMany(initialOrigins);
    console.log('Initial origins migrated to database');
}

if (existingDests === 0) {
    const insertStmt = db.prepare('INSERT INTO destinations (location_name, place_name, longitude, latitude) VALUES (?, ?, ?, ?)');
    const insertMany = db.transaction((locs) => {
        for (const loc of locs) {
            insertStmt.run(loc.location_name, loc.place_name, loc.longitude, loc.latitude);
        }
    });
    insertMany(initialDestinations);
    console.log('Initial destinations migrated to database');
}

// 데이터베이스에서 모든 출발지 조회 함수
function getAllOrigins() {
    const rows = db.prepare('SELECT * FROM origins ORDER BY location_name').all();
    const origins = {};
    rows.forEach(row => {
        origins[`${row.location_name} (${row.worker_name})`] = [row.longitude, row.latitude];
    });
    return origins;
}

// 데이터베이스에서 모든 목적지 조회 함수
function getAllDestinations() {
    const rows = db.prepare('SELECT * FROM destinations ORDER BY location_name').all();
    const destinations = {};
    rows.forEach(row => {
        destinations[`${row.location_name} (${row.place_name})`] = [row.longitude, row.latitude];
    });
    return destinations;
}

const API_KEY = process.env.ODSAY_API_KEY || "ApnqJIS/OpqXWoNO/YKQVzLohpALmesEvl4taqpQ4NY";
// 출발지 관리 API 엔드포인트

// 모든 출발지 조회
app.get('/api/origins', (req, res) => {
    try {
        const origins = db.prepare('SELECT * FROM origins ORDER BY location_name').all();
        res.json(origins);
    } catch (error) {
        console.error('Error fetching origins:', error);
        res.status(500).json({ error: 'Failed to fetch origins' });
    }
});

// 주소 검색 API 엔드포인트 (카카오 우편번호 서비스 + OpenStreetMap 지오코딩)
// 카카오 우편번호 서비스로 주소 검색 후 OpenStreetMap Nominatim API로 좌표 변환

// 주소를 좌표로 변환하는 함수 (OpenStreetMap Nominatim API)
async function geocodeAddress(address) {
    try {
        const response = await axios.get('https://nominatim.openstreetmap.org/search', {
            params: {
                format: 'json',
                q: address,
                countrycodes: 'kr',
                limit: 1
            },
            headers: {
                'User-Agent': 'Odsay-Transit-Route-Finder/1.0'
            }
        });

        if (response.data && response.data.length > 0) {
            const data = response.data[0];
            return {
                longitude: parseFloat(data.lon),
                latitude: parseFloat(data.lat),
                formatted_address: data.display_name
            };
        } else {
            throw new Error('좌표를 찾을 수 없습니다');
        }
    } catch (error) {
        console.error('Geocoding error:', error.message);
        throw new Error('주소 좌표 변환 실패: ' + error.message);
    }
}

// 출발지 주소 검색 결과 처리 엔드포인트
app.post('/api/origins/search', async (req, res) => {
    const { zonecode, address, roadAddress, buildingName } = req.body;

    if (!address && !roadAddress) {
        return res.status(400).json({ error: '주소 정보가 필요합니다' });
    }

    try {
        // 지오코딩으로 좌표 변환
        const searchAddress = roadAddress || address;
        const coords = await geocodeAddress(searchAddress);

        const stmt = db.prepare('INSERT INTO origins (location_name, worker_name, longitude, latitude) VALUES (?, ?, ?, ?)');
        const result = stmt.run(
            searchAddress,
            buildingName || '검색한 위치',
            coords.longitude,
            coords.latitude
        );

        res.json({
            id: result.lastInsertRowid,
            location_name: searchAddress,
            worker_name: buildingName || '검색한 위치',
            longitude: coords.longitude,
            latitude: coords.latitude
        });
    } catch (error) {
        console.error('Error adding origin:', error);
        res.status(500).json({ error: error.message || 'Failed to add origin' });
    }
});

// 목적지 주소 검색 결과 처리 엔드포인트
app.post('/api/destinations/search', async (req, res) => {
    const { zonecode, address, roadAddress, buildingName } = req.body;

    if (!address && !roadAddress) {
        return res.status(400).json({ error: '주소 정보가 필요합니다' });
    }

    try {
        // 지오코딩으로 좌표 변환
        const searchAddress = roadAddress || address;
        const coords = await geocodeAddress(searchAddress);

        const stmt = db.prepare('INSERT INTO destinations (location_name, place_name, longitude, latitude) VALUES (?, ?, ?, ?)');
        const result = stmt.run(
            searchAddress,
            buildingName || '검색한 장소',
            coords.longitude,
            coords.latitude
        );

        res.json({
            id: result.lastInsertRowid,
            location_name: searchAddress,
            place_name: buildingName || '검색한 장소',
            longitude: coords.longitude,
            latitude: coords.latitude
        });
    } catch (error) {
        console.error('Error adding destination:', error);
        res.status(500).json({ error: error.message || 'Failed to add destination' });
    }
});

// 출발지 추가
app.post('/api/origins', (req, res) => {
    const { location_name, worker_name, longitude, latitude } = req.body;

    if (!location_name || !worker_name || longitude === undefined || latitude === undefined) {
        return res.status(400).json({ error: '모든 필드를 입력해주세요' });
    }

    try {
        const stmt = db.prepare('INSERT INTO origins (location_name, worker_name, longitude, latitude) VALUES (?, ?, ?, ?)');
        const result = stmt.run(location_name, worker_name, longitude, latitude);
        res.json({ id: result.lastInsertRowid, location_name, worker_name, longitude, latitude });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT') {
            res.status(400).json({ error: '이미 존재하는 출발지입니다' });
        } else {
            console.error('Error adding origin:', error);
            res.status(500).json({ error: 'Failed to add origin' });
        }
    }
});

// 출발지 삭제
app.delete('/api/origins/:id', (req, res) => {
    const { id } = req.params;

    try {
        const stmt = db.prepare('DELETE FROM origins WHERE id = ?');
        const result = stmt.run(id);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Origin not found' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting origin:', error);
        res.status(500).json({ error: 'Failed to delete origin' });
    }
});

// 목적지 관리 API 엔드포인트

// 모든 목적지 조회
app.get('/api/destinations', (req, res) => {
    try {
        const destinations = db.prepare('SELECT * FROM destinations ORDER BY location_name').all();
        res.json(destinations);
    } catch (error) {
        console.error('Error fetching destinations:', error);
        res.status(500).json({ error: 'Failed to fetch destinations' });
    }
});

// 목적지 추가
app.post('/api/destinations', (req, res) => {
    const { location_name, place_name, longitude, latitude } = req.body;

    if (!location_name || !place_name || longitude === undefined || latitude === undefined) {
        return res.status(400).json({ error: '모든 필드를 입력해주세요' });
    }

    try {
        const stmt = db.prepare('INSERT INTO destinations (location_name, place_name, longitude, latitude) VALUES (?, ?, ?, ?)');
        const result = stmt.run(location_name, place_name, longitude, latitude);
        res.json({ id: result.lastInsertRowid, location_name, place_name, longitude, latitude });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT') {
            res.status(400).json({ error: '이미 존재하는 목적지입니다' });
        } else {
            console.error('Error adding destination:', error);
            res.status(500).json({ error: 'Failed to add destination' });
        }
    }
});

// 목적지 삭제
app.delete('/api/destinations/:id', (req, res) => {
    const { id } = req.params;

    try {
        const stmt = db.prepare('DELETE FROM destinations WHERE id = ?');
        const result = stmt.run(id);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Destination not found' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting destination:', error);
        res.status(500).json({ error: 'Failed to delete destination' });
    }
});

// 길찾기 API 엔드포인트
app.post('/api/transit-routes', async (req, res) => {
    const { origins, destinations } = req.body;
    const originsData = getAllOrigins();
    const destinationsData = getAllDestinations();
    const results = {};

    try {
        for (const origin of origins) {
            results[origin] = {};
            if (!originsData[origin]) continue;

            const [sx, sy] = originsData[origin];

            for (const dest of destinations) {
                if (!destinationsData[dest]) continue;

                const [ex, ey] = destinationsData[dest];
                const url = `https://api.odsay.com/v1/api/searchPubTransPathT?lang=0&SX=${sx}&SY=${sy}&EX=${ex}&EY=${ey}&apiKey=${API_KEY}`;

                try {
                    const response = await axios.get(url);
                    const data = response.data;

                    if (data.result && data.result.path && data.result.path.length > 0) {
                        const pathInfo = data.result.path[0];
                        const info = pathInfo.info || {};

                        const totalTime = info.totalTime || 0;
                        const payment = info.payment || 0;

                        // 경로 정보 추출
                        const subPaths = pathInfo.subPath || [];
                        const routeDesc = [];
                        const detailedPaths = [];

                        // 환승 횟수 계산
                        let actualTransferCount = 0;
                        for (const sub of subPaths) {
                            if (sub.trafficType === 1 || sub.trafficType === 2) {
                                actualTransferCount++;
                            }
                        }
                        if (actualTransferCount > 0) {
                            actualTransferCount -= 1;
                        }

                        const transferCount = Math.max(info.transferCount || 0, actualTransferCount);

                        for (const sub of subPaths) {
                            const pathDetail = {
                                trafficType: sub.trafficType,
                                type: null,
                                name: null,
                                stationCount: sub.stationCount || 0,
                                stations: [],
                                distance: 0
                            };

                            if (sub.trafficType === 1) {
                                const laneArray = sub.lane || [];
                                const lane = Array.isArray(laneArray) && laneArray.length > 0 ? laneArray[0] : {};
                                const lineName = lane.name || '';

                                if (lineName) {
                                    routeDesc.push(lineName);
                                    pathDetail.type = '지하철';
                                    pathDetail.name = lineName;
                                }

                                if (sub.passStopList && sub.passStopList.stations && Array.isArray(sub.passStopList.stations)) {
                                    pathDetail.stations = sub.passStopList.stations
                                        .filter(s => s && s.stationName)
                                        .map(s => ({
                                            name: s.stationName,
                                            index: s.index || 0
                                        }));
                                }
                            } else if (sub.trafficType === 2) {
                                const laneArray = sub.lane || [];
                                const lane = Array.isArray(laneArray) && laneArray.length > 0 ? laneArray[0] : {};
                                const busNo = lane.busNo || '';

                                if (busNo) {
                                    routeDesc.push(`버스${busNo}`);
                                    pathDetail.type = '버스';
                                    pathDetail.name = busNo;
                                }

                                if (sub.passStopList && sub.passStopList.stations && Array.isArray(sub.passStopList.stations)) {
                                    pathDetail.stations = sub.passStopList.stations
                                        .filter(s => s && s.stationName)
                                        .map(s => ({
                                            name: s.stationName,
                                            index: s.index || 0
                                        }));
                                }
                            } else if (sub.trafficType === 3) {
                                pathDetail.type = '도보';
                                pathDetail.name = '도보';
                                pathDetail.distance = sub.distance || 0;
                            }

                            if (sub.trafficType !== undefined && sub.trafficType !== null) {
                                detailedPaths.push(pathDetail);
                            }
                        }

                        const routeStr = routeDesc.slice(0, 4).join(' → ');

                        results[origin][dest] = {
                            time: totalTime,
                            transfer: transferCount,
                            route: routeStr,
                            payment: payment,
                            detailedPaths: detailedPaths
                        };
                    } else {
                        results[origin][dest] = null;
                    }
                } catch (error) {
                    console.error(`Error for ${origin} -> ${dest}:`, error.message);
                    results[origin][dest] = null;
                }
            }
        }

        res.json(results);

    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// 서버 시작
app.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
