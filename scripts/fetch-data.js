#!/usr/bin/env node
/**
 * scripts/fetch-data.js
 *
 * 환경부 NIER 수질자동측정망 getRealTimeWaterQualityList API.
 *
 * 누적 전략:
 *   응답에 포함된 모든 측정일을 daily.json에 합쳐서 history를 풍부하게 한다.
 *   numOfRows=100으로 약 100일치를 한 번에 받음.
 *   (region, date) 키로 중복 제거하므로 매일 호출해도 안전하게 합쳐짐.
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

function pickFirstValid(item, keys) {
  for (const k of keys) {
    const v = num(item[k]);
    if (v !== null) return v;
  }
  return null;
}

function get(item, caps, low) {
  return item[caps] !== undefined ? item[caps] : item[low];
}

async function fetchSite({ regionId, siteId, siteName, source }) {
  const { start, end } = dateRangeKST(365);

  const params = new URLSearchParams({
    serviceKey: SERVICE_KEY,
    resultType: 'json',
    numOfRows: '100',
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
      return [];
    }
    const text = await res.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.error(`[${regionId}] JSON parse failed. Response: ${text.slice(0, 300)}`);
      return [];
    }

    if (json.OpenAPI_ServiceResponse) {
      const err = json.OpenAPI_ServiceResponse.cmmMsgHeader || {};
      console.error(`[${regionId}] OpenAPI error: ${err.errMsg} / ${err.returnAuthMsg}`);
      return [];
    }

    const root = json.getRealTimeWaterQualityList || json.response || json;
    const header = root.header || {};
    const code = header.code || header.resultCode;
    if (code && code !== '00' && code !== '0') {
      console.error(`[${regionId}] API error code ${code}: ${header.message || header.resultMsg}`);
      return [];
    }

    let items = root.item || root.items?.item || root.items || [];
    if (!Array.isArray(items)) items = [items];
    if (items.length === 0) {
      console.warn(`[${regionId}] no items returned`);
      return [];
    }

    // 모든 측정일을 파싱해서 배열로 반환
    const results = [];
    const fetchedAt = new Date().toISOString();

    for (const it of items) {
      const msrDateRaw = String(get(it, 'MSR_DATE', 'msrDate') || '');
      const date = msrDateRaw.slice(0, 10);
      if (!date) continue;

      results.push({
        region: regionId,
        date,
        msrDate: get(it, 'MSR_DATE', 'msrDate') || null,
        siteId: get(it, 'SITE_ID', 'siteId') || siteId,
        siteName: get(it, 'SITE_NAME', 'siteName') || siteName,
        ph:        pickFirstValid(it, ['M03', 'M39', 'M70', 'm03', 'm39', 'm70']),
        ec:        pickFirstValid(it, ['M04', 'M40', 'M71', 'm04', 'm40', 'm71']),
        turbidity: pickFirstValid(it, ['M79', 'M80', 'M73', 'm79', 'm80', 'm73']),
        do_:       pickFirstValid(it, ['M05', 'M41', 'M72', 'm05', 'm41', 'm72']),
        toc:       pickFirstValid(it, ['M06', 'M81', 'm06', 'm81']),
        temp:      pickFirstValid(it, ['M02', 'M38', 'M69', 'm02', 'm38', 'm69']),
        tn:        pickFirstValid(it, ['M27']),
        tp:        pickFirstValid(it, ['M28']),
        chlA:      pickFirstValid(it, ['M29']),
        residualChlorine: null,
        source,
        fetchedAt
      });
    }

    if (results.length === 0) {
      console.warn(`[${regionId}] items parsed but no valid dates`);
      return [];
    }

    results.sort((a, b) => b.date.localeCompare(a.date));
    console.log(`[${regionId}] parsed ${results.length} measurements (${results[results.length-1].date} ~ ${results[0].date})`);
    console.log(`  latest: pH=${results[0].ph}, EC=${results[0].ec}, turb=${results[0].turbidity}, DO=${results[0].do_}`);
    return results;
  } catch (e) {
    console.error(`[${regionId}] exception: ${e.message}`);
    return [];
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
  const arrays = await Promise.all(REGION_TO_SITE.map(fetchSite));
  const allFetched = arrays.flat();
  console.log(`[daily] Fetched total ${allFetched.length} measurements`);

  if (allFetched.length === 0) {
    console.warn('[daily] No new data. daily.json unchanged.');
    process.exit(0);
  }

  let added = 0, updated = 0;
  for (const m of allFetched) {
    const idx = existing.findIndex(r => r.region === m.region && r.date === m.date);
    if (idx >= 0) {
      existing[idx] = m;
      updated++;
    } else {
      existing.push(m);
      added++;
    }
  }
  console.log(`[daily] Added ${added} new, updated ${updated} existing`);

  existing.sort((a, b) => b.date.localeCompare(a.date) || a.region.localeCompare(b.region));

  const cutoff = new Date(Date.now() - 730 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  existing = existing.filter(r => r.date >= cutoff);

  await fs.writeFile(dailyFile, JSON.stringify(existing, null, 2) + '\n');
  console.log(`[daily] Saved ${existing.length} total records to ${dailyFile}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
