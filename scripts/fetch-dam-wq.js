#!/usr/bin/env node
/**
 * scripts/fetch-dam-wq.js
 *
 * 한국수자원공사 다목적댐 수질정보 (data.go.kr 15083379, odcloud API).
 * 실제 응답 키 (전부 한국어):
 *   댐명, 댐코드, 측정월, 수소이온농도지수(pH), 수온, 용존산소(DO),
 *   생물학적 산소요구량(BOD), 화학적 산소요구량(COD), 부유물질(SS),
 *   총질소(T-N), 총인(T-P), 인산염인(PO4-P), 전기전도도, 탁도
 *
 * 안동, 섬진강(옥정호) 댐만 추출하여 data/dam-wq.json 누적.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const SERVICE_KEY = process.env.DATA_GO_KR_KEY;
if (!SERVICE_KEY) {
  console.error('FATAL: DATA_GO_KR_KEY env var is required');
  process.exit(1);
}

const BASE_URL = 'https://api.odcloud.kr/api/15083379/v1/uddi:56a30e1d-f740-4637-a48c-d464a6a63c83';

// 정확한 댐명 매칭 (시군별 정수원)
const TARGET_DAMS = [
  { regionId: 'andong',   matchExact: ['안동'] },          // "안동" 정확 일치 (조정지, 임하 제외)
  { regionId: 'jeongeup', matchExact: ['섬진강'] }         // 섬진강댐(옥정호)
];

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '-' || t === 'n/a' || t === '결측') return null;
  }
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchAllPages() {
  let page = 1;
  const perPage = 500;
  const all = [];
  let totalCount = null;

  while (true) {
    const params = new URLSearchParams({
      page: String(page),
      perPage: String(perPage),
      serviceKey: SERVICE_KEY
    });
    const url = `${BASE_URL}?${params}`;

    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    } catch (e) {
      console.error(`[dam-wq] fetch failed page=${page}: ${e.message}`);
      break;
    }
    if (!res.ok) {
      console.error(`[dam-wq] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      break;
    }

    let json;
    try { json = JSON.parse(await res.text()); }
    catch (e) { console.error(`[dam-wq] JSON parse failed page=${page}`); break; }

    const data = json.data || [];
    totalCount = totalCount ?? json.totalCount ?? json.matchCount;
    console.log(`[dam-wq] page=${page}: ${data.length} items (totalCount=${totalCount})`);

    all.push(...data);
    if (data.length < perPage) break;
    if (totalCount && all.length >= totalCount) break;
    if (page >= 20) { console.warn('[dam-wq] page limit'); break; }
    page++;
  }
  return all;
}

function normalize(item, regionId) {
  // 측정월: "2025-09-25" 형식
  const dateRaw = String(item['측정월'] || '').trim();
  const date = dateRaw.slice(0, 10);
  const period = date.slice(0, 7);  // YYYY-MM

  return {
    region: regionId,
    damName: item['댐명'] || null,
    damCode: item['댐코드'] || null,
    date,
    period,
    ph:        num(item['수소이온농도지수(pH)']),
    temp:      num(item['수온']),
    do_:       num(item['용존산소(DO)']),
    bod:       num(item['생물학적 산소요구량(BOD)']),
    cod:       num(item['화학적 산소요구량(COD)']),
    ss:        num(item['부유물질(SS)']),
    tn:        num(item['총질소(T-N)']),
    tp:        num(item['총인(T-P)']),
    po4p:      num(item['인산염인(PO4-P)']),
    ec:        num(item['전기전도도']),
    turbidity: num(item['탁도']),
    source: '한국수자원공사 다목적댐 수질정보 (odcloud)'
  };
}

async function main() {
  console.log(`[dam-wq] starting at ${new Date().toISOString()}`);

  const allItems = await fetchAllPages();
  console.log(`[dam-wq] total items fetched: ${allItems.length}`);
  if (allItems.length === 0) { console.warn('[dam-wq] no data'); process.exit(0); }

  // 데이터셋의 모든 unique 댐명 출력 (한 번만, 디버깅용)
  const allDamNames = new Set();
  for (const item of allItems) {
    if (item['댐명']) allDamNames.add(item['댐명']);
  }
  console.log(`[dam-wq] all dam names in dataset (${allDamNames.size}): ${Array.from(allDamNames).join(', ')}`);

  // 정확 일치로 매칭 (트레일링 스페이스 등 trim)
  const matched = [];
  for (const target of TARGET_DAMS) {
    let count = 0;
    for (const item of allItems) {
      const damName = String(item['댐명'] || '').trim();
      if (target.matchExact.includes(damName)) {
        matched.push(normalize(item, target.regionId));
        count++;
      }
    }
    console.log(`[dam-wq] ${target.regionId}: matched ${count} items (${target.matchExact.join('/')})`);
  }

  if (matched.length === 0) {
    console.warn(`[dam-wq] no matches with exact damName. Check the dam name list above.`);
    process.exit(0);
  }

  // 날짜 최신순 정렬해서 상위 5개 미리보기
  matched.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  console.log(`[dam-wq] sample matches (latest 5):`);
  for (const m of matched.slice(0, 5)) {
    console.log(`  [${m.region}/${m.damName}] ${m.date}: pH=${m.ph}, temp=${m.temp}, DO=${m.do_}, BOD=${m.bod}, COD=${m.cod}, TN=${m.tn}, TP=${m.tp}`);
  }

  // 누적 저장
  const dataDir = path.resolve('data');
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'dam-wq.json');

  let existing = [];
  try {
    existing = JSON.parse(await fs.readFile(file, 'utf-8'));
    if (!Array.isArray(existing)) existing = [];
  } catch (e) {
    console.log(`[dam-wq] starting fresh dam-wq.json`);
  }

  let added = 0, updated = 0, skipped = 0;
  for (const m of matched) {
    if (!m.date) { skipped++; continue; }
    const idx = existing.findIndex(r => r.region === m.region && r.date === m.date);
    if (idx >= 0) { existing[idx] = m; updated++; } else { existing.push(m); added++; }
  }
  console.log(`[dam-wq] added ${added}, updated ${updated}, skipped(no date) ${skipped}, total ${existing.length}`);

  existing.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.region.localeCompare(b.region));

  // 5년치만 유지
  const cutoffYear = new Date().getFullYear() - 5;
  existing = existing.filter(r => r.date && r.date >= `${cutoffYear}-01-01`);

  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n');
  console.log(`[dam-wq] saved ${existing.length} records to ${file}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
