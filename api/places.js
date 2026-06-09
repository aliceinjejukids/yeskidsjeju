// JejuKids Notion API 연동 함수
// 노션 DB에서 장소 데이터를 가져와서 웹페이지가 쓸 수 있는 JSON으로 변환
 
export default async function handler(req, res) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const NOTION_DB_ID = process.env.NOTION_DB_ID;
 
  if (!NOTION_TOKEN || !NOTION_DB_ID) {
    return res.status(500).json({
      error: "환경변수 NOTION_TOKEN 또는 NOTION_DB_ID가 설정되지 않았습니다."
    });
  }
 
  try {
    const places = await fetchAllPages(NOTION_TOKEN, NOTION_DB_ID);
    const normalized = places.map(p => normalizeProperties(p.properties));
 
    // 1시간 캐시 + 백그라운드 갱신
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json(normalized);
  } catch (err) {
    console.error("Notion API error:", err);
    res.status(500).json({ error: err.message });
  }
}
 
// 노션 DB의 모든 페이지 가져오기 (100개씩, pagination 지원)
async function fetchAllPages(token, dbId) {
  const results = [];
  let cursor = undefined;
 
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
 
    const response = await fetch(
      `https://api.notion.com/v1/databases/${dbId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );
 
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Notion API ${response.status}: ${errText}`);
    }
 
    const data = await response.json();
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
 
  return results;
}
 
// 노션 properties → 평평한 string 객체로 변환
function normalizeProperties(props) {
  const result = {};
  for (const [key, value] of Object.entries(props)) {
    result[key] = readProperty(value);
  }
  return result;
}
 
// 모든 노션 컬럼 타입을 안전하게 string으로 변환
function readProperty(p) {
  if (!p) return "";
  switch (p.type) {
    case "title":
      return p.title.map(t => t.plain_text).join("");
    case "rich_text":
      return p.rich_text.map(t => t.plain_text).join("");
    case "select":
      return p.select?.name || "";
    case "multi_select":
      return p.multi_select.map(s => s.name).join(", ");
    case "status":
      return p.status?.name || "";
    case "url":
      return p.url || "";
    case "number":
      return p.number ?? "";
    case "checkbox":
      return p.checkbox;
    case "date":
      return p.date?.start || "";
    case "email":
      return p.email || "";
    case "phone_number":
      return p.phone_number || "";
    case "people":
      return p.people.map(u => u.name).join(", ");
    case "created_time":
      return p.created_time || "";
    case "last_edited_time":
      return p.last_edited_time || "";
    default:
      return "";
  }
}
