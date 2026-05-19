#!/usr/bin/env node
/**
 * scripts/fetch-monthly.js
 *
 * 한국수자원공사 상수도법정수질정보 (qltWtrSvc/MonPurification) API.
 *
 * 시군별로 다양한 검색 변형(queries) 순회:
 *   - 시도명 변경 대응 (전라북도/전북특별자치도 등 2024년 이후 변경분)
 *   - 광역수도사업자 관할 정수장 대응 (안성 → 평택광역 등)
 *   - 일치하는 정수장명 필터링 (facilityHint)
 *   - 마지막 보루: BSI 없이 SIGUN만, 또는 BSI만 + 응답 필터
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const SERVICE_KEY = process.env.DATA_GO_KR_KEY;
if (!SERVICE_KEY) {
  console.error('FATAL: DATA_GO_KR_KEY env var is required');
  process.exit(1);
}

const REGIONS = [
  {
    regionId: 'anseong',
    queries: [
      // 우선순위 순서대로 시도
      { BSI: '경기도', SIGUN: '안성시' },
      // 안성정수장이 평택광역상수도 관할로 등록되어 있을 가능성
      { BSI: '경기도', SIGUN: '평택시', facilityHint: ['안성', '평택'] },
      // 시도명만으로 시도하고 응답에서 시군구 필터
      { BSI: '경기도', sigunguFilter: '안성' },
      { SIGUN: '안성시' }
    ],
    source: '한국수자원공사 상수도법정수질정보 (안성시)'
  },
  {
    regionId: 'jeongeup',
    queries: [
      // 2024년 1월 18일 이후 변경된 새 명칭 우선
      { BSI: '전북특별자치도', SIGUN: '정읍시' },
      { BSI: '전라북도', SIGUN: '정읍시' },
      { BSI: '전북특별자치도', sigunguFilter: '정읍' },
      { BSI: '전라북도', sigunguFilter: '정읍' },
      { SIGUN: '정읍시' }
    ],
    source: '한국수자원공사 상수도법정수질정보 (정읍시)'
  },
  {
    regionId: 'andong',
    queries: [
      { BSI: '경상북도', SIGUN: '안동시' }
    ],
    source: '한국수자원공사 상수도법정수질정보 (안동시)'
  }
];

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '-' || t === '불검출' || t === '검출' || t === '적합' || t === '부적합') return null;
  }
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function field(item, ...keys) {
  for (const k of keys) {
    if (item[k] !== undefined && item[k] !== null) return item[k];
  }
  return null;
}

function extractItems(json) {
  const candidates = [
    json?.response?.body?.items?.item,
    json?.response?.body?.items,
    json?.response?.body?.item,
    json?.MonPurification?.item,
    json?.MonPurification?.items?.item,
    json?.body?.items?.item,
    json?.body?.item,
    json?.item,
    json?.items?.item,
    json?.items
  ];
  for (const c of candidates) {
    if (c) return Array.isArray(c) ? c : [c];
  }
  function deepFind(obj, depth = 0) {
    if (depth > 5 || !obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj)) return null;
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'item' || k === 'items') {
        if (Array.isArray(v)) return v;
        if (typeof v === 'object') return [v];
      }
      const r = deepFind(v, depth + 1);
      if (r) return r;
    }
    return null;
  }
  return deepFind(json) || [];
}

function extractTotalCount(json) {
  const candidates = [
    json?.response?.body?.totalCount,
    json?.response?.body?.itemsInfo?.totalCount,
    json?.MonPurification?.totalCount,
    json?.totalCount
  ];
  for (const c of candidates) {
    if (c !== undefined && c !== null) return Number(c);
  }
  return null;
}

function extractHeader(json) {
  return json?.response?.header || json?.MonPurification?.header || json?.header || {};
}

function prevMonthsKST(months) {
  const out = [];
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  d.setDate(1);
  for (let i = 1; i <= months; i++) {
    d.setMonth(d.getMonth() - 1);
    out.push({ year: String(d.getFullYear()), month: String(d.getMonth() + 1).padStart(2, '0') });
  }
  return out;
}

async function fetchWithQuery(regionId, query, year, month) {
  const params = new URLSearchParams({
    viewType: 'json',
    pageNo: '1',
    numOfRows: '100',
    year, month,
    serviceKey: SERVICE_KEY
  });
  if (query.BSI) params.set('BSI', query.BSI);
  if (query.SIGUN) params.set('SIGUN', query.SIGUN);

  const url = `http://apis.data.go.kr/B500001/qltWtrSvc/MonPurification?${params}`;
  const tag = `${query.BSI || '*'}/${query.SIGUN || query.sigunguFilter || '*'}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      console.error(`[${regionId}] ${year}-${month} (${tag}) HTTP ${res.status}`);
      return null;
    }
    const text = await res.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.error(`[${regionId}] ${year}-${month} (${tag}) JSON parse failed`);
      return null;
    }

    if (json.OpenAPI_ServiceResponse) {
      const err = json.OpenAPI_ServiceResponse.cmmMsgHeader || {};
      console.error(`[${regionId}] OpenAPI error: ${err.errMsg} / ${err.returnAuthMsg}`);
      return null;
    }

    const header = extractHeader(json);
    const code = header.resultCode || header.code;
    if (code && code !== '00' && code !== '0') {
      console.error(`[${regionId}] ${year}-${month} (${tag}) API code ${code}`);
      return null;
    }

    let items = extractItems(json);
    const totalCount = extractTotalCount(json);

    // sigunguFilter 또는 facilityHint로 후처리 필터
    if (items.length > 0 && query.sigunguFilter) {
      items = items.filter(it => {
        const sigungu = String(field(it, 'SIGNGU_NM', 'signguNm') || '');
        return sigungu.includes(query.sigunguFilter);
      });
    }
    if (items.length > 0 && query.facilityHint && Array.isArray(query.facilityHint)) {
      items = items.filter(it => {
        const facility = String(field(it, 'FCLT_NAM', 'fcltNam') || '');
        return query.facilityHint.some(h => facility.includes(h));
      });
    }

    if (items.length === 0) {
      console.log(`[${regionId}] ${year}-${month} (${tag}) no matched items (totalCount=${totalCount ?? '?'})`);
      return null;
    }

    const it = items[0];
    const collDat = String(field(it, 'COLL_DAT', 'collDat') || '');
    const periodStr = collDat.length >= 6
      ? `${collDat.slice(0, 4)}-${collDat.slice(4, 6)}`
      : `${year}-${month}`;

    const result = {
      region: regionId,
      period: periodStr,
      facility: field(it, 'FCLT_NAM', 'fcltNam') || null,
      collectedAt: collDat ? `${collDat.slice(0,4)}-${collDat.slice(4,6)}-${collDat.slice(6,8)}` : null,
      hardness:  num(field(it, 'HR', 'hr')),
      ph:        num(field(it, 'PH', 'ph')),
      cu:        num(field(it, 'CU', 'cu')),
      zn:        num(field(it, 'ZN', 'zn')),
      pb:        num(field(it, 'PB', 'pb')),
      fe:        num(field(it, 'FE', 'fe')),
      mn:        num(field(it, 'MN', 'mn')),
      as_:       num(field(it, 'AS', 'as')),
      cd:        num(field(it, 'CD', 'cd')),
      hg:        num(field(it, 'HG', 'hg')),
      cr:        num(field(it, 'CR', 'cr')),
      al:        num(field(it, 'AL', 'al')),
      turbidity: num(field(it, 'TU', 'tu')),
      rc:        num(field(it, 'RC', 'rc')),
      cl:        num(field(it, 'CL', 'cl')),
      so:        num(field(it, 'SO', 'so')),
      re:        num(field(it, 'RE', 're')),
      kmn:       num(field(it, 'KMN', 'kmn')),
      ca: null, mg: null, ec: null,
      source: REGIONS.find(r => r.regionId === regionId).source,
      inspector: field(it, 'INORG_NAM', 'inorgNam') || null,
      publishedAt: field(it, 'UPDATE_DAT', 'updateDat') || null,
      matchedQuery: tag  // 디버깅: 어떤 검색 조합이 통했는지
    };
    console.log(`[${regionId}] ${year}-${month} (${tag}) OK: HR=${result.hardness}, Fe=${result.fe}, Pb=${result.pb} (${result.facility})`);
    return result;
  } catch (e) {
    console.error(`[${regionId}] ${year}-${month} (${tag}) exception: ${e.message}`);
    return null;
  }
}

async function fetchRegion(region) {
  // 최근 12개월 시도. 각 월마다 모든 query 변형 시도.
  const months = prevMonthsKST(12);
  for (const { year, month } of months) {
    for (const query of region.queries) {
      const r = await fetchWithQuery(region.regionId, query, year, month);
      if (r) return r;
    }
  }
  return null;
}

async function main() {
  const dataDir = path.resolve('data');
  await fs.mkdir(dataDir, { recursive: true });
  const monthlyFile = path.join(dataDir, 'monthly.json');

  let existing = [];
  try {
    existing = JSON.parse(await fs.readFile(monthlyFile, 'utf-8'));
    if (!Array.isArray(existing)) existing = [];
  } catch (e) {
    console.log(`Starting fresh monthly.json: ${e.code || e.message}`);
  }

  console.log(`[monthly] Fetching latest available month per region (with query variants)...`);
  const results = await Promise.all(REGIONS.map(fetchRegion));
  const fetched = results.filter(Boolean);
  console.log(`[monthly] Fetched ${fetched.length}/${REGIONS.length} regions`);

  if (fetched.length === 0) {
    console.warn('[monthly] No data fetched. monthly.json unchanged.');
    process.exit(0);
  }

  for (const m of fetched) {
    existing = existing.filter(r => !(r.region === m.region && r.period === m.period));
    existing.push(m);
  }

  existing.sort((a, b) => b.period.localeCompare(a.period) || a.region.localeCompare(b.region));

  await fs.writeFile(monthlyFile, JSON.stringify(existing, null, 2) + '\n');
  console.log(`[monthly] Saved ${existing.length} records to ${monthlyFile}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
