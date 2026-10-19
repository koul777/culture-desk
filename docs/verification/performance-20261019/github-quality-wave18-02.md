# Linux 통합 품질 검사

커밋 `1dfbff6685223df5db32085cd0476ad05709e1df`가 GitHub의 Ubuntu·Node 24 환경에서 **타입 검사, 단위 검사 309개, 클라이언트 빌드, Chromium 검사 16개를 모두 통과**했다. [실행 결과](https://github.com/koul777/culture-desk/actions/runs/39159195100).

작업 실행은 2026-10-18 19:32:03–19:33:52 UTC이며, `npm ci --ignore-scripts`와 Playwright Chromium 설치 후 `npm run quality`를 실행했다. 단위 검사 실패·건너뛰기는 0개였고 브라우저 검사는 16개 모두 통과했다. GitHub 검증 자료 업로드도 성공했다. [원시 로그](github-quality-wave18-02.txt)와 [실행 메타데이터](github-quality-wave18-02.json)를 보존했다.

앞선 [실패 진단](github-quality-wave18-01.md)에 따라 두 수집 시간 초과 검사의 전체 처리 예산을 800ms에서 5,000ms로 늘렸다. 요청 자체의 30ms 제한과 기존 재시도·대기열 검증은 유지하고, 실제 요청 시작·중단 횟수 및 처리 단계 수를 추가로 확인한다. 제품 소스와 빌드는 로컬의 후보18 검사 당시와 동일하다.

이 결과는 해당 커밋의 자동 검사를 통과했다는 뜻이다. 브라우저 장기 사용 관측과 최종 성능 비교는 별도 실행 기록을 따른다. 이 작업에서 운영 배포 명령은 실행하지 않았다.
