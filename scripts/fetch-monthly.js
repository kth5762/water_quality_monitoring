#!/usr/bin/env node
/**
 * scripts/fetch-monthly.js
 *
 * 한국수자원공사 상수도법정수질정보 (qltWtrSvc/MonPurification) API 호출.
 *
 * NIER 경험상 응답 구조가 가이드 문서와 다를 수 있어 유연한 파서 사용:
 *   - 루트 키: 'response' / 오퍼레이션명('MonPurification') / 무엇이든
 *   - items: items.item / item / items 어느 것이든
 *   - 필드명: 대문자 우선 (HR, PH, FE 등)
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const SERVICE_KEY = process.env.DATA_GO_KR_KEY;
if (!SERVICE_KEY) {
  console.error('FATAL: DATA_GO_KR_KEY env var is required');
  process.exit(1);
}

const REGIONS = [
  { regionId: 'anseong',  BSI: '경기도',   SIGUN: '안성시', source: '한국수자원공사 상수도법정수질정보 (안성시)' },
  { regionId: 'jeongeup', BSI: '전라북도', SIGUN: '정읍시', source: '한국수자원공사 상수도법정수질정보 (정읍시)' },
  { regionId: 'andong',   BSI: '경상북도', SIGUN: '안동시', source: '한국수자원공사 상수도법정수질정보 (안동시)' }
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

// 대문자 우선, 소문자 fallback
function field(item, ...keys) {
  for (const k of keys) {
    if (item[k] !== undefined && item[k] !== null) return item[k];
  }
  return null;
}

// 응답 어디에 items가 있든 찾아냄
function extractItems(json) {
  // 직접 알려진 키부터
  const candidates = [
    json?.response?.body?.items?.item,
    json?.response?.body?.items,
    json?.response?.body?.item,
    json?.response?.item,
    json?.MonPurification?.item,
    json?.MonPurification?.items?.item,
    json?.body?.items?.item,
    json?.body?.item,
    json?.item,
    json?.items?.item,
    json?.items
  ];
  for (const c of candidates) {
    if (c) {
      return Array.isArray(c) ? c : [c];
    }
  }
  // 못 찾으면 객체를 깊이 탐색
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

function extractHeader(json) {
  return json?.response?.header
      || json?.MonPurification?.header
      || json?.header
      || {};
}

function prevMonthsKST(months) {
  // 최근 N개월 [{year, month}, ...] 최신순
  const out = [];
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  d.setDate(1);
  for (let i = 1; i <= months; i++) {
    d.setMonth(d.getMonth() - 1);
    out.push({ year: String(d.getFullYear()), month: String(d.getMonth() + 1).padStart(2, '0') });
  }
  return out;
}

async function fetchRegionForMonth({ regionId, BSI, SIGUN, source }, year, month) {
  const params = new URLSearchParams({
    viewType: 'json',
    pageNo: '1',
    year, month,
    BSI, SIGUN,
    serviceKey: SERVICE_KEY
  });
  const url = `http://apis.data.go.kr/B500001/qltWtrSvc/MonPurification?${params}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      console.error(`[${regionId}] ${year}-${month} HTTP ${res.status}`);
      return null;
    }
    const text = await res.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.error(`[${regionId}] ${year}-${month} JSON parse failed: ${text.slice(0, 200)}`);
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
      console.error(`[${regionId}] ${year}-${month} API code ${code}: ${header.resultMsg || header.message}`);
      return null;
    }

    const items = extractItems(json);
    if (items.length === 0) {
      // 데이터 없음은 일반적임 (해당월에 검사 안 했을 수 있음)
      console.log(`[${regionId}] ${year}-${month} no items`);
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
      // 한국 수도법 수질검사 필드 (기술문서 명세 + 대소문자 양쪽 대응)
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
      ca: null, mg: null, ec: null,  // 한국 수도법 검사 항목 아님
      source,
      inspector: field(it, 'INORG_NAM', 'inorgNam') || null,
      publishedAt: field(it, 'UPDATE_DAT', 'updateDat') || null
    };
    console.log(`[${regionId}] ${year}-${month} OK: HR=${result.hardness}, Fe=${result.fe}, Pb=${result.pb} (${result.facility})`);
    return result;
  } catch (e) {
    console.error(`[${regionId}] ${year}-${month} exception: ${e.message}`);
    return null;
  }
}

async function fetchRegion(region) {
  // 전월부터 거꾸로 최대 6개월까지 시도 (월간 데이터 공개 지연 대응)
  const candidates = prevMonthsKST(6);
  for (const { year, month } of candidates) {
    const r = await fetchRegionForMonth(region, year, month);
    if (r) return r;
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

  console.log(`[monthly] Fetching latest available month per region...`);
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
