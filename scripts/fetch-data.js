#!/usr/bin/env node
/**
 * scripts/fetch-data.js
 *
 * 환경부 국립환경과학원 수질자동측정망(getRealTimeWaterQualityList) API를 호출하여
 * 정읍·안동·안성 인근 자동측정소의 최신 수질을 받아 data/daily.json에 누적한다.
 *
 * ⚠️ 주의: NIER API 가이드에 따르면 자동측정망 갱신주기는 "월 1회(3개월 전 데이터 공개)".
 *        진짜 실시간이 아니다. 그러나 데이터가 들어오면 즉시 반영하기 위해 매일 호출한다.
 *
 * 사용 측정소 (물환경_코드_코드명.xlsx에서 확인됨):
 *   S04004 옥정호      → 정읍시 정수장 원수
 *   S02011 안동        → 안동시 정수장 원수
 *   S01023 청미천      → 안성시 일죽면 (안성 인근 가장 가까운 자동측정망)
 *
 * 환경변수:
 *   DATA_GO_KR_KEY  공공데이터포털 일반 인증키(Decoding)
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

// NIER 응답에서 가장 유효한 측정값 선택 (m04/m40/m71은 EC 1·2·3번 센서)
function pickFirstValid(item, keys) {
  for (const k of keys) {
    const v = num(item[k]);
    if (v !== null) return v;
  }
  return null;
}

async function fetchSite({ regionId, siteId, siteName, source }) {
  const { start, end } = dateRangeKST(90);

  const params = new URLSearchParams({
    serviceKey: SERVICE_KEY,
    resultType: 'json',
    numOfRows: '10',
    pageNo: '1',
    siteId: siteId,
    startDate: start,
    endDate: end
  });
  const url = `http://apis.data.go.kr/1480523/WaterQualityService/getRealTimeWaterQualityList?${params}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.error(`[${regionId}] non-JSON response (first 200 chars): ${text.slice(0, 200)}`);
      return null;
    }

    const body = json?.response?.body || json?.body;
    if (!body) {
      console.warn(`[${regionId}] no body in response`);
      return null;
    }
    let items = body.items?.item || body.items || [];
    if (!Array.isArray(items)) items = [items];
    if (items.length === 0) {
      console.warn(`[${regionId}] no items returned (site ${siteId})`);
      return null;
    }

    items.sort((a, b) => String(b.msrDate || '').localeCompare(String(a.msrDate || '')));
    const it = items[0];

    const rawDate = String(it.msrDate || '').slice(0, 10);
    const date = rawDate || todayKST();

    return {
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
  } catch (e) {
    console.error(`[${regionId}] fetch failed: ${e.message}`);
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
    console.log(`  + ${m.region} ${m.date} (msr=${m.msrDate}): pH=${m.ph}, EC=${m.ec}, turb=${m.turbidity}, DO=${m.do_}, TOC=${m.toc}`);
  }

  existing.sort((a, b) => b.date.localeCompare(a.date) || a.region.localeCompare(b.region));

  const cutoff = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  existing = existing.filter(r => r.date >= cutoff);

  await fs.writeFile(dailyFile, JSON.stringify(existing, null, 2) + '\n');
  console.log(`[daily] Saved ${existing.length} records to ${dailyFile}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
