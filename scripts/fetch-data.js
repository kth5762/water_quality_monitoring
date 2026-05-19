#!/usr/bin/env node
/**
 * scripts/fetch-data.js
 *
 * 환경부 NIER 수질자동측정망 getRealTimeWaterQualityList API 호출.
 *
 * 실제 응답 구조 (가이드 문서와 다름!):
 *   {
 *     "getRealTimeWaterQualityList": {
 *       "header": { "code": "00", "message": "NORMAL SERVICE" },
 *       "item": [
 *         { "ROWNO": 1, "SITE_ID": "S04004", "SITE_NAME": "옥정호",
 *           "MSR_DATE": "2025-11-21",
 *           "M01": 0, "M02": null, "M03": null, ..., "M40": 110.23, ... }
 *       ]
 *     }
 *   }
 *
 * 필드 매핑:
 *   M02/M38/M69 = 수온(℃)
 *   M03/M39/M70 = pH
 *   M04/M40/M71 = EC(μS/cm)
 *   M05/M41/M72 = DO(mg/L)
 *   M06/M81     = TOC(mg/L)
 *   M79/M80/M73 = 탁도(NTU)
 *
 * 같은 측정 항목에 1·2·3번 센서가 있으므로 첫 유효값 사용.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const SERVICE_KEY = process.env.DATA_GO_KR_KEY;
if (!SERVICE_KEY) {
  console.error('FATAL: DATA_GO_KR_KEY env var is required');
  process.exit(1);
}

const REGION_TO_SITE = [
  { regionId: 'anseong',  siteId: 'S01023', siteName: '청미천',  source: '환경부 자동측정망 (S01023 청미천 · 안성시 일죽면)' },
  { regionId: 'jeongeup', siteId: 'S04004', siteName: '옥정호',  source: '환경부 자동측정망 (S04004 옥정호 · 정읍시 수원)' },
  { regionId: 'andong',   siteId: 'S02011', siteName: '안동',    source: '환경부 자동측정망 (S02011 안동 · 안동시)' }
];

function todayKST() {
  const d = new Date();
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

function dateRangeKST(daysBack) {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const end = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  now.setDate(now.getDate() - daysBack);
  const start = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return { start, end };
}

function num(v) {
  if (v === null || v === undefined || v === '' || v === '-' || v === 'n/a' || v === 'N/A') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// 후보 키 리스트에서 첫 유효 측정값 반환 (1·2·3번 센서 fallback)
function pickFirstValid(item, keys) {
  for (const k of keys) {
    const v = num(item[k]);
    if (v !== null) return v;
  }
  return null;
}

async function fetchSite({ regionId, siteId, siteName, source }) {
  const { start, end } = dateRangeKST(365);  // 1년 범위 (공개 지연 대응)

  const params = new URLSearchParams({
    serviceKey: SERVICE_KEY,
    resultType: 'json',
    numOfRows: '30',
    pageNo: '1',
    siteId: siteId,
    startDate: start,
    endDate: end
  });
  const url = `http://apis.data.go.kr/1480523/WaterQualityService/getRealTimeWaterQualityList?${params}`;

  console.log(`[${regionId}] siteId=${siteId} range=${start.slice(0,8)}~${end.slice(0,8)}`);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[${regionId}] HTTP ${res.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const text = await res.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.error(`[${regionId}] JSON parse failed. Response: ${text.slice(0, 300)}`);
      return null;
    }

    // 공공데이터포털 에러 봉투
    if (json.OpenAPI_ServiceResponse) {
      const err = json.OpenAPI_ServiceResponse.cmmMsgHeader || {};
      console.error(`[${regionId}] OpenAPI error: ${err.errMsg} / ${err.returnAuthMsg} / code=${err.returnReasonCode}`);
      return null;
    }

    // === 실제 NIER 응답 구조에 맞춘 파싱 ===
    // 루트 키는 오퍼레이션명과 동일: getRealTimeWaterQualityList
    // header.code='00'이면 정상, item은 직접 배열
    const root = json.getRealTimeWaterQualityList || json.response || json;

    const header = root.header || {};
    const code = header.code || header.resultCode;
    const message = header.message || header.resultMsg;
    if (code && code !== '00' && code !== '0') {
      console.error(`[${regionId}] API error code ${code}: ${message}`);
      return null;
    }

    // item은 직접 배열, 또는 (구버전 호환) items.item 또는 items 배열
    let items = root.item || root.items?.item || root.items || [];
    if (!Array.isArray(items)) items = [items];
    if (items.length === 0) {
      console.warn(`[${regionId}] no items returned`);
      return null;
    }

    // 가장 최신 MSR_DATE 항목 선택
    items.sort((a, b) => {
      const da = String(a.MSR_DATE || a.msrDate || '');
      const db = String(b.MSR_DATE || b.msrDate || '');
      return db.localeCompare(da);
    });
    const it = items[0];

    // 대문자 우선, 소문자 fallback으로 필드 접근
    const get = (caps, low) => it[caps] !== undefined ? it[caps] : it[low];

    const msrDateRaw = String(get('MSR_DATE', 'msrDate') || '');
    const date = msrDateRaw.slice(0, 10) || todayKST();

    const result = {
      region: regionId,
      date,
      msrDate: get('MSR_DATE', 'msrDate') || null,
      siteId: get('SITE_ID', 'siteId') || siteId,
      siteName: get('SITE_NAME', 'siteName') || siteName,
      // 같은 항목에 1/2/3번 센서가 있을 수 있어 첫 유효값 선택
      ph:        pickFirstValid(it, ['M03', 'M39', 'M70', 'm03', 'm39', 'm70']),
      ec:        pickFirstValid(it, ['M04', 'M40', 'M71', 'm04', 'm40', 'm71']),
      turbidity: pickFirstValid(it, ['M79', 'M80', 'M73', 'm79', 'm80', 'm73']),
      do_:       pickFirstValid(it, ['M05', 'M41', 'M72', 'm05', 'm41', 'm72']),
      toc:       pickFirstValid(it, ['M06', 'M81', 'm06', 'm81']),
      temp:      pickFirstValid(it, ['M02', 'M38', 'M69', 'm02', 'm38', 'm69']),
      // 추가 항목 (참고용)
      tn:        pickFirstValid(it, ['M27']),
      tp:        pickFirstValid(it, ['M28']),
      chlA:      pickFirstValid(it, ['M29']),
      residualChlorine: null,  // NIER에 없음
      source
    };
    console.log(`[${regionId}] OK: date=${result.date}, pH=${result.ph}, EC=${result.ec}, turb=${result.turbidity}, DO=${result.do_}, TOC=${result.toc}`);
    return result;
  } catch (e) {
    console.error(`[${regionId}] exception: ${e.message}`);
    return null;
  }
}

async function main() {
  const dataDir = path.resolve('data');
  await fs.mkdir(dataDir, { recursive: true });

  const dailyFile = path.join(dataDir, 'daily.json');
  let existing = [];
  try {
    existing = JSON.parse(await fs.readFile(dailyFile, 'utf-8'));
    if (!Array.isArray(existing)) existing = [];
  } catch (e) {
    console.log(`Starting fresh daily.json: ${e.code || e.message}`);
  }

  console.log(`[daily] Fetching at KST ${todayKST()}...`);
  const results = await Promise.all(REGION_TO_SITE.map(fetchSite));
  const fetched = results.filter(Boolean);
  console.log(`[daily] Fetched ${fetched.length}/${REGION_TO_SITE.length} sites`);

  if (fetched.length === 0) {
    console.warn('[daily] No new data. daily.json unchanged.');
    process.exit(0);
  }

  for (const m of fetched) {
    existing = existing.filter(r => !(r.region === m.region && r.date === m.date));
    existing.push(m);
  }

  existing.sort((a, b) => b.date.localeCompare(a.date) || a.region.localeCompare(b.region));

  const cutoff = new Date(Date.now() - 730 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  existing = existing.filter(r => r.date >= cutoff);

  await fs.writeFile(dailyFile, JSON.stringify(existing, null, 2) + '\n');
  console.log(`[daily] Saved ${existing.length} records to ${dailyFile}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
