#!/usr/bin/env node
/**
 * scripts/fetch-rwis-probe.js (v2)
 *
 * RWIS API + K-water 다목적댐 수질 가능 endpoints + 코드조회 endpoints.
 * 어느 조합이 totalCount > 0 인지 확인.
 */

const SERVICE_KEY = process.env.DATA_GO_KR_KEY;
if (!SERVICE_KEY) {
  console.error('FATAL: DATA_GO_KR_KEY env var is required');
  process.exit(1);
}

function todayKST_yyyyMMdd() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().replace(/[-:T]/g, '').slice(0, 8);
}
function yesterdayKST_yyyyMMdd() {
  const d = new Date(Date.now() + 9 * 3600 * 1000 - 24 * 3600 * 1000);
  return d.toISOString().replace(/[-:T]/g, '').slice(0, 8);
}

const KEY = SERVICE_KEY;
const today = todayKST_yyyyMMdd();
const yesterday = yesterdayKST_yyyyMMdd();

const probes = [
  // === RWIS 다양한 파라미터 ===
  { label: 'RWIS-1: no params (baseline)',
    url: `http://apis.data.go.kr/B500001/rwis/waterQuality/list?serviceKey=${KEY}&numOfRows=10&pageNo=1&_type=json` },
  { label: 'RWIS-2: mesureBeginDt+mesureEndDt (어제~오늘)',
    url: `http://apis.data.go.kr/B500001/rwis/waterQuality/list?serviceKey=${KEY}&numOfRows=10&pageNo=1&_type=json&mesureBeginDt=${yesterday}&mesureEndDt=${today}` },
  { label: 'RWIS-3: mesureDt 단일 (어제)',
    url: `http://apis.data.go.kr/B500001/rwis/waterQuality/list?serviceKey=${KEY}&numOfRows=10&pageNo=1&_type=json&mesureDt=${yesterday}` },
  { label: 'RWIS-4: searchDate',
    url: `http://apis.data.go.kr/B500001/rwis/waterQuality/list?serviceKey=${KEY}&numOfRows=10&pageNo=1&_type=json&searchDate=${yesterday}` },
  { label: 'RWIS-5: sysid 시도',
    url: `http://apis.data.go.kr/B500001/rwis/waterQuality/list?serviceKey=${KEY}&numOfRows=10&pageNo=1&_type=json&sysid=1` },

  // === RWIS codelist 변형 ===
  { label: 'RWIS codelist',
    url: `http://apis.data.go.kr/B500001/rwis/codelist/list?serviceKey=${KEY}&numOfRows=10&pageNo=1&_type=json` },
  { label: 'RWIS fcltyList',
    url: `http://apis.data.go.kr/B500001/rwis/fcltyList/list?serviceKey=${KEY}&numOfRows=10&pageNo=1&_type=json` },
  { label: 'RWIS stnList',
    url: `http://apis.data.go.kr/B500001/rwis/stnList/list?serviceKey=${KEY}&numOfRows=10&pageNo=1&_type=json` },

  // === 다목적댐 수질 가능 endpoints ===
  { label: 'Dam wq v1: /dam/waterQuality/list',
    url: `http://apis.data.go.kr/B500001/dam/waterQuality/list?serviceKey=${KEY}&numOfRows=10&pageNo=1&_type=json` },
  { label: 'Dam wq v2: /dam/multipurPoseDam/waterQualitylist',
    url: `http://apis.data.go.kr/B500001/dam/multipurPoseDam/waterQualitylist?serviceKey=${KEY}&numOfRows=10&pageNo=1&_type=json` },
  { label: 'Dam wq v3: /multipurPoseDam/waterQuality/list',
    url: `http://apis.data.go.kr/B500001/multipurPoseDam/waterQuality/list?serviceKey=${KEY}&numOfRows=10&pageNo=1&_type=json` },
  { label: 'Dam wq v4: /damWaterQuality/list',
    url: `http://apis.data.go.kr/B500001/damWaterQuality/list?serviceKey=${KEY}&numOfRows=10&pageNo=1&_type=json` },
  { label: 'Dam wq v5: /dam/wq/list',
    url: `http://apis.data.go.kr/B500001/dam/wq/list?serviceKey=${KEY}&numOfRows=10&pageNo=1&_type=json` },

  // === 지방상수도 수질 (15099093) ===
  { label: 'waterinfos/waterquality',
    url: `http://apis.data.go.kr/B500001/waterinfos/waterquality/list?serviceKey=${KEY}&numOfRows=10&pageNo=1&_type=json` },
  { label: 'waterinfos watersgclcodelist',
    url: `http://apis.data.go.kr/B500001/waterinfos/waterquality/watersgcl/watersgclcodelist?serviceKey=${KEY}&numOfRows=10&pageNo=1&_type=json` }
];

async function probe({ label, url }) {
  console.log(`\n========== ${label} ==========`);
  console.log(`URL: ${url.replace(KEY, '***')}`);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    console.log(`HTTP ${res.status}`);
    const text = await res.text();

    if (text.length < 1200) {
      console.log(`Body (${text.length}c): ${text}`);
    } else {
      console.log(`Body (${text.length}c, first 800): ${text.slice(0, 800)}`);
    }

    let totalCount = null;
    try {
      const j = JSON.parse(text);
      totalCount = j?.response?.body?.totalCount ?? j?.body?.totalCount ?? j?.totalCount;
    } catch {
      const m = text.match(/<totalCount>(\d+)<\/totalCount>/);
      if (m) totalCount = m[1];
    }
    if (totalCount !== null && totalCount !== undefined) {
      console.log(`>>> totalCount=${totalCount}` + (Number(totalCount) > 0 ? ' ✓ DATA AVAILABLE' : ''));
    }
  } catch (e) {
    console.error(`EXCEPTION: ${e.message}`);
  }
}

async function main() {
  console.log(`[probe-v2] running at ${new Date().toISOString()}`);
  console.log(`KST yyyyMMdd today=${today} yesterday=${yesterday}`);

  for (const p of probes) {
    await probe(p);
  }

  console.log(`\n========== SUMMARY ==========`);
  console.log(`찾아야 할 것: totalCount > 0 인 endpoint`);
  console.log(`404 / SERVICE ERROR / NO_OPENAPI_SERVICE_ERROR가 나오는 endpoint는 존재 안 함.`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
