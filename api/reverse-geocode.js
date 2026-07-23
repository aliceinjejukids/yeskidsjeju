// YesKidsJeju 역지오코딩 (좌표 → 카카오 장소명)
// 구글 타임라인 방문 좌표를 카카오 장소검색으로 "가장 가까운 실제 POI 이름"으로 변환
// geocode-fill.js와 동일한 보안 패턴(ADMIN_SECRET)과 KAKAO_REST_API_KEY 재사용
//
// 호출 방식:
//  - 배치:   POST /api/reverse-geocode?secret=YOUR_ADMIN_SECRET   body: {"points":[{"id":0,"lat":33.5,"lng":126.5}, ...]}
//  - 단건테스트: GET /api/reverse-geocode?secret=YOUR_ADMIN_SECRET&lat=33.5&lng=126.5
//
// 반환: [{id, name, category, group, address, lat, lng, distance}] — 못 찾으면 name="" (주변에 POI 없음)

// 우리가 관심 있는 카테고리 그룹만 검색 → 병원/약국/주차장 같은 건 자동으로 안 잡힘(=나들이 장소만)
const GROUPS = ["AT4", "CT1", "CE7", "FD6", "AD5", "MT1"];
// AT4 관광명소 · CT1 문화시설 · CE7 카페 · FD6 음식점 · AD5 숙박 · MT1 대형마트

export default async function handler(req, res) {
  const KAKAO = process.env.KAKAO_REST_API_KEY;
  const SECRET = process.env.ADMIN_SECRET;

  if (!KAKAO || !SECRET) {
    return res.status(500).json({
      error: "환경변수 누락",
      missing: { KAKAO_REST_API_KEY: !KAKAO, ADMIN_SECRET: !SECRET }
    });
  }
  if (req.query.secret !== SECRET) {
    return res.status(401).json({ error: "Unauthorized — secret 파라미터가 일치하지 않아요" });
  }

  // 입력 모으기 (POST 배치: points=역지오코딩 / keywords=정지오코딩, GET 단건)
  let points = [];
  let keywords = null;
  if (req.method === "POST") {
    const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
    points = (body && Array.isArray(body.points)) ? body.points : [];
    keywords = (body && Array.isArray(body.keywords)) ? body.keywords : null;
  } else if (req.query.lat && req.query.lng) {
    points = [{ id: 0, lat: parseFloat(req.query.lat), lng: parseFloat(req.query.lng) }];
  } else if (req.query.q) {
    keywords = [req.query.q];
  }

  // 장소명(키워드) → 좌표·주소·지도링크 (정방향 지오코딩, 제주 지역 한정)
  if (keywords) {
    if (keywords.length === 0 || keywords.length > 60) {
      return res.status(400).json({ error: "keywords는 1~60개까지" });
    }
    try {
      const results = await Promise.all(keywords.map(q => kakaoKeyword(q, KAKAO)));
      return res.status(200).json({ ok: true, count: results.length, results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (points.length === 0) {
    return res.status(400).json({ error: "points 또는 keywords가 필요해요." });
  }
  if (points.length > 60) {
    return res.status(400).json({ error: "한 번에 최대 60개까지. 나눠서 호출해주세요." });
  }

  try {
    const results = await Promise.all(points.map(p => nearestPOI(p, KAKAO)));
    res.status(200).json({ ok: true, count: results.length, results });
  } catch (err) {
    console.error("reverse-geocode error:", err);
    res.status(500).json({ error: err.message });
  }
}

// 한 좌표 주변에서 가장 가까운 POI 찾기 (반경 100m → 없으면 300m)
async function nearestPOI(p, key) {
  const lat = Number(p.lat), lng = Number(p.lng);
  for (const radius of [100, 300]) {
    const arrs = await Promise.all(GROUPS.map(g => kakaoCategory(g, lat, lng, radius, key)));
    let best = null;
    for (const docs of arrs) {
      for (const d of docs) {
        if (!best || Number(d.distance) < Number(best.distance)) best = d;
      }
    }
    if (best) {
      return {
        id: p.id,
        name: best.place_name,
        category: best.category_name,   // 예: "여행 > 관광,명소 > 해수욕장"
        group: best.category_group_code,
        address: best.road_address_name || best.address_name,
        lat: parseFloat(best.y),
        lng: parseFloat(best.x),
        distance: Number(best.distance),
        kakao_id: best.id,              // 카카오 장소 ID → place.map.kakao.com/{id}
        place_url: best.place_url,      // 카카오맵 정확한 URL
        phone: best.phone || ""
      };
    }
  }
  return { id: p.id, name: "", category: "", group: "", address: "" };
}

// 장소명 키워드 검색 → 대표 결과 (제주 영역으로 한정)
async function kakaoKeyword(query, key) {
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json`
    + `?query=${encodeURIComponent(query)}&size=5&rect=126.08,33.0,127.0,33.7`;
  const r = await fetch(url, { headers: { Authorization: `KakaoAK ${key}` } });
  if (!r.ok) return { query, name: "" };
  const d = await r.json();
  const f = (d.documents || [])[0];
  if (!f) return { query, name: "" };
  return {
    query,
    name: f.place_name,
    category: f.category_name,
    address: f.road_address_name || f.address_name,
    lat: parseFloat(f.y),
    lng: parseFloat(f.x),
    place_url: f.place_url,
    phone: f.phone || ""
  };
}

// 카카오 카테고리 검색 (좌표 기준 거리순)
async function kakaoCategory(group, lat, lng, radius, key) {
  const url = `https://dapi.kakao.com/v2/local/search/category.json`
    + `?category_group_code=${group}&x=${lng}&y=${lat}&radius=${radius}&sort=distance&size=5`;
  const r = await fetch(url, { headers: { Authorization: `KakaoAK ${key}` } });
  if (!r.ok) return [];
  const d = await r.json();
  return d.documents || [];
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
