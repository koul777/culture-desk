# 전국 자동 갱신

운영 사이트: https://culture-desk.vercel.app · [실행 이력](https://github.com/koul777/culture-desk/actions/workflows/refresh-performances.yml) (비공개 저장소 소유자 로그인)

웹 브라우저, 사용자 PC, 별도 DB 서비스에 의존하지 않는 GitHub Actions 예약 작업이 KOPIS·문화포털의 전국 230개 지역을 조회하고, 결과를 공개 스냅샷 파일로 만들어 Vercel에 배포한다. 사이트는 배포에 포함된 이 파일만 읽는다. 매일 한국 시간 04:17에 시작하며 06:47·12:47·20:47은 미완료 작업을 이어서 처리하는 예약이다. 그날 수집을 완료했으면 복구 예약은 1분 안에 끝난다. 예약 시각은 실제 시작 시각과 차이가 날 수 있다.

조회 범위는 한국 날짜 기준 이번 달 1일~오늘로부터 3개월 뒤다. 새 날짜에는 목록과 상세를 다시 조회하여 새 공연과 변경된 정보를 반영한다. 기존 공연 이력은 삭제하지 않고 출처 ID로 병합한다.

## 흐름

1. 이전 실행이 남긴 수집 상태 아티팩트(`culture-desk-state`)를 내려받는다. 운영 SQLite(`production.db`), 오늘의 진행 중 수집, 마지막 공개 스냅샷, 상태 기록(`job.json`)이 들어 있다.
2. 러너의 SQLite에 수집하고(`scripts/collect-national.ts`) 운영 SQLite에 병합한다(`scripts/run-daily-publish.ts`).
3. 공개 스냅샷 `server/assets/public-snapshot.json`을 만들어 Vercel CLI로 배포한다.
4. 수집 상태를 다시 아티팩트로 저장한다. 보존 기간은 7일이다.

상태 아티팩트가 없거나 만료되면 저장소에 커밋된 스냅샷에서 시작한다. 이 경우 공연 자료는 유지되고 원본 응답과 수집 이력은 새 수집부터 다시 쌓인다.

## 중단과 복구

- 한 실행은 기본 50분 후 진행분을 저장하고 멈춘다. 다음 예약이 같은 날짜의 남은 작업을 이어간다. Actions 자체 제한은 58분이다.
- 완료하지 못한 실행도 그때까지 받은 자료를 병합해 배포하고, 화면에 **재시도 대기**로 표시한다. 공연 수가 줄어드는 배포는 만들지 않는다.
- 날짜가 바뀌면 전날의 미완료 수집은 버리고 오늘 범위를 새로 조회한다. 이미 병합한 공연은 유지한다.
- 전국 460개 지역·출처 범위의 날짜 구간, 목록 페이지와 상세 완료, SQLite 무결성을 검사해야 완료로 기록한다.
- 공개 스냅샷에는 완료가 확인된 지역·출처 범위만 기록한다. 검색 화면은 이 범위 밖의 조회에 "아직 수집하지 않은 범위" 안내를 유지한다.
- 7일 지난 정상 완료 수집의 요청·항목 연결은 집계와 날짜 구간별 페이지 근거로 보관하여, 매일 반복되는 작업 기록만으로 저장 공간이 늘지 않게 한다.

사이트의 **데이터 연결 → 전국 자동갱신**에서 마지막 성공, 조회 범위, 진행, 재시도 대기와 오류를 확인한다. 마지막 성공이 36시간 이상 지나면 정상 완료로 표시하지 않는다. 제공기관 장애·인증 만료·호출 한도 또는 실행 서비스 한도를 성공으로 처리하지 않는다.

## 배포

`main`에 코드를 push해도 같은 작업이 실행되어, 수집 없이 최신 공개 스냅샷과 함께 배포한다. PC에서 `vercel deploy`로 직접 배포하면 저장소의 기준 스냅샷이 올라가므로, 직접 배포한 뒤에는 Actions에서 **Run workflow**로 다시 배포한다. `main`이 아닌 브랜치에서 수동 실행하면 미리보기 배포만 만든다.

## 환경과 확인

비공개 저장소의 Actions Secrets에 다음 값을 등록한다. 웹 배포에는 공연 API 키와 DB 연결 정보가 필요하지 않다. 키·토큰은 소스·화면·로그·명령 인자에 넣지 않는다.

| Secret | 내용 |
| --- | --- |
| `KOPIS_API_KEY`, `CULTURE_API_KEY` | 공연 API 인증키 |
| `VERCEL_TOKEN` | Vercel 계정 설정 → Tokens에서 만든 배포용 토큰 |
| `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | `vercel link`가 만든 `.vercel/project.json`의 `orgId`, `projectId` |

수동 실행은 Actions → **Refresh nationwide performances** → **Run workflow**에서 수집 예산(분)을 지정한다.

GitHub의 예약 실행은 혼잡 시 지연될 수 있다. 비공개 저장소의 무료 실행 시간은 계정 전체 월 2,000분이며 다른 비공개 저장소 작업과 공유한다. 유료 요금제나 추가 사용량 결제는 설정하지 않는다. [공식 예약 실행 설명](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) · [GitHub Actions 사용량](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

이전의 Neon 기반 구조(`scripts/run-scheduled-refresh.ts`, `CULTURE_DATA_SOURCE=database`)는 정리 전까지 코드에 남아 있지만 운영에서 사용하지 않는다.
