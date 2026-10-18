The follow-up candidate is `candidate-wave18-popup-focus`, after the separately validated product17.

- Source: `82f3e500a7df24307da75da9030db2db5bea818be75595d4dd4020bc8c776179`
- Client: `f90479edaf65a0e81c5bb8cd9b1020f4680af6b20b13b21b1e3c21baba62a965`
- Production change: only `web/lib/map-popup.ts`. New pointer/keyboard input cancels an older queued row-focus request. A focusout with an actual related target outside the popup also cancels it; a null related target during Leaflet content detachment does not.

The original defect was reproduced on immutable product17 with the actual210-row popup. Exactly one frame scheduled synchronously by the page-button handler was held. Genuine browser Tab moved focus to the close control, but releasing the older frame moved focus back to performance3584. A separate genuine click on the outer search input was similarly overridden. Evidence is `frontend-popup-focus-race-before-01.json` and `frontend-popup-focus-external-before-01.json`, with their actual screenshots.

The candidate passed three separate actual210-row checks:

| Artifact | Captured / released callbacks | Observed result |
| --- | --- | --- |
| `frontend-popup-focus-tab-after-01.json` | 1 / 0 | Actual Tab focus stays on the popup close control. |
| `frontend-popup-focus-external-after-01.json` | 1 / 0 | Actual external search-input click retains focus. |
| `frontend-popup-focus-layout-after-01.json` | 1 / 1 | The queued automatic row focus remains after viewport resize commands and two animation frames. |

Every check reports unchanged source/client hashes, zero app/cleanup errors, and completed process cleanup. Screenshots were inspected. This is a deterministic ordering diagnostic with local image stubs and an intentionally delayed single frame, not a claim about normal failure frequency or latency. Native RAF resumes before actual user input; the harness respects cancellation of the held ID and restores all temporary hooks in finally. The resize check does not count actual Leaflet content detach/reappend events; browsers can coalesce consecutive resize commands, so it does not independently prove that specific internal path was exercised.

`frontend-popup-focus-build-01.txt` records the passing integrated TypeScript/Vite build. Existing two popup CI cases passed. The new focused CI covers Tab, external search click, layout-only preservation, and ordinary pager automatic focus. The final fixture metadata correction passed TypeScript and the focused CI1/1: `frontend-popup-focus-typecheck-02.txt` and `frontend-popup-focus-ci-04.txt`. Extracted evidence `frontend-popup-focus-ci-04-fixture.json` records kopis40 + culture1 =41, the preserved original36 IDs, cancelled Tab/external callbacks, retained layout callback, and ordinary pager focus success.

An initial new-CI failure is preserved in `frontend-popup-focus-ci-01.txt` and its failure directory:36 rows meant the second page was final, disabling the clicked Next control before Tab and introducing a different native focus transition. The controller-only map response now preserves the original36 IDs/order and appends5 explicitly synthetic rows with distinct IDs, yielding41 rows and3 pages. The unchanged search/global fixture remains36. Assertions verify IDs/order, total/source-count sum41, page count and the active enabled Next control. No product workaround or forced click was used.

The first integrated candidate18 quality attempt stopped at TypeScript before unit/build/browser execution (`quality-wave18-01.txt`): an added fixture count compared the lowercase source enum against uppercase names. The verified source values are `kopis` and `culture`; TEST is a title/sourceId prefix. The fixture now counts the actual source values dynamically and asserts the sum41. The interim passing browser-only result03 predates that metadata correction and is not the final fixture acceptance evidence.

QA subsequently completed the candidate18 integrated run: TypeScript,309 unit tests,production build and16 Chromium scenarios passed with unchanged source/build/validation/workflow hashes. See [the candidate18 QA record](quality-final-wave18-02.md). Product17's earlier309-unit/15-browser result remains separate.
