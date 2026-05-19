#!/usr/bin/env node
/**
 * scripts/fetch-monthly.js
 *
 * 한국수자원공사 상수도법정수질정보(qltWtrSvc/MonPurification) API를 호출하여
 * 안성·정읍·안동 정수장의 전월 법정수질검사 결과를 받아 data/monthly.json에 누적한다.
 *
 * 별도의 정수장 코드 없이 시도/시군명만으로 직접 조회 가능 (이게 큰 장점).
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

const REGIONS = [
  { regionId: 'anseong',  BSI: '경기도',   SIGUN: '안성시', source: '한국수자원공사 상수도법정수질정보 (안성시)' },
  { regionId: 'jeongeup', BSI: '전라북도', SIGUN: '정읍시', source: '한국수자원공사 상수도법정수질정보 (정읍시)' },
  { regionId: 'andong',   BSI: '경상북도', SIGUN: '안동시', source: '한국수자원공사 상수도법정수질정보 (안동시)' }
];

function prevMonthKST() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return { year: String(d.getFullYear()), month: String(d.getMonth() + 1).padStart(2, '0') };
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '-' || t === '불검출' || t === '검출' || t === '적합' || t === '부적합') return null;
  }
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchRegion({ regionId, BSI, SIGUN, source }, year, month) {
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
      console.warn(`[${regionId}] no items for ${year}-${month} (${BSI} ${SIGUN})`);
      return null;
    }

    // 정수장이 여러 개인 경우 첫 번째 항목 사용 (필요 시 정수장명으로 필터)
    const it = items[0];
    const collDat = String(it.COLL_DAT || '');
    const periodStr = collDat.length >= 6
      ? `${collDat.slice(0, 4)}-${collDat.slice(4, 6)}`
      : `${year}-${month}`;

    return {
      region: regionId,
      period: periodStr,
      facility: it.FCLT_NAM || null,
      collectedAt: collDat ? `${collDat.slice(0,4)}-${collDat.slice(4,6)}-${collDat.slice(6,8)}` : null,
      // 한국 수도법 수질검사 필드명 (기술문서 명세 기준)
      hardness:  num(it.HR),    // 경도 mg/L
      ph:        num(it.PH),    // pH
      cu:        num(it.CU),    // 동(구리) mg/L
      zn:        num(it.ZN),    // 아연 mg/L
      pb:        num(it.PB),    // 납 mg/L
      fe:        num(it.FE),    // 철 mg/L
      mn:        num(it.MN),    // 망간 mg/L
      as_:       num(it.AS),    // 비소 mg/L
      cd:        num(it.CD),    // 카드뮴 mg/L
      hg:        num(it.HG),    // 수은 mg/L
      cr:        num(it.CR),    // 크롬 mg/L
      al:        num(it.AL),    // 알루미늄 mg/L
      turbidity: num(it.TU),    // 탁도 NTU
      rc:        num(it.RC),    // 잔류염소 mg/L
      cl:        num(it.CL),    // 염소이온 mg/L
      so:        num(it.SO),    // 황산이온 mg/L
      re:        num(it.RE),    // 증발잔류물 mg/L
      kmn:       num(it.KMN),   // 과망간산칼륨소비량 mg/L
      // Ca, Mg는 한국 수도법 검사 표준 항목이 아님. 경도(HR)로 대체.
      ca:        null,
      mg:        null,
      ec:        null,          // 법정수질 API에 EC 항목 없음 (자동측정망에서 별도 제공)
      source,
      inspector: it.INORG_NAM || null,
      publishedAt: it.UPDATE_DAT || null
    };
  } catch (e) {
    console.error(`[${regionId}] fetch failed: ${e.message}`);
    return null;
  }
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

  const { year, month } = prevMonthKST();
  console.log(`[monthly] Fetching for ${year}-${month}...`);

  const results = await Promise.all(REGIONS.map(r => fetchRegion(r, year, month)));
  const fetched = results.filter(Boolean);
  console.log(`[monthly] Fetched ${fetched.length}/${REGIONS.length} regions`);

  if (fetched.length === 0) {
    console.warn(`[monthly] No data for ${year}-${month}. Trying previous month...`);
    // 전월 데이터가 아직 공개 안 됐을 수 있어서 그 전 달도 시도
    const d = new Date(Date.parse(`${year}-${month}-01`));
    d.setMonth(d.getMonth() - 1);
    const fallbackY = String(d.getFullYear());
    const fallbackM = String(d.getMonth() + 1).padStart(2, '0');
    console.log(`[monthly] Fallback to ${fallbackY}-${fallbackM}`);
    const r2 = await Promise.all(REGIONS.map(r => fetchRegion(r, fallbackY, fallbackM)));
    fetched.push(...r2.filter(Boolean));
  }

  if (fetched.length === 0) {
    console.warn('[monthly] No data found. monthly.json unchanged.');
    process.exit(0);
  }

  for (const m of fetched) {
    existing = existing.filter(r => !(r.region === m.region && r.period === m.period));
    existing.push(m);
    console.log(`  + ${m.region} ${m.period}: HR=${m.hardness}, Fe=${m.fe}, Mn=${m.mn}, Pb=${m.pb} (${m.facility})`);
  }

  existing.sort((a, b) => b.period.localeCompare(a.period) || a.region.localeCompare(b.region));

  await fs.writeFile(monthlyFile, JSON.stringify(existing, null, 2) + '\n');
  console.log(`[monthly] Saved ${existing.length} records to ${monthlyFile}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
