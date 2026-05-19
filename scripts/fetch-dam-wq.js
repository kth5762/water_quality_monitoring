#!/usr/bin/env node
/**
 * scripts/fetch-dam-wq.js
 *
 * 한국수자원공사 다목적댐 수질정보 (data.go.kr 15083379, odcloud API)
 * Base: https://api.odcloud.kr/api/15083379/v1/uddi:56a30e1d-f740-4637-a48c-d464a6a63c83
 *
 * 안동댐, 섬진강댐(옥정호) 데이터만 추출하여 data/dam-wq.json에 누적.
 * 응답 구조: { currentCount, data:[...], matchCount, page, perPage, totalCount }
 *
 * 첫 실행 시 응답 전체와 필드 키를 로그로 찍어 구조 확인 가능.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const SERVICE_KEY = process.env.DATA_GO_KR_KEY;
if (!SERVICE_KEY) {
  console.error('FATAL: DATA_GO_KR_KEY env var is required');
  process.exit(1);
}

const BASE_URL = 'https://api.odcloud.kr/api/15083379/v1/uddi:56a30e1d-f740-4637-a48c-d464a6a63c83';

// 매칭 대상 댐
const TARGET_DAMS = [
  { regionId: 'andong',   damKeywords: ['안동'],    excludeKeywords: ['임하', '안동댐2', '안동댐3'] },
  { regionId: 'jeongeup', damKeywords: ['섬진강', '옥정'] }
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

// 어느 키든 매칭되는 값 반환 (필드명을 모를 때 후보 키 순회)
function getField(item, candidates) {
  for (const k of candidates) {
    if (item[k] !== undefined && item[k] !== null && item[k] !== '') return item[k];
  }
  // 부분 일치도 시도
  const lowered = candidates.map(c => c.toLowerCase());
  for (const [k, v] of Object.entries(item)) {
    const kl = String(k).toLowerCase();
    if (lowered.some(c => kl.includes(c)) && v !== null && v !== '') return v;
  }
  return null;
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
    console.log(`[dam-wq] fetch page=${page} perPage=${perPage}`);

    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    } catch (e) {
      console.error(`[dam-wq] fetch failed page=${page}: ${e.message}`);
      break;
    }

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[dam-wq] HTTP ${res.status}: ${errText.slice(0, 300)}`);
      break;
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.error(`[dam-wq] JSON parse failed. Response: ${text.slice(0, 300)}`);
      break;
    }

    const data = json.data || [];
    totalCount = totalCount ?? json.totalCount ?? json.matchCount;
    console.log(`[dam-wq] page=${page}: ${data.length} items (totalCount=${totalCount})`);

    // 첫 페이지의 키 구조 로그 (디버깅용 1회)
    if (page === 1 && data.length > 0) {
      console.log(`[dam-wq] first item keys: [${Object.keys(data[0]).join(', ')}]`);
      console.log(`[dam-wq] first item sample:\n${JSON.stringify(data[0], null, 2)}`);
    }

    all.push(...data);
    if (data.length < perPage) break;        // 마지막 페이지
    if (totalCount && all.length >= totalCount) break;
    if (page >= 20) { console.warn('[dam-wq] reached page limit 20'); break; }
    page++;
  }

  return all;
}

// 데이터 1건을 표준 형식으로 정규화 (필드명 후보 다양하게)
function normalize(item, regionId) {
  return {
    region: regionId,
    damName: getField(item, ['댐명', '시설명', '관측소명', '지점명', 'damNm', 'fcltyNm', 'damName']),
    date:    String(getField(item, ['측정일자', '관측일자', '검사일자', '일자', 'mesureDt', 'date']) || '').slice(0, 10),
    ph:        num(getField(item, ['pH', 'PH', '수소이온농도', 'ph'])),
    ec:        num(getField(item, ['EC', '전기전도도', 'ec'])),
    do_:       num(getField(item, ['DO', '용존산소', 'do', 'do_'])),
    bod:       num(getField(item, ['BOD', '생물화학적산소요구량', 'bod'])),
    cod:       num(getField(item, ['COD', '화학적산소요구량', 'cod'])),
    toc:       num(getField(item, ['TOC', '총유기탄소', 'toc'])),
    turbidity: num(getField(item, ['탁도', 'turbidity', 'TU', 'tu'])),
    temp:      num(getField(item, ['수온', 'temperature', 'temp', 'TEMP'])),
    tn:        num(getField(item, ['총질소', 'TN', 'T-N', 'tn'])),
    tp:        num(getField(item, ['총인', 'TP', 'T-P', 'tp'])),
    ss:        num(getField(item, ['SS', '부유물질', 'ss'])),
    chlA:      num(getField(item, ['클로로필', 'Chl-a', 'chlA', 'chla']))
  };
}

async function main() {
  console.log(`[dam-wq] starting at ${new Date().toISOString()}`);

  const allItems = await fetchAllPages();
  console.log(`[dam-wq] total items fetched: ${allItems.length}`);

  if (allItems.length === 0) {
    console.warn('[dam-wq] no data');
    process.exit(0);
  }

  // 각 region의 keyword에 매칭되는 item들 추출
  const matched = [];
  for (const target of TARGET_DAMS) {
    for (const item of allItems) {
      const damName = String(getField(item, ['댐명', '시설명', '관측소명', '지점명', 'damNm', 'fcltyNm']) || '');
      const hits = target.damKeywords.some(k => damName.includes(k));
      const excluded = (target.excludeKeywords || []).some(k => damName.includes(k));
      if (hits && !excluded) {
        matched.push(normalize(item, target.regionId));
      }
    }
  }
  console.log(`[dam-wq] matched items: ${matched.length}`);

  if (matched.length === 0) {
    // 매칭 실패 시 디버깅을 위해 모든 unique 댐명 출력
    const allNames = new Set();
    for (const item of allItems) {
      const n = getField(item, ['댐명', '시설명', '관측소명', '지점명']);
      if (n) allNames.add(n);
    }
    console.warn(`[dam-wq] no match. All dam/facility names in dataset:`);
    for (const n of allNames) console.warn(`  - ${n}`);
    process.exit(0);
  }

  // 날짜 최신순 정렬
  matched.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  for (const m of matched.slice(0, 5)) {
    console.log(`  [${m.region}] ${m.damName} ${m.date}: pH=${m.ph}, DO=${m.do_}, BOD=${m.bod}, TOC=${m.toc}`);
  }

  // 기존 데이터에 누적
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

  let added = 0, updated = 0;
  for (const m of matched) {
    if (!m.date) continue;
    const idx = existing.findIndex(r => r.region === m.region && r.date === m.date);
    if (idx >= 0) { existing[idx] = m; updated++; } else { existing.push(m); added++; }
  }
  console.log(`[dam-wq] added ${added}, updated ${updated}, total ${existing.length}`);

  existing.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n');
  console.log(`[dam-wq] saved to ${file}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
