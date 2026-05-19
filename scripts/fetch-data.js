#!/usr/bin/env node
/**
 * scripts/fetch-data.js (디버깅 강화판)
 *
 * NIER 수질자동측정망 getRealTimeWaterQualityList API 호출.
 * 응답 구조를 로그에 그대로 찍어서 문제 진단 가능하게 함.
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

async function fetchSite({ regionId, siteId, siteName, source }) {
  const { start, end } = dateRangeKST(180);  // 180일로 확대

  const params = new URLSearchParams({
    serviceKey: SERVICE_KEY,
    resultType: 'json',
    numOfRows: '5',
    pageNo: '1',
    siteId: siteId,
    startDate: start,
    endDate: end
  });
  const url = `http://apis.data.go.kr/1480523/WaterQualityService/getRealTimeWaterQualityList?${params}`;

  console.log(`\n========== [${regionId}] site=${siteId} period=${start}~${end} ==========`);
  console.log(`URL: ${url.replace(SERVICE_KEY, '***KEY***')}`);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    console.log(`HTTP ${res.status} ${res.statusText}`);
    const headers = {};
    for (const [k, v] of res.headers.entries()) headers[k] = v;
    console.log(`Headers: ${JSON.stringify(headers)}`);

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Error body (first 500): ${errText.slice(0, 500)}`);
      throw new Error(`HTTP ${res.status}`);
    }

    const text = await res.text();
    console.log(`Response length: ${text.length} chars`);
    console.log(`Response (first 1000 chars):\n${text.slice(0, 1000)}`);
    console.log(`---`);

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.error(`JSON parse failed: ${e.message}`);
      console.error(`Looks like XML/HTML response, not JSON`);
      return null;
    }

    // 공공데이터포털 OpenAPI 에러 봉투 (서비스키 문제 등)
    if (json.OpenAPI_ServiceResponse) {
      const err = json.OpenAPI_ServiceResponse.cmmMsgHeader || {};
      console.error(`OpenAPI error envelope detected:`);
      console.error(`  errMsg: ${err.errMsg}`);
      console.error(`  returnAuthMsg: ${err.returnAuthMsg}`);
      console.error(`  returnReasonCode: ${err.returnReasonCode}`);
      return null;
    }

    const body = json?.response?.body || json?.body;
    if (!body) {
      console.warn(`No body in response.`);
      console.warn(`Top-level keys: [${Object.keys(json).join(', ')}]`);
      console.warn(`Full JSON (first 800): ${JSON.stringify(json).slice(0, 800)}`);
      return null;
    }

    let items = body.items?.item || body.items || [];
    if (!Array.isArray(items)) items = [items];
    if (items.length === 0) {
      console.warn(`No items returned for site ${siteId}`);
      console.warn(`Body: ${JSON.stringify(body).slice(0, 400)}`);
      return null;
    }

    console.log(`Got ${items.length} item(s). First item keys: [${Object.keys(items[0]).slice(0, 15).join(', ')}...]`);

    items.sort((a, b) => String(b.msrDate || '').localeCompare(String(a.msrDate || '')));
    const it = items[0];

    const rawDate = String(it.msrDate || '').slice(0, 10);
    const date = rawDate || todayKST();

    const result = {
      region: regionId,
      date,
      msrDate: it.msrDate || null,
      siteId: it.siteId || siteId,
      siteName: it.siteName || siteName,
      ph:        pickFirstValid(it, ['m03', 'm39', 'm70']),
      ec:        pickFirstValid(it, ['m04', 'm40', 'm71']),
      turbidity: pickFirstValid(it, ['m79', 'm80', 'm73']),
      do_:       pickFirstValid(it, ['m05', 'm41', 'm72']),
      toc:       pickFirstValid(it, ['m06', 'm81']),
      temp:      pickFirstValid(it, ['m02', 'm38', 'm69']),
      residualChlorine: null,
      source
    };
    console.log(`Parsed: pH=${result.ph}, EC=${result.ec}, turb=${result.turbidity}, DO=${result.do_}, TOC=${result.toc}, date=${result.date}`);
    return result;
  } catch (e) {
    console.error(`Exception: ${e.message}`);
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
  console.log(`[daily] SERVICE_KEY length: ${SERVICE_KEY.length} chars, first 8: ${SERVICE_KEY.slice(0, 8)}...`);

  const results = await Promise.all(REGION_TO_SITE.map(fetchSite));
  const fetched = results.filter(Boolean);
  console.log(`\n========== Summary ==========`);
  console.log(`[daily] Fetched ${fetched.length}/${REGION_TO_SITE.length} sites`);

  if (fetched.length === 0) {
    console.warn('[daily] No new data. daily.json unchanged.');
    process.exit(0);
  }

  for (const m of fetched) {
    existing = existing.filter(r => !(r.region === m.region && r.date === m.date));
    existing.push(m);
    console.log(`  + ${m.region} ${m.date}: pH=${m.ph}, EC=${m.ec}, turb=${m.turbidity}, DO=${m.do_}, TOC=${m.toc}`);
  }

  existing.sort((a, b) => b.date.localeCompare(a.date) || a.region.localeCompare(b.region));

  const cutoff = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  existing = existing.filter(r => r.date >= cutoff);

  await fs.writeFile(dailyFile, JSON.stringify(existing, null, 2) + '\n');
  console.log(`[daily] Saved ${existing.length} records to ${dailyFile}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
