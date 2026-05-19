#!/usr/bin/env node
/**
 * scripts/fetch-nier-lake.js
 *
 * 환경부 NIER 물환경 수질측정망 getWaterMeasuringList API
 * 호소수(댐) 월간 측정 데이터 수집.
 *
 * 측정소:
 *   4001B20 섬진강댐2(옥정호) — 정읍시 산내면 (정읍 수원)
 *   2001B30 안동댐1 — 안동시 성곡동 댐앞 (안동 수원)
 *
 * 받는 항목: pH, DO, BOD, COD, SS, TN, TP, TOC, Chl-a, EC, 수온, 투명도
 *
 * NIER 응답 패턴은 자동측정망과 동일 (루트 키 = 오퍼레이션명, 대문자 필드)
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const SERVICE_KEY = process.env.DATA_GO_KR_KEY;
if (!SERVICE_KEY) {
  console.error('FATAL: DATA_GO_KR_KEY env var is required');
  process.exit(1);
}

const LAKES = [
  { regionId: 'jeongeup', ptNo: '4001B20', ptNm: '섬진강댐2(옥정호)', source: '환경부 호소수 측정망 (4001B20 옥정호 · 정읍시 산내면)' },
  { regionId: 'andong',   ptNo: '2001B30', ptNm: '안동댐1',           source: '환경부 호소수 측정망 (2001B30 안동댐1 · 안동시 성곡동)' }
];

function num(v) {
  if (v === null || v === undefined || v === '' || v === '-' || v === 'n/a') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function get(item, ...keys) {
  for (const k of keys) {
    if (item[k] !== undefined && item[k] !== null && item[k] !== '') return item[k];
  }
  return null;
}

async function fetchLake({ regionId, ptNo, ptNm, source }) {
  // 최근 3년 데이터
  const years = [];
  const now = new Date();
  for (let y = now.getFullYear(); y >= now.getFullYear() - 2; y--) years.push(String(y));

  const params = new URLSearchParams({
    serviceKey: SERVICE_KEY,
    resultType: 'json',
    numOfRows: '60',
    pageNo: '1',
    ptNoList: ptNo,
    wmyrList: years.join(',')
  });
  const url = `http://apis.data.go.kr/1480523/WaterQualityService/getWaterMeasuringList?${params}`;

  console.log(`[lake/${regionId}] ptNo=${ptNo} years=${years.join(',')}`);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      console.error(`[lake/${regionId}] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return [];
    }
    const text = await res.text();

    let json;
    try { json = JSON.parse(text); }
    catch (e) {
      console.error(`[lake/${regionId}] JSON parse failed: ${text.slice(0, 200)}`);
      return [];
    }

    if (json.OpenAPI_ServiceResponse) {
      const err = json.OpenAPI_ServiceResponse.cmmMsgHeader || {};
      console.error(`[lake/${regionId}] OpenAPI error: ${err.errMsg} / ${err.returnAuthMsg}`);
      return [];
    }

    // NIER 응답 구조 패턴: { getWaterMeasuringList: { header, item: [...] } }
    const root = json.getWaterMeasuringList || json.response || json;
    const header = root.header || {};
    const code = header.code || header.resultCode;
    if (code && code !== '00' && code !== '0') {
      console.error(`[lake/${regionId}] API error code ${code}: ${header.message || header.resultMsg}`);
      return [];
    }

    let items = root.item || root.items?.item || root.items || [];
    if (!Array.isArray(items)) items = [items];

    // 디버깅: 첫 page 1회만 키 출력
    if (items.length > 0) {
      console.log(`[lake/${regionId}] got ${items.length} items. First item keys: [${Object.keys(items[0]).slice(0, 20).join(', ')}...]`);
    }

    if (items.length === 0) {
      console.warn(`[lake/${regionId}] no items returned`);
      return [];
    }

    const results = [];
    for (const it of items) {
      // 검사일자: wmcymd 또는 WMCYMD (예: "2024.05.15")
      const wmcymd = String(get(it, 'WMCYMD', 'wmcymd') || '');
      const date = wmcymd.replace(/\./g, '-').slice(0, 10);
      if (!date) continue;

      // 측정월(wmod) 기반 period
      const wmyr = get(it, 'WMYR', 'wmyr');
      const wmod = get(it, 'WMOD', 'wmod');
      const period = (wmyr && wmod) ? `${wmyr}-${String(wmod).padStart(2, '0')}` : date.slice(0, 7);

      results.push({
        region: regionId,
        date,
        period,
        ptNo: get(it, 'PTNO', 'ptNo') || ptNo,
        ptNm: get(it, 'PTNM', 'ptNm') || ptNm,
        addr: get(it, 'ADDR', 'addr'),
        orgNm: get(it, 'ORGNM', 'orgNm'),
        ph:        num(get(it, 'ITEMPH', 'itemPh')),
        do_:       num(get(it, 'ITEMDOC', 'itemDoc')),
        bod:       num(get(it, 'ITEMBOD', 'itemBod')),
        cod:       num(get(it, 'ITEMCOD', 'itemCod')),
        ss:        num(get(it, 'ITEMSS',  'itemSs')),
        tn:        num(get(it, 'ITEMTN',  'itemTn')),
        tp:        num(get(it, 'ITEMTP',  'itemTp')),
        toc:       num(get(it, 'ITEMTOC', 'itemToc')),
        chlA:      num(get(it, 'ITEMCLOA','itemCloa')),
        ec:        num(get(it, 'ITEMEC',  'itemEc')),
        temp:      num(get(it, 'ITEMTEMP','itemTemp')),
        trans:     num(get(it, 'ITEMTRANS','itemTrans')),
        tcoli:     num(get(it, 'ITEMTCOLI','itemTcoli')),
        source
      });
    }

    results.sort((a, b) => b.date.localeCompare(a.date));
    if (results.length > 0) {
      const r = results[0];
      console.log(`[lake/${regionId}] latest ${r.date}: pH=${r.ph}, DO=${r.do_}, BOD=${r.bod}, TOC=${r.toc}, Chl-a=${r.chlA}`);
    }
    return results;
  } catch (e) {
    console.error(`[lake/${regionId}] exception: ${e.message}`);
    return [];
  }
}

async function main() {
  const dataDir = path.resolve('data');
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'lake-monthly.json');

  let existing = [];
  try {
    existing = JSON.parse(await fs.readFile(file, 'utf-8'));
    if (!Array.isArray(existing)) existing = [];
  } catch (e) {
    console.log(`[lake] starting fresh lake-monthly.json`);
  }

  console.log(`[lake] fetching at ${new Date().toISOString()}`);
  const arrays = await Promise.all(LAKES.map(fetchLake));
  const allFetched = arrays.flat();
  console.log(`[lake] total fetched: ${allFetched.length}`);

  if (allFetched.length === 0) {
    console.warn(`[lake] no data. lake-monthly.json unchanged.`);
    process.exit(0);
  }

  let added = 0, updated = 0;
  for (const m of allFetched) {
    const idx = existing.findIndex(r => r.region === m.region && r.date === m.date);
    if (idx >= 0) { existing[idx] = m; updated++; } else { existing.push(m); added++; }
  }
  console.log(`[lake] added ${added}, updated ${updated}`);

  existing.sort((a, b) => b.date.localeCompare(a.date) || a.region.localeCompare(b.region));

  // 5년치만 유지
  const cutoffYear = new Date().getFullYear() - 5;
  existing = existing.filter(r => r.date && r.date >= `${cutoffYear}-01-01`);

  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n');
  console.log(`[lake] saved ${existing.length} records to ${file}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
