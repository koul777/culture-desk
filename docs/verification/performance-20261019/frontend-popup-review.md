The reviewed frontend candidate is `data/performance-session-20261019/candidate-wave17-popup-retention`.

- Source SHA: `bfea341b03a13ae23be975a25a74fc9524ce85a709b43aa7c7ec4a8f7ed93137`
- Client SHA: `bc1dce58f4ff69ea17e92d57947c8b8cce45d4f16af5ae1257f8562953e36a0f`
- Public snapshot: 5,649 rows, SHA `09577634afcd8ebdd244053a92d68e1ff944abe9bcebe8cf5ab364e68d86e473`

The popup preserves exact raw venue strings and original performance IDs/order. Mixed or missing venue groups use a neutral heading, show the venue on every row, and use performance detail for venue-specific actions. A single known venue retains its existing common 3D/directions actions. Local title/venue search and 20-row pages keep their controls stable; IME composition does not filter mid-composition. Explicit list locate restores the selected ID's page and clears only a query that hides it. Ordinary pointer/keyboard reopening preserves local state, including returning after another marker.

Missing, null, whitespace-only or non-string venue values are counted as missing information and searched safely without rewriting source objects. Valid original strings remain untrimmed in display. External list locate now makes its selected row visible below the actual overlapping sticky header. This bounded immediate correction is cancelled by new user wheel/touch/pointer/scroll-key input, focus loss, target removal, closing, replacement or unmount; listeners are removed on completion/cancellation. Internal popup interactions preserve document scroll. Above zoom14 the existing venue layers move with Leaflet instead of recreating markers and losing popup state.

| Evidence | Result |
| --- | --- |
| `frontend-popup-controls-03.json`, `frontend-popup-controls-mobile-01.json`, `frontend-popup-controls-groups-01.json`, `frontend-popup-controls-small-mixed-02.json` | 12 successful original-group cases across 1440/375/320: actual210/112 and small single/mixed groups. The initial small-mixed harness failed by requesting a hidden pager through a visibility-filtered selector; corrected selector and all3 reruns passed. |
| `frontend-popup-scroll-before-01.json` | Wave14 actual210: first/last/repeated same-ID external locate had 0% row visibility in the 375/320 viewport; focused rows were above the screen. |
| `frontend-popup-scroll-gesture-before-01.json` | Wave15: a genuine wheel input was followed ~415ms later by the pending correction. A synthetic moving-row CSS condition keeps the race observable; this is not normal-layout timing evidence. |
| `frontend-popup-scroll-after-01.json` | Wave16: 375/320 first/last/same-ID visibility100%/99.89%; row begins around115px below103px sticky header. No correction after actual wheel input. Local page/search/reopen document scroll changes0. |
| `frontend-popup-retention-before-01.json` | Wave16: zoom15→16 closed the popup and replaced input/marker DOM; layer measures3→4. Visiting a second marker cleared the first marker's query or page in all4 pointer/keyboard cases. |
| `frontend-popup-retention-after-01.json` | Wave17: both cases pass. Input and marker DOM are retained; layer measures stay3→3. All4 two-marker query/page cases preserve state. |
| `frontend-popup-scroll-final-01.json` | Wave17 final375/320 actual210 cases pass; first/last/same-ID visible, local navigation retained, app/external errors0. |

Focused model/scroll tests passed9/9, including nullable venue input, exact ID ordering, external reveal, geometry boundaries, visualViewport offset, desktop sidebar non-overlap, bounded scheduling and listener cancellation/cleanup. The final integrated TypeScript/Vite build passed (`frontend-popup-retention-build-01.txt`). Initial JS remains103.38KB gzip; lazy map JS is51.00KB gzip. The existing large lazy Cesium chunk warning remains. One earlier build stopped at unrelated new lifecycle harness type inference errors, fixed by its owner; the failure log remains `frontend-popup-scroll-build-01.txt`.

The two new tests in `tests/e2e/popup.spec.ts` use the existing36 TEST IDs. The first uses a375×812 Chromium viewport and groups36 coordinates locally for paging/search/repeated locate. The second explicitly uses1440×1000 and35+1 nearby groups for cached reopening and high-zoom DOM retention. Its initial failure was a test viewport setup error: the narrow default also reached the desktop zoom-control flow. Only that test's viewport was corrected; product17 stayed frozen. QA subsequently completed the integrated quality run with309 unit tests and15 browser tests passing; see [final QA record](quality-final-wave17-01.md).

This report covers the reviewed product17 candidate and its completed validation. The later queued-focus-frame investigation is recorded in separate `frontend-popup-focus-race` artifacts; it has not changed product17 and is not included as a resolved issue here.

The subsequent fix and its separate candidate18 evidence are documented in [the focus-order follow-up](frontend-popup-focus-review.md).

Actual375/320 before/after viewport PNGs were inspected. These are functional diagnostics with local image stubs, plus a VWorld message-protocol-only frame for detail return tests. There is no real-device GPU, live provider, OS IME certification, or latency acceptance claim. The two-marker diagnostic moves only its sibling fixture coordinate nearby and does not infer a real facility relationship. All owned browser/fixture processes were verified exited before returning the execution window.
