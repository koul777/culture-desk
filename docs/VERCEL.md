# Vercel 운영

운영 주소: https://culture-desk.vercel.app · 로그인이나 접속 암호 없이 바로 전국 공연을 검색합니다. 지역 미선택·전체 체크는 전국, 일부 체크는 해당 지역만 조회합니다. 기본 보기는 공연 카드이며 상단·메뉴·보기 전환 버튼에서 지도를 열 수 있습니다. 지도 바로가기: https://culture-desk.vercel.app/#map

로컬 실행은 기존 SQLite와 상시 수집기를 사용합니다. Vercel에서는 프런트엔드를 정적 배포하고, 하나의 Node.js 24 API 함수가 배포에 포함된 공개 스냅샷(`server/assets/public-snapshot.json`)을 읽습니다. 스냅샷은 매일 GitHub Actions가 수집해 만들고 Vercel CLI로 배포합니다. 웹 서비스는 DB 서비스에 접속하지 않습니다. [전국 자동 갱신](AUTOMATIC_REFRESH.md)

## 환경 변수

- `VWORLD_API_KEY`: 선택 항목. 브이월드 WebGL 3D API 3.0용 브라우저 지도 키이며, Production에 등록한 뒤 재배포합니다. 브이월드에 `https://culture-desk.vercel.app` 서비스 도메인을 등록합니다. 미설정이면 기존 Cesium 외곽 모형을 사용합니다.
- `CULTURE_DATA_SOURCE=database`: 이전 Neon 구조로 되돌릴 때만 씁니다. 평소에는 설정하지 않습니다.

공연 API 키(`KOPIS_API_KEY`, `CULTURE_API_KEY`)는 GitHub Actions Secrets에만 있으면 됩니다. `.env`, `.env.vercel`은 커밋하거나 배포 파일에 포함하지 않습니다. 브이월드 키만 지도 SDK 사용을 위해 3D 프레임의 SDK 요청에 전달되므로 제공기관의 도메인 제한이 필요합니다. 설정 API는 키 값 없이 사용 가능 여부만 반환합니다.

`/api/maps/vworld/config`와 `/api/maps/vworld/frame`은 공연 자료에 접근하지 않습니다. 지도 프레임 경로만 `X-Frame-Options: SAMEORIGIN`과 `frame-ancestors 'self'`로 같은 사이트의 3D 창에 포함할 수 있게 하며, 나머지 화면의 외부 프레임 삽입 차단은 유지합니다. 상세 신청 절차는 [API 신청 안내](API_APPLICATIONS.md)를 참고하세요.

## 공개 스냅샷

공개 스냅샷에는 검색 대상 공연의 공개 필드, 공연장 정보(관별 객석 수·편의시설·예매처·홈페이지), 자동 갱신 상태와 완료가 확인된 지역·출처 범위만 넣습니다. 원본 API 응답·개인 메모·관심 표시·수집 큐·인증정보는 넣지 않습니다. 공연 한 건을 한 줄로 저장하여 매일 바뀌는 부분만 작게 비교됩니다.

API 함수는 스냅샷을 인스턴스마다 한 번 메모리 SQLite로 복원하고 `query_only`로 잠급니다. 검색·지도·상세·공연장 외곽·엑셀 조회를 제공하며, 수집·상세 보충·Cron 요청은 HTTP 404로 거절합니다. 화면은 자료 기준 시각과 자동 갱신 상태를 표시하고 수동 수집 화면을 숨깁니다. 스냅샷을 읽지 못하면 빈 결과 대신 HTTP 503과 `SNAPSHOT_UNAVAILABLE` 코드를 반환합니다.

저장소의 스냅샷은 상태 아티팩트가 없을 때의 시작점입니다. 운영 자료는 매일 배포 때 새 스냅샷으로 바뀝니다. 검증한 백업에서 새로 만들 때는 아래 명령을 사용합니다.

```powershell
node --import tsx scripts/build-public-fallback.ts data/backups/검증한백업.db
```

## 응답 한도

JSON 조회와 Excel 다운로드는 응답 본문을 4 MiB까지만 전송합니다. 초과 시 HTTP 413과 `RESPONSE_CAPACITY` 코드로 지역·기간 등 조회 조건을 좁히도록 안내합니다. 지도는 별도로 항목 수와 응답 크기를 제한하고 잘림 여부를 표시합니다.

## 공연장 3D

Cesium 코드와 Workers·Assets는 정적 배포에 포함됩니다. 공연장 3D는 추가 ion 키 없이 OSM 배경과 타원체 지면으로 표시합니다. `/api/venues/building?performanceId=...`는 저장된 공연장의 좌표로 실제 건물 도형을 찾으며, 3개 확인된 공연장의 원자료 캐시와 허용된 Overpass 제공처를 사용합니다. 높이 기록이 있으면 해당 값이나 층수 기반 추정값을 구분해 표시합니다. 실제 외곽은 있으나 높이가 미확인이면 프런트엔드에서 초기 12m의 **높이 가정 모형·실측 아님**으로 표시하며, 슬라이더로 가정 높이를 바꾸거나 위에서 외곽을 볼 수 있습니다. 원본 API의 높이 `null`은 변경하지 않으며 실제 3D 원본을 추가 확보한 것은 아닙니다. 도형이 없으면 공연장 위치만 표시합니다.

## 이전 구조(Neon)

2026-10-17까지는 SQLite 전체를 gzip 한 덩어리로 Neon Postgres의 한 행에 저장하고, 쓰기마다 전체를 읽고 다시 썼습니다. 수집 배치마다 두 번, Actions 실행 중 2분마다 전체(약 2.9 MB)를 주고받는 구조였고, 2026-10-16 Neon 무료 사용량 한도(`53000`)에 걸려 연결이 거부되었습니다. 어느 한도인지는 확인하지 못했습니다. 관련 코드(`server/cloud/snapshot.ts`, `collection.ts`, `refresh-jobs.ts`, `scripts/run-scheduled-refresh.ts`)는 정리 전까지 남아 있으며 `CULTURE_DATA_SOURCE=database`일 때만 사용합니다.

참고: [Vercel Node.js 함수](https://vercel.com/docs/functions/runtimes/node-js), [Vercel CLI 배포](https://vercel.com/docs/cli/deploy).
