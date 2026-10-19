# 성능 기준본 복원

이 세션의 기준본은 Git 커밋 `ece419a71bb38478c839b3ab871714d72bf424d8`만으로 재구성할 수 없다. 시작 당시 이미 있던 미커밋 개선을 포함해 2026-10-19 00:22:38 KST에 별도 보존한 작업 트리다. 이후 개선 효과는 이 기준본과 비교했다.

[원본 압축본](baseline-source-01.zip)은 [처음 기록한 파일 목록](baseline-files.json)의 165개 파일, 원본 9,778,354바이트를 그대로 담는다. 압축 크기는 1,555,863바이트이며 SHA-256은 `c67b7b8c897193a87f9d784541e05dcc6411f5dae3672312c657251abf0329e3`이다. 원본과 압축 안의 모든 파일은 크기·SHA-256·실제 바이트가 일치했다. [압축 검증 기록](baseline-source-01.zip.json).

공개 스냅샷은 포함되지만 의존성, 생성된 클라이언트 빌드, `.env`, 로컬 DB와 기타 작업 자료는 포함하지 않는다. ZIP의 모든 수정 시각은 재현 가능한 압축을 위해 세션 시작 UTC로 통일했으며 실제 파일 수정 시각을 뜻하지 않는다. 압축 도구는 작업 트리를 순회하지 않고 명시된 파일만 읽고 검증한다.

## 새 폴더에서 복원

저장소 루트에서 Node 24와 Python 3.12로 다음을 실행한다. 기존 폴더나 의존성 junction을 재사용하지 않는다. 아래 설치는 새 복원 폴더에만 수행한다.

```powershell
$restore = Join-Path (Get-Location) 'data/baseline-from-archive'
if (Test-Path -LiteralPath $restore) { throw 'Choose a new empty destination.' }
Expand-Archive -LiteralPath 'docs/verification/performance-20261019/baseline-source-01.zip' -DestinationPath $restore

# 재압축 과정에서 원본 목록의 165개 해시를 다시 검증한다.
python scripts/performance/baseline-archive.py --root $restore --manifest docs/verification/performance-20261019/baseline-files.json --out data/baseline-from-archive-checked.zip
if ($LASTEXITCODE -ne 0) { throw 'Restored source verification failed.' }

Push-Location $restore
try {
  npm ci --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Baseline build failed.' }
} finally { Pop-Location }
```

새 비교는 저장소의 [측정 하네스 설명](../../../scripts/performance/README.md)에 따라 복원 폴더를 `--baseline` 또는 `--root`로 지정한다. 시간대별 호스트 부하가 다르므로 과거 절대 시간을 그대로 재현한다고 보장하지 않는다. 동일 스냅샷, 응답 의미, 소스·빌드 해시, 실행 순서와 측정 구간을 함께 확인한다.

Git 체크아웃은 줄바꿈을 변환할 수 있다. 압축본의 공개 스냅샷은 원래 CRLF 바이트를 보존하므로, LF로 체크아웃한 후보와 JSON 내용이 같아도 원시 SHA-256이 달라질 수 있다. `api-compare.ts`와 `browser.ts`로 비교할 때는 두 버전이 같은 파일을 읽도록 다음 옵션을 함께 지정한다. 원본 압축본이나 기록된 해시를 새 줄바꿈에 맞춰 수정하지 않는다.

```powershell
$snapshot = Join-Path $restore 'server/assets/public-snapshot.json'
# 기존 비교 명령의 나머지 인자와 함께 사용한다.
# --snapshot $snapshot
```

이 옵션은 비교 실행의 입력 파일만 지정한다. 소스·빌드 해시는 각 버전에서 별도로 검증하며, 체크아웃 과정의 줄바꿈 차이까지 포함한 새로운 실행 기록을 남긴다.

## 이번 복원 확인 범위

별도 `data/performance-session-20261019/baseline-restore-01`에 실제로 압축을 풀고 165개 파일의 바이트 일치를 다시 확인했다. Node `v24.14.0`에서 Vite 클라이언트를 다시 빌드한 결과, **349개 생성 파일이 원래 기준본의 빌드와 모두 일치**했다. 빌드 집합 해시는 `3a06b1c190b30844485f4d0556f206b889c4cc46cbe9a438579c624523fc89ff`다. 이 로컬 확인은 이미 설치된 의존성의 junction을 사용하며 새 `npm ci` 실행이나 다른 OS 검증을 뜻하지 않는다. [복원 기록](baseline-restore-01.json).

이 압축본은 초기 기준본만 보존한다. 중간 후보의 버전과 검증 범위는 각 측정 JSON의 pin·소스·빌드 해시를 따른다. 로컬 `data/performance-session-20261019/`에 남긴 여러 후보를 하나의 최종 버전으로 간주하지 않는다.
