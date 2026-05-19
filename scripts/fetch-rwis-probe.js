#!/usr/bin/env node
/**
 * scripts/fetch-rwis-probe.js
 *
 * K-water 실시간 수도정보 수질(시간) API 응답 구조 진단용.
 * 안성(성남/수지) · 정읍(산성) · 안동(용상) 정수장이 RWIS에 등록되어 있는지,
 * 응답 필드 명세는 어떤지 확인한다.
 *
 * 실행 결과를 보고 fetch-rwis.js 정식 페처를 작성한다.
 */

const SERVICE_KEY = process.env.DATA_GO_KR_KEY;
if (!SERVICE_KEY) {
  console.error('FATAL: DATA_GO_KR_KEY env var is required');
  process.exit(1);
}

async function probe(label, url) {
  console.log(`\n========== ${label} ==========`);
  console.log(`URL: ${url.replace(SERVICE_KEY, '***KEY***')}`);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    console.log(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`Length: ${text.length} chars`);
    console.log(`First 2500 chars:\n${text.slice(0, 2500)}`);
    console.log(`---`);
    return text;
  } catch (e) {
    console.error(`Exception: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log(`[probe] SERVICE_KEY len=${SERVICE_KEY.length}, first8=${SERVICE_KEY.slice(0, 8)}...`);

  // Try 1: JSON, numOfRows 큰 페이지, 첫 페이지
  const t1 = await probe(
    'RWIS JSON pageNo=1 numOfRows=300',
    `http://apis.data.go.kr/B500001/rwis/waterQuality/list?serviceKey=${SERVICE_KEY}&numOfRows=300&pageNo=1&_type=json`
  );

  // Try 2: XML
  await probe(
    'RWIS XML pageNo=1 numOfRows=10',
    `http://apis.data.go.kr/B500001/rwis/waterQuality/list?serviceKey=${SERVICE_KEY}&numOfRows=10&pageNo=1`
  );

  // Try 3: returnType 형태 (다른 이름)
  await probe(
    'RWIS returnType=json',
    `http://apis.data.go.kr/B500001/rwis/waterQuality/list?serviceKey=${SERVICE_KEY}&numOfRows=10&pageNo=1&returnType=json`
  );

  // 안성·정읍·안동 정수장 검색
  if (t1) {
    let json;
    try { json = JSON.parse(t1); }
    catch (e) {
      console.log('\n[probe] Try 1 응답이 JSON 파싱 실패. XML일 가능성. 응답 첫 2500자로 구조 파악 필요.');
      return;
    }

    // 다양한 위치에서 items 추출
    const candidates = [
      json?.response?.body?.items?.item,
      json?.response?.body?.items,
      json?.response?.items?.item,
      json?.body?.items?.item,
      json?.list,
      json?.items,
      json?.item
    ];
    let items = null;
    for (const c of candidates) {
      if (Array.isArray(c) && c.length > 0) {
        items = c;
        break;
      } else if (c && typeof c === 'object') {
        items = Array.isArray(c) ? c : [c];
        break;
      }
    }
    if (!items || items.length === 0) {
      console.log('\n[probe] items 못 찾음. 응답 전체 구조:');
      console.log(JSON.stringify(json, null, 2).slice(0, 3000));
      return;
    }

    console.log(`\n========== ANALYSIS ==========`);
    console.log(`총 items: ${items.length}`);
    console.log(`첫 item 키들: [${Object.keys(items[0]).join(', ')}]`);
    console.log(`첫 item 전체:\n${JSON.stringify(items[0], null, 2)}`);

    // 안성·정읍·안동 관련 정수장 찾기
    const keywords = ['성남', '수지', '산성', '용상', '안성', '정읍', '안동', '평택', '동복', '동화'];
    console.log(`\n========== 정수장 검색 (키워드: ${keywords.join(', ')}) ==========`);
    const matches = items.filter(it => {
      const str = JSON.stringify(it);
      return keywords.some(k => str.includes(k));
    });
    console.log(`매칭된 items: ${matches.length}`);
    for (const m of matches.slice(0, 20)) {
      console.log(`  - ${JSON.stringify(m)}`);
    }

    // 모든 정수장명 추출 (어떤 필드에 있는지 확인)
    const allFacilityFields = new Set();
    for (const it of items) {
      for (const [k, v] of Object.entries(it)) {
        if (typeof v === 'string' && /[가-힣]/.test(v)) {
          allFacilityFields.add(k);
        }
      }
    }
    console.log(`\n한글 값을 담는 필드들: [${Array.from(allFacilityFields).join(', ')}]`);

    // 첫 20개 item의 정수장 관련 필드만 추출
    console.log(`\n첫 20개 item의 한글 필드 값:`);
    for (let i = 0; i < Math.min(20, items.length); i++) {
      const it = items[i];
      const koreanFields = {};
      for (const k of allFacilityFields) {
        if (it[k]) koreanFields[k] = it[k];
      }
      console.log(`  [${i}] ${JSON.stringify(koreanFields)}`);
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
