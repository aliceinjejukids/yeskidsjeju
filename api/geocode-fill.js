// YesKidsJeju 좌표 자동 채우기
// 노션 DB의 모든 장소 → 주소를 카카오 Geocoding으로 좌표 변환 → 노션 PATCH
// 호출 방식: /api/geocode-fill?secret=YOUR_ADMIN_SECRET
//
// 호출 시 동작:
// - 위도/경도가 둘 다 비어 있는 페이지만 처리 (이미 채워진 건 건너뜀)
// - 결과 요약을 JSON으로 반환 (어떤 장소가 성공/실패했는지)

export default async function handler(req, res) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const NOTION_DB_ID = process.env.NOTION_DB_ID;
  const KAKAO_KEY = process.env.KAKAO_REST_API_KEY;
  const ADMIN_SECRET = process.env.ADMIN_SECRET;

  // 1. 환경변수 체크
  if (!NOTION_TOKEN || !NOTION_DB_ID || !KAKAO_KEY || !ADMIN_SECRET) {
    return res.status(500).json({
      error: "환경변수 누락",
      missing: {
        NOTION_TOKEN: !NOTION_TOKEN,
        NOTION_DB_ID: !NOTION_DB_ID,
        KAKAO_REST_API_KEY: !KAKAO_KEY,
        ADMIN_SECRET: !ADMIN_SECRET
      }
    });
  }

  // 2. 보안: secret 토큰 일치 확인
  if (req.query.secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized — secret 파라미터가 일치하지 않아요" });
  }

  try {
    // 3. 진짜 DB ID로 자동 변환 (페이지 ID 줬을 수도 있으니)
    const realDbId = await resolveDatabaseId(NOTION_TOKEN, NOTION_DB_ID);

    // 4. 모든 페이지 가져오기
    const pages = await fetchAllPages(NOTION_TOKEN, realDbId);

    const results = { updated: [], skipped: [], failed: [], totalPages: pages.length };

    // 5. 순회: 좌표 없는 페이지만 처리
    for (const page of pages) {
      const props = page.properties;
      const name = readText(props["이름"]);
      const address = readText(props["주소"]);
      const lat = props["위도"]?.number;
      const lng = props["경도"]?.number;

      if (!name) continue; // 빈 행 스킵
      if (!address) {
        results.failed.push({ name, reason: "주소 없음" });
        continue;
      }
      if (lat != null && lng != null) {
        results.skipped.push({ name, reason: "이미 채워짐" });
        continue;
      }

      const coords = await geocode(address, KAKAO_KEY);
      if (!coords || !coords.lat) {
        results.failed.push({ name, address, reason: "카카오 검색 실패", debug: coords });
        continue;
      }

      const ok = await updatePageCoords(NOTION_TOKEN, page.id, coords.lat, coords.lng);
      if (ok) {
        results.updated.push({ name, ...coords });
      } else {
        results.failed.push({ name, reason: "노션 업데이트 실패" });
      }
    }

    res.status(200).json({
      ok: true,
      summary: {
        총: pages.length,
        업데이트: results.updated.length,
        이미채워짐: results.skipped.length,
        실패: results.failed.length
      },
      detail: results
    });
  } catch (err) {
    console.error("geocode-fill error:", err);
    res.status(500).json({ error: err.message });
  }
}

// 카카오 주소→좌표 변환 (디버그 정보 포함)
async function geocode(address, apiKey) {
  const debug = { tried: [] };
  // 1차: 주소 검색
  const url1 = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`;
  let r = await fetch(url1, { headers: { Authorization: `KakaoAK ${apiKey}` } });
  const body1 = await r.text();
  debug.tried.push({ api: "address", status: r.status, body: body1.slice(0, 300) });
  if (r.ok) {
    try {
      const d = JSON.parse(body1);
      const f = d.documents?.[0];
      if (f) return { lat: parseFloat(f.y), lng: parseFloat(f.x), debug };
    } catch (_) {}
  }
  // 2차 fallback: 키워드 검색
  const url2 = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(address)}`;
  r = await fetch(url2, { headers: { Authorization: `KakaoAK ${apiKey}` } });
  const body2 = await r.text();
  debug.tried.push({ api: "keyword", status: r.status, body: body2.slice(0, 300) });
  if (r.ok) {
    try {
      const d = JSON.parse(body2);
      const f = d.documents?.[0];
      if (f) return { lat: parseFloat(f.y), lng: parseFloat(f.x), debug };
    } catch (_) {}
  }
  return debug;
}

// 노션 페이지에 위경도 PATCH
async function updatePageCoords(token, pageId, lat, lng) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      properties: {
        "위도": { number: lat },
        "경도": { number: lng }
      }
    })
  });
  return r.ok;
}

// 노션 property → 텍스트
function readText(p) {
  if (!p) return "";
  if (p.type === "title") return p.title.map(t => t.plain_text).join("");
  if (p.type === "rich_text") return p.rich_text.map(t => t.plain_text).join("");
  return "";
}

// DB ID resolve (places.js와 동일 로직)
async function resolveDatabaseId(token, id) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json"
  };
  const dbRes = await fetch(`https://api.notion.com/v1/databases/${id}`, { method: "GET", headers });
  if (dbRes.ok) return id;
  try {
    const childrenRes = await fetch(
      `https://api.notion.com/v1/blocks/${id}/children?page_size=100`,
      { method: "GET", headers }
    );
    if (childrenRes.ok) {
      const data = await childrenRes.json();
      const childDb = data.results.find(b => b.type === "child_database" || b.type === "database");
      if (childDb) {
        const childCheck = await fetch(`https://api.notion.com/v1/databases/${childDb.id}`, { method: "GET", headers });
        if (childCheck.ok) return childDb.id;
      }
    }
  } catch (_) {}
  const searchRes = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers,
    body: JSON.stringify({ filter: { value: "database", property: "object" } })
  });
  if (searchRes.ok) {
    const data = await searchRes.json();
    if (data.results?.length > 0) return data.results[0].id;
  }
  throw new Error("DB ID 해결 실패");
}

// 페이지 전체 가져오기
async function fetchAllPages(token, dbId) {
  const results = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Notion API ${r.status}`);
    const data = await r.json();
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}
