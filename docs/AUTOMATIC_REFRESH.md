# 전국 자동 갱신

운영 사이트: https://culture-desk.vercel.app · [실행 이력](https://github.com/koul777/culture-desk/actions/workflows/refresh-performances.yml) (비공개 저장소 소유자 로그인)

웹 브라우저와 사용자 PC에 의존하지 않는 GitHub Actions 예약 작업이 KOPIS·문화포털의 전국 230개 지역을 조회한다. 매일 한국 시간 04:17에 시작하며 06:47·12:47·20:47은 미완료 작업을 복구하는 예약이다. 이미 완료한 날짜에는 중복 수집하지 않는다. 예약 시각은 실제 시작 시각과 차이가 날 수 있다.

조회 범위는 한국 날짜 기준 이번 달 1일~오늘로부터 3개월 뒤다. 새 날짜에는 목록과 상세를 다시 조회하여 새 공연과 변경된 정보를 반영한다. 기존 공연 이력·개인 자료는 삭제하지 않고 출처 ID로 병합한다.

## 중단과 복구

- 수집 작업은 날짜별로 분리하고 10분마다(`NATIONAL_CHECKPOINT_MINUTES`, 2~30) 재개용 체크포인트를 Neon에 저장한다. 운영 DB 병합은 실행이 끝날 때 한 번만 하며, 공급처가 바꾼 공연만 기록한다.
- 완료한 지역·출처 범위는 작업·항목 행을 복사하지 않고 집계와 날짜 구간별 페이지 근거만 운영 DB에 남긴다.
- 같은 날짜의 재실행은 완료한 작업을 건너뛰고 남은 작업을 이어간다.
- 120초 실행 잠금과 30초 heartbeat로 중복 수집을 막는다. 살아 있는 잠금은 날짜가 바뀌어도 존중한다.
- 한 실행은 기본 50분 후 안전하게 멈추고 다음 복구 예약으로 이어간다. Actions 자체 제한은 58분이다.
- 과거 날짜의 영구 실패가 오늘 수집을 막지 않도록 날짜가 바뀌면 과거 실패 증거를 남기고 오늘 범위를 새로 조회한다.
- 전국 460개 지역·출처 범위의 날짜 구간, 목록 페이지와 상세 완료, SQLite 무결성을 검사하고 운영 DB 병합까지 성공해야 완료로 기록한다.
- 완료 체크포인트는 해제하고 실패 체크포인트는 7일 뒤 정리한다. 실행 메타데이터와 저장된 공연 자료는 유지한다.
- 7일 지난 정상 완료 수집의 요청·항목 연결은 집계와 날짜 구간별 페이지 근거로 보관한다. 공연·원문·개인 자료와 검색 범위·엑셀 근거는 유지하여 매일 반복되는 작업 기록만으로 저장 공간이 소진되지 않게 한다.

사이트의 **데이터 연결 → 전국 자동 갱신**에서 마지막 성공, 조회 범위, 진행, 재시도 대기와 오류를 확인한다. 마지막 성공이 36시간 이상 지났거나 상태 조회가 실패하면 정상 완료로 표시하지 않는다. 제공기관 장애·인증 만료·호출 한도 또는 실행 서비스 한도까지 성공으로 처리하지 않는다.

## 환경과 확인

비공개 저장소의 Actions Secrets에 `DATABASE_URL`, `KOPIS_API_KEY`, `CULTURE_API_KEY`를 암호화 등록한다. Vercel의 `AUTOMATIC_REFRESH_ENABLED=1`은 자동 갱신 상태 화면을 활성화하고 기존 브라우저 기반 정기 재수집과의 중복을 막는다. API 키는 소스·화면·로그에 넣지 않는다.

```powershell
node --import tsx scripts/run-scheduled-refresh.ts --probe
node --import tsx scripts/run-scheduled-refresh.ts
```

`--probe`는 두 실제 API와 Neon 쓰기·실행 잠금을 확인한 뒤 검증용 DB 변경을 롤백한다. 일반 실행은 오늘의 완료 여부를 확인하고 미완료면 수집한다. 현재 날짜의 완전한 검증 자료가 이미 있는 경우에만 `--seed-checkpoint <file>`로 완료 기준을 등록할 수 있다.

GitHub의 예약 실행은 혼잡 시 지연될 수 있다. 복구 예약과 화면의 지연 감지로 확인하며, 유료 요금제나 추가 사용량 결제는 이 작업에서 설정하지 않는다. 무료 실행 시간은 계정 전체의 다른 비공개 저장소 작업과 공유한다. [공식 예약 실행 설명](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) · [GitHub Actions 사용량](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
