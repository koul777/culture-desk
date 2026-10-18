# 팀 구현 계약

모든 소스는 C:/workspace/cultureapi 공유 폴더. 팀장 Codex는 shared/types.ts, 서버 저장소/작업 큐/HTTP/엑셀/실행기를 담당. Claude는 web/만, Cursor는 server/providers/ 및 tests/providers.test.ts만 수정. 패키지 설치·전체 빌드·통합은 팀장 담당. 다른 담당 파일 수정이 필요하면 메시지.

스택: Node 24.14+, React/Vite/TypeScript, Fastify, 내장 node:sqlite DatabaseSync, fast-xml-parser, exceljs, lucide-react. 키는 루트 .env에만 있고 클라이언트에 노출 금지. 실 데이터 없는 상태를 기본값으로 표시. 샘플 데이터를 실제 자료처럼 제공 금지.

## HTTP 계약

- GET /api/bootstrap → Bootstrap (shared/types.ts)
- GET /api/performances?cities=andong,yeosu&from=YYYY-MM-DD&to=YYYY-MM-DD&genre=...&q=...&status=upcoming|ongoing|ended&price=free|paid|unknown&age=...&source=kopis|culture&bookmarked=true&page=1&limit=30 → SearchResult
- GET /api/performances/:id → Performance. 상세 pending이면 아래 요청으로 보충.
- POST /api/performances/:id/detail → {queued:true}. UI는 폴링 후 다시 읽기.
- PUT /api/performances/:id/bookmark {bookmarked:boolean,note?:string} → Performance
- POST /api/details {filters:SearchFilters} → {queued:number} 선택 필터의 상세 미수집 보충
- POST /api/sync {cities:string[],sources:Source[],from:string,to:string} → {runs:SyncRun[],skipped:Source[]}
- POST /api/sync/:id/pause → {ok:true}; POST /api/sync/:id/resume → {ok:true}
- GET /api/export.xlsx (공연 검색과 동일 쿼리) → Excel 다운로드. 선택 항목은 ids=1,2 쿼리 추가 가능.
- POST /api/cities {name,sido,sigungu,kopisSido,kopisSigungu} → City. 기본 7개 외 도시 추가.
- POST /api/backup → {filename:string} 로컬 백업 생성
- POST /api/config/reload → {ok:true} .env를 수정한 후 서버 설정 다시 읽기
- POST /api/shutdown → {ok:true} 정상 종료
- 에러 응답 {error:string}; 모든 변경 요청은 Content-Type:application/json 및 X-Culture-Request:1 헤더. fetch 상대 경로 사용. UI는 source별 건수 표시하고 합계를 고유 공연 수로 부르지 않음.

## Provider 계약

server/providers/index.ts에서 createProviders(keys:{kopis:string,culture:string}):Partial<Record<Source,Provider>> export. 키 없는 provider는 제외. server/providers/cities.ts에서 DEFAULT_CITIES:City[] export. 도시 코드 공식 근거 docs/research 추가 가능. 타입은 shared/types.ts import. list/detail XML 정규화, 전시/검토 분류, 오류/응답/개행/HTML 안전 문자열, 날짜 ISO. API 오류는 Error에 kind 속성 ('auth'|'quota'|'network'|'schema') 부여. raw에는 키/요청 URL 절대 금지. fetch timeout, HTTPS, 안전 링크(http/https)만.

Culture 최신 명세 docs/research/culture-api-contract.json 확인. KOPIS 공식 명세·도시 코드 확인 필수, 미확인 사실은 명시. 공연 분류는 허용목록, 전시/교육 제외, 불명확 review. 제목의 도시명만으로 지역 판정 금지. 상세 없는 목록은 priceType unknown/detailState pending.

## 화면 방향

Culture Desk / 소도시 공연 리서치. 좌측 간결 네비게이션(공연 찾기, 관심 공연, 데이터 연결), 넓은 표 중심 본문. 밝은 종이색+짙은 잉크+청록 포인트, 한글은 시스템 맑은 고딕/Segoe UI. 과장된 통계 카드 금지. 도시 칩·기간 프리셋·필터·상세 패널·메모·연결 안내·수집 상태를 읽기 쉽게. 빈 상태가 정상 첫 화면. 원문/키 신청 링크, 로딩/오류/키보드/모바일 검증. 임의 인기순/가짜 공연 없음.

UI/UX 스킬 검색: Data-Dense Dashboard 스타일은 적합. Enterprise Gateway 랜딩 패턴·판매 CTA·Fira 영문 폰트 추천은 본 작업에 맞지 않아 적용하지 않음. 일반 접근성 기본(대비, 명시적 라벨, 포커스, reduced motion)을 적용.
