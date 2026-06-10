// YesKidsJeju 통합 날씨 API
// 기상청 단기예보 + 중기예보 + 에어코리아 미세먼지 한 번에 호출
// 호출: /api/weather?region=jejusi  (region 안 주면 jejusi 기본)

const REGIONS = {
  jejusi:   { name: "제주시",   nx: 53, ny: 38, lat: 33.4996, lng: 126.5312, midLand: "11G00201", midTemp: "11G10201" },
  seogwipo: { name: "서귀포시", nx: 52, ny: 33, lat: 33.2541, lng: 126.5601, midLand: "11G00202", midTemp: "11G10202" },
  aewol:    { name: "애월",     nx: 51, ny: 36, lat: 33.4636, lng: 126.3318, midLand: "11G00201", midTemp: "11G10201" },
  hallim:   { name: "한림",     nx: 49, ny: 36, lat: 33.4116, lng: 126.2649, midLand: "11G00201", midTemp: "11G10201" },
  seongsan: { name: "성산",     nx: 56, ny: 36, lat: 33.4338, lng: 126.9112, midLand: "11G00201", midTemp: "11G10201" },
  pyoseon:  { name: "표선",     nx: 53, ny: 32, lat: 33.3263, lng: 126.8328, midLand: "11G00202", midTemp: "11G10202" },
  jungmun:  { name: "중문",     nx: 50, ny: 32, lat: 33.2495, lng: 126.4180, midLand: "11G00202", midTemp: "11G10202" },
  hallasan: { name: "한라산",   nx: 51, ny: 35, lat: 33.3617, lng: 126.5292, midLand: "11G00201", midTemp: "11G10201" }
};

export default async function handler(req, res) {
  const KEY = process.env.WEATHER_API_KEY;
  if (!KEY) return res.status(500).json({ error: "WEATHER_API_KEY 환경변수가 없어요" });

  const regionKey = req.query.region || "jejusi";
  const region = REGIONS[regionKey] || REGIONS.jejusi;

  const isDebug = req.query.debug === "1";

  try {
    const [hourlyR, midLandR, midTempR, airR] = await Promise.allSettled([
      fetchShortForecast(KEY, region.nx, region.ny),
      fetchMidLand(KEY, region.midLand),
      fetchMidTemp(KEY, region.midTemp),
      fetchAirQuality(KEY)
    ]);

    if (isDebug) {
      return res.status(200).json({
        keyLength: KEY.length,
        keyPreview: KEY.slice(0, 6) + "..." + KEY.slice(-4),
        region,
        baseTime: getShortBaseTime(),
        midBaseTime: getMidBaseTime(),
        shortForecast: hourlyR.status === "fulfilled" ? { ok: true, count: hourlyR.value.length, first: hourlyR.value[0] } : { error: hourlyR.reason?.message || String(hourlyR.reason) },
        midLand: midLandR.status === "fulfilled" ? { ok: true, value: midLandR.value } : { error: midLandR.reason?.message || String(midLandR.reason) },
        midTemp: midTempR.status === "fulfilled" ? { ok: true, value: midTempR.value } : { error: midTempR.reason?.message || String(midTempR.reason) },
        air: airR.status === "fulfilled" ? { ok: true, value: airR.value } : { error: airR.reason?.message || String(airR.reason) }
      });
    }

    if (hourlyR.status !== "fulfilled") throw hourlyR.reason;
    const hourly = hourlyR.value;
    const midLand = midLandR.status === "fulfilled" ? midLandR.value : null;
    const midTemp = midTempR.status === "fulfilled" ? midTempR.value : null;
    const air = airR.status === "fulfilled" ? airR.value : null;

    const result = {
      region: { key: regionKey, ...region },
      regions: Object.entries(REGIONS).map(([k, v]) => ({ key: k, name: v.name, lat: v.lat, lng: v.lng })),
      generatedAt: new Date().toISOString(),
      hourly,                     // 시간별 (오늘~+3일)
      daily: aggregateDaily(hourly, midLand, midTemp),  // 일별 (오늘~+7일)
      air,                        // 미세먼지
    };

    // 30분 캐시 + 백그라운드 갱신
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    res.status(200).json(result);
  } catch (err) {
    console.error("weather error:", err);
    res.status(500).json({ error: err.message });
  }
}

// ============ 단기예보 ============
async function fetchShortForecast(key, nx, ny) {
  const { baseDate, baseTime } = getShortBaseTime();
  const params = new URLSearchParams({
    serviceKey: key,
    pageNo: "1",
    numOfRows: "1000",
    dataType: "JSON",
    base_date: baseDate,
    base_time: baseTime,
    nx: String(nx),
    ny: String(ny)
  });
  const url = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?${params}`;
  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) throw new Error(`단기예보 HTTP ${r.status}: ${text.slice(0, 200)}`);
  let j;
  try { j = JSON.parse(text); }
  catch (_) { throw new Error(`단기예보 응답 파싱 실패: ${text.slice(0, 200)}`); }
  const code = j.response?.header?.resultCode;
  if (code && code !== "00") throw new Error(`단기예보 ${code} ${j.response.header.resultMsg}`);
  const items = j.response?.body?.items?.item || [];

  // 시간별로 묶기
  const byKey = {};
  for (const it of items) {
    const k = `${it.fcstDate}_${it.fcstTime}`;
    if (!byKey[k]) byKey[k] = { date: it.fcstDate, time: it.fcstTime };
    byKey[k][it.category] = it.fcstValue;
  }
  return Object.values(byKey).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

function getShortBaseTime() {
  // 기상청 단기예보 발표시각: 02/05/08/11/14/17/20/23시 (10분 후 사용 가능)
  const slots = [23, 20, 17, 14, 11, 8, 5, 2];
  const kst = new Date(Date.now() + 9 * 3600 * 1000); // UTC+9
  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();

  for (const s of slots) {
    if (h > s || (h === s && m >= 10)) {
      const d = new Date(kst);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      return { baseDate: `${yyyy}${mm}${dd}`, baseTime: `${String(s).padStart(2, "0")}00` };
    }
  }
  // 자정 직후 — 어제 23시 기준
  const y = new Date(kst);
  y.setUTCDate(y.getUTCDate() - 1);
  const yyyy = y.getUTCFullYear();
  const mm = String(y.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(y.getUTCDate()).padStart(2, "0");
  return { baseDate: `${yyyy}${mm}${dd}`, baseTime: "2300" };
}

// ============ 중기 육상 예보 (강수확률 + 날씨) ============
async function fetchMidLand(key, regId) {
  const tmFc = getMidBaseTime();
  const params = new URLSearchParams({
    serviceKey: key,
    pageNo: "1",
    numOfRows: "10",
    dataType: "JSON",
    regId,
    tmFc
  });
  const url = `https://apis.data.go.kr/1360000/MidFcstInfoService/getMidLandFcst?${params}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    return j.response?.body?.items?.item?.[0] || null;
  } catch (_) {
    return null;
  }
}

// ============ 중기 기온 (최고/최저) ============
async function fetchMidTemp(key, regId) {
  const tmFc = getMidBaseTime();
  const params = new URLSearchParams({
    serviceKey: key,
    pageNo: "1",
    numOfRows: "10",
    dataType: "JSON",
    regId,
    tmFc
  });
  const url = `https://apis.data.go.kr/1360000/MidFcstInfoService/getMidTa?${params}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    return j.response?.body?.items?.item?.[0] || null;
  } catch (_) {
    return null;
  }
}

function getMidBaseTime() {
  // 중기예보 발표: 06시, 18시 (KST). 6시간 이상 지난 가장 최근 사용
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const h = kst.getUTCHours();
  const d = new Date(kst);
  let baseHour;
  if (h >= 18) baseHour = 18;
  else if (h >= 6) baseHour = 6;
  else {
    d.setUTCDate(d.getUTCDate() - 1);
    baseHour = 18;
  }
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}${String(baseHour).padStart(2, "0")}00`;
}

// ============ 에어코리아 미세먼지 ============
async function fetchAirQuality(key) {
  const params = new URLSearchParams({
    serviceKey: key,
    returnType: "json",
    numOfRows: "100",
    pageNo: "1",
    sidoName: "제주",
    ver: "1.0"
  });
  const url = `https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty?${params}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const items = j.response?.body?.items || [];
    if (!items.length) return null;
    // 제주시 측정소 또는 평균값
    const valid = items.filter(it => it.pm10Value !== "-" && it.pm10Value);
    if (!valid.length) return null;
    const avg = arr => Math.round(arr.reduce((a, b) => a + parseFloat(b), 0) / arr.length);
    const pm10 = avg(valid.map(it => it.pm10Value));
    const pm25 = avg(valid.filter(it => it.pm25Value !== "-").map(it => it.pm25Value));
    return {
      pm10,
      pm25,
      pm10Grade: gradePM10(pm10),
      pm25Grade: gradePM25(pm25),
      dataTime: valid[0].dataTime
    };
  } catch (_) {
    return null;
  }
}

function gradePM10(v) {
  if (v <= 30) return "좋음";
  if (v <= 80) return "보통";
  if (v <= 150) return "나쁨";
  return "매우나쁨";
}
function gradePM25(v) {
  if (v <= 15) return "좋음";
  if (v <= 35) return "보통";
  if (v <= 75) return "나쁨";
  return "매우나쁨";
}

// ============ 일별 집계 (오늘~+7일) ============
function aggregateDaily(hourly, midLand, midTemp) {
  // 단기예보로부터 오늘~+2일 집계
  const byDay = {};
  for (const h of hourly) {
    if (!byDay[h.date]) {
      byDay[h.date] = {
        date: h.date,
        tempMin: null,
        tempMax: null,
        rainProbMax: 0,
        skySnapshot: null,
        ptySnapshot: null,
        hours: []
      };
    }
    if (h.TMN && h.TMN !== "-") byDay[h.date].tempMin = parseFloat(h.TMN);
    if (h.TMX && h.TMX !== "-") byDay[h.date].tempMax = parseFloat(h.TMX);
    if (h.POP) byDay[h.date].rainProbMax = Math.max(byDay[h.date].rainProbMax, parseInt(h.POP));
    if (h.time === "1200") {
      byDay[h.date].skySnapshot = h.SKY;
      byDay[h.date].ptySnapshot = h.PTY;
    }
    byDay[h.date].hours.push(h);
  }
  // TMN/TMX 누락 시 시간별 TMP 최소·최대로 보완
  for (const d of Object.values(byDay)) {
    if (d.tempMin == null || d.tempMax == null) {
      const temps = d.hours.filter(x => x.TMP).map(x => parseFloat(x.TMP));
      if (temps.length) {
        if (d.tempMin == null) d.tempMin = Math.min(...temps);
        if (d.tempMax == null) d.tempMax = Math.max(...temps);
      }
    }
  }
  let daily = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));

  // 중기예보로 +3~+7일 보강
  if (midLand && midTemp) {
    const baseDate = new Date(Date.now() + 9 * 3600 * 1000);
    for (let i = 3; i <= 7; i++) {
      const d = new Date(baseDate);
      d.setUTCDate(d.getUTCDate() + i);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const date = `${yyyy}${mm}${dd}`;
      const tMin = midTemp[`taMin${i}`];
      const tMax = midTemp[`taMax${i}`];
      const wf = midLand[`wf${i}Am`] || midLand[`wf${i}`];
      const rnSt = midLand[`rnSt${i}Am`] || midLand[`rnSt${i}`];
      daily.push({
        date,
        tempMin: tMin != null ? parseFloat(tMin) : null,
        tempMax: tMax != null ? parseFloat(tMax) : null,
        rainProbMax: rnSt != null ? parseInt(rnSt) : 0,
        skyDescription: wf || "",
        hours: []
      });
    }
  }

  return daily.slice(0, 8); // 오늘 + 7일
}
