#!/usr/bin/env node
/**
 * scripts/fetch-nier-lake.js
 *
 * 환경부 NIER 물환경 수질측정망 getWaterMeasuringList API
 * 호소수(댐) 월간 측정 데이터.
 *
 * 실제 응답 필드 (자동측정망과 다른 언더스코어 패턴):
 *   PT_NO, PT_NM, WMYR, WMOD, WMWK, WMCYMD, WMDEP, ITEM_PH, ITEM_DOC,
 *   ITEM_BOD, ITEM_COD, ITEM_SS, ITEM_TN, ITEM_TP, ITEM_TOC, ITEM_CLOA,
 *   ITEM_TEMP, ITEM_TRANS (투명도), ITEM_TCOLI (총대장균군) 등
 *
 * 같은 날짜에 수심별(WMDEP: 표층/중층/저층) 여러 entry가 있으므로,
 * 가장 표층(WMDEP 가장 작은) entry 1개만 저장.
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
  const years = [];
  const now = new Date();
  for (let y = now.getFullYear(); y >= now.getFullYear() - 2; y--) years.push(String(y));

  const params = new URLSearchParams({
    serviceKey: SERVICE_KEY,
    resultType: 'json',
    numOfRows: '100',
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
    catch (e) { console.error(`[lake/${regionId}] JSON parse failed`); return []; }

    if (json.OpenAPI_ServiceResponse) {
      const err = json.OpenAPI_ServiceResponse.cmmMsgHeader || {};
      console.error(`[lake/${regionId}] OpenAPI error: ${err.errMsg}`);
      return [];
    }

    const root = json.getWaterMeasuringList || json.response || json;
    let items = root.item || root.items?.item || root.items || [];
    if (!Array.isArray(items)) items = [items];

    if (items.length === 0) {
      console.warn(`[lake/${regionId}] no items returned`);
      return [];
    }

    // 각 raw item을 normalize. (region, date)는 중복될 수 있음 - 수심별로 다른 entry.
    const raw = [];
    for (const it of items) {
      const wmcymd = String(get(it, 'WMCYMD', 'wmcymd') || '');
      const date = wmcymd.replace(/\./g, '-').slice(0, 10);
      if (!date) continue;

      const wmyr = get(it, 'WMYR', 'wmyr');
      const wmod = get(it, 'WMOD', 'wmod');
      const period = (wmyr && wmod) ? `${wmyr}-${String(wmod).padStart(2, '0')}` : date.slice(0, 7);
      const depth = num(get(it, 'WMDEP', 'wmdep')) ?? 999;

      raw.push({
        region: regionId,
        date,
        period,
        depth,
        wmwk: get(it, 'WMWK', 'wmwk'),
        ptNo: get(it, 'PT_NO', 'ptNo') || ptNo,
        ptNm: get(it, 'PT_NM', 'ptNm') || ptNm,
        addr: get(it, 'ADDR', 'addr'),
        orgNm: get(it, 'ORG_NM', 'orgNm'),
        // ITEM_* 필드 (언더스코어 있는 정확한 키)
        ph:        num(get(it, 'ITEM_PH', 'itemPh')),
        do_:       num(get(it, 'ITEM_DOC', 'itemDoc')),
        bod:       num(get(it, 'ITEM_BOD', 'itemBod')),
        cod:       num(get(it, 'ITEM_COD', 'itemCod')),
        ss:        num(get(it, 'ITEM_SS', 'itemSs')),
        tn:        num(get(it, 'ITEM_TN', 'itemTn')),
        tp:        num(get(it, 'ITEM_TP', 'itemTp')),
        toc:       num(get(it, 'ITEM_TOC', 'itemToc')),
        chlA:      num(get(it, 'ITEM_CLOA', 'itemCloa')),
        ec:        num(get(it, 'ITEM_EC', 'itemEc')),
        temp:      num(get(it, 'ITEM_TEMP', 'itemTemp')),
        trans:     num(get(it, 'ITEM_TRANS', 'itemTrans')),
        tcoli:     num(get(it, 'ITEM_TCOLI', 'itemTcoli')),
        source
      });
    }

    // 디버깅: 첫 raw item 보기
    if (raw.length > 0) {
      const r0 = raw[0];
      console.log(`[lake/${regionId}] first raw item: ${r0.date} depth=${r0.depth}m pH=${r0.ph} DO=${r0.do_} BOD=${r0.bod} TOC=${r0.toc} Chl-a=${r0.chlA}`);
    }

    // (region, date) 키로 그룹핑 후 가장 표층(depth 작은) 1개만 선택
    const byKey = new Map();
    for (const r of raw) {
      const key = `${r.region}__${r.date}`;
      const existing = byKey.get(key);
      if (!existing || r.depth < existing.depth) {
        byKey.set(key, r);
      }
    }

    const results = Array.from(byKey.values());
    results.sort((a, b) => b.date.localeCompare(a.date));

    console.log(`[lake/${regionId}] raw=${raw.length} entries, deduped to ${results.length} surface entries`);
    if (results.length > 0) {
      const r = results[0];
      console.log(`[lake/${regionId}] latest ${r.date} (수심 ${r.depth}m): pH=${r.ph}, DO=${r.do_}, BOD=${r.bod}, COD=${r.cod}, TOC=${r.toc}, Chl-a=${r.chlA}, TN=${r.tn}, TP=${r.tp}`);
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
    console.warn(`[lake] no data fetched`);
    process.exit(0);
  }

  let added = 0, updated = 0;
  for (const m of allFetched) {
    const idx = existing.findIndex(r => r.region === m.region && r.date === m.date);
    if (idx >= 0) { existing[idx] = m; updated++; } else { existing.push(m); added++; }
  }
  console.log(`[lake] added ${added}, updated ${updated}, total ${existing.length}`);

  existing.sort((a, b) => b.date.localeCompare(a.date) || a.region.localeCompare(b.region));

  const cutoffYear = new Date().getFullYear() - 5;
  existing = existing.filter(r => r.date && r.date >= `${cutoffYear}-01-01`);

  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n');
  console.log(`[lake] saved ${existing.length} records to ${file}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
