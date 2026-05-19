# 상수도 수질 모니터링

안성시 · 정읍시 · 안동시 정수장 및 수원지 수질 자동 갱신 대시보드.
공공 API에서 매일 자동으로 데이터를 받아와 누적 기록한다.

## 동작 구조

```
GitHub Actions (매일 KST 09:00)
    │
    ├── 환경부 NIER 자동측정망 API → 일간 데이터
    │   (옥정호·안동·청미천 자동측정 지점)
    │
    └── K-water 상수도법정수질정보 API → 월간 데이터 (매월 5일)
        (안성/정읍/안동 정수장 법정 60항목)
    ↓
data/daily.json, data/monthly.json (저장소에 자동 커밋)
    ↓
GitHub Pages (정적 호스팅)
    ↓
브라우저 (5분마다 자동 새로고침)
```

비용 0원. 서버 운영 불필요. GitHub Free 플랜만으로 동작.

## 사용된 API와 매핑 (이미 코드에 박혀있음)

### 일간 — 환경부 NIER 자동측정망 (`getRealTimeWaterQualityList`)

| 지역 | siteId | 측정소명 | 위치 |
|---|---|---|---|
| 안성시 | `S01023` | 청미천 | 안성시 일죽면 (안성 인근 자동측정망) |
| 정읍시 | `S04004` | 옥정호 | 정읍시 수원지 (섬진강댐) |
| 안동시 | `S02011` | 안동 | 안동시 |

받아오는 항목: pH, EC, 탁도, DO, TOC, 수온

### 월간 — 한국수자원공사 상수도법정수질정보 (`MonPurification`)

시도/시군명으로 직접 조회 — 별도 정수장 코드 불필요.
받아오는 항목: **경도** · **Fe** · **Mn** · **Cu** · **Zn** · **Pb** · **As** · **Al** · pH · 탁도 · 잔류염소 등

⚠️ Ca/Mg는 한국 수도법 검사 표준 항목이 아니라 API에 없음. 경도(Hardness)로 대체.

---

## 사용자 작업 순서

### 1단계 — 공공데이터포털 API 활용신청

이미 [data.go.kr](https://www.data.go.kr)에서 4개 API 활용신청을 마치셨다면 건너뛰세요.

신청해야 할 API (활용신청 즉시 자동승인):

| 데이터 번호 | API명 | 용도 |
|---|---|---|
| **15081073** | 환경부_수질 DB | 일간 자동측정망 |
| **15099032** | 한국수자원공사_상수도법정수질정보 | 월간 법정 검사 |

마이페이지 → 개발계정 → **일반 인증키 (Decoding)** 복사 (Encoding 키 아님 주의).

### 2단계 — GitHub 저장소 생성

1. [github.com](https://github.com) 가입 (무료)
2. **New repository** → 이름 자유 (예: `water-quality-monitor`), **Public** 선택
3. 압축 파일의 모든 파일을 드래그&드롭으로 업로드
   - ⚠️ `.github/workflows/` 폴더가 누락되면 `Add file → Create new file`에서 경로 `.github/workflows/fetch-daily.yml`로 직접 생성

### 3단계 — Secret 등록 (이제 1개만!)

저장소 **Settings → Secrets and variables → Actions → New repository secret**

| 이름 | 값 |
|---|---|
| `DATA_GO_KR_KEY` | 1단계에서 발급받은 Decoding 키 |

끝. 정수장 코드 같은 추가 secret은 더 이상 필요 없습니다 (코드에 매핑이 이미 들어가 있음).

### 4단계 — 첫 실행 (수동 트리거)

1. **Actions** 탭 → 좌측 **Fetch Daily Water Quality** 선택
2. 우측 **Run workflow** 버튼 클릭 → **Run workflow** 확인
3. ~30초 후 초록 체크 ✓ 뜨면 성공
4. **Code** 탭 → `data/daily.json` 확인 — 측정값이 채워져 있어야 함
5. 같은 방식으로 **Fetch Monthly Water Quality**도 실행

실패 시 워크플로우 로그를 클릭해 원인 확인:
- `HTTP 403` 또는 `SERVICE_KEY_IS_NOT_REGISTERED`: 활용신청이 아직 처리 중이거나 키가 잘못됨 → 1~24시간 후 재시도
- `no items returned`: 해당 측정소/시군에 데이터가 아직 공개 안 됨 (NIER 자동측정망은 3개월 지연이 정상)

### 5단계 — GitHub Pages 활성화

1. **Settings → Pages**
2. Source: **Deploy from a branch** → Branch: **main** → **/ (root)** → **Save**
3. 1~2분 후 페이지 배포: `https://{유저명}.github.io/{저장소명}`
4. 페이지 접속 시 자동으로 `data/*.json` 읽어서 화면 표시

---

## 이후 자동 운영

- **매일 KST 09:00** → 일간 페처가 NIER API 호출 → `daily.json` 커밋 → 페이지 자동 갱신
- **매월 5일 KST 09:00** → 월간 페처가 전월 법정수질 호출 → `monthly.json` 커밋
- **5분마다** → 열려있는 페이지가 새 JSON 자동 fetch

⚠️ GitHub Actions의 cron은 **저장소가 60일 비활성**이면 자동 일시정지. 두 달에 한 번은 페이지 방문이나 워크플로우 수동 실행으로 활성 상태 유지.

---

## 데이터 갱신 주기 현실 (중요)

| API | 공식 갱신주기 | 실제 데이터 |
|---|---|---|
| NIER 자동측정망 | 월 1회 (3개월 전 데이터 공개) | 시간별 측정값이 일괄로 들어옴 |
| 상수도법정수질정보 | 월 1회 (관보 게재 후) | 전월~전전월 검사값 |

"매일 자동 갱신"이라고 하지만 한국 공공 수질 데이터는 본질적으로 월간 사이클이라 새 데이터는 한 달에 한 번 들어옵니다. 매일 호출하는 이유는 **데이터가 공개되는 즉시 페이지에 반영하기 위해서**입니다.

---

## 로컬 테스트

```bash
export DATA_GO_KR_KEY="발급받은_Decoding_키"
node scripts/fetch-data.js     # 일간
node scripts/fetch-monthly.js  # 월간
cat data/daily.json
```

Node.js 20+ 필요. `python3 -m http.server 8080`로 페이지 띄워서 결과 확인.

---

## 수동 임포트 (백업 옵션)

페이지 우상단 `+ 일간 임포트` / `+ 월간 임포트` 버튼으로 JSON 직접 적재 가능. localStorage에 저장.

---

## 데이터 소스

- 환경부 국립환경과학원 수질 DB — [data.go.kr/15081073](https://www.data.go.kr/data/15081073/openapi.do)
- 한국수자원공사 상수도법정수질정보 — [data.go.kr/15099032](https://www.data.go.kr/data/15099032/openapi.do)
- 물환경정보시스템 — [water.nier.go.kr](https://water.nier.go.kr)
- 국가상수도정보시스템 — [waternow.go.kr](https://waternow.go.kr)
