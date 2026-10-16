# Culture Desk promotional motion graphic

21 seconds · 1920×1080 · 30 fps · silent. Intended for the GitHub README and the linked product video page.

```powershell
node scripts/promo/render.mjs --frames-only
node scripts/promo/render.mjs
```

Requires the project Playwright dependency, Chromium, FFmpeg on PATH and Noto Sans KR (falls back to Malgun Gothic). All graphic animation is deterministic and can be inspected with `window.renderFrame(seconds)` in `promo.html`. No live APIs, credentials or remote assets are used during rendering.

Outputs:

- `web/public/promo/culture-desk-promo.mp4`
- `web/public/promo/culture-desk-promo-poster.png`
- `docs/media/culture-desk-promo.gif`
- Inspection frames and render metadata: `docs/verification/promo/`

| Time | Message | Motion and reading hold |
| --- | --- | --- |
| 0–4 s | Culture Desk, nationwide performance search in 230 regions | The first title line and 230-region graphic are visible immediately. The second line uses mask reveal: 110% to 0, 1.05 s, 0.35 s line offset; title holds after 1.6 s. City labels stagger in 0.06 s intervals. |
| 4–8.5 s | No regions/all regions means nationwide; selected regions restrict the search | Six illustrative region chips stagger in 0.55 s each; Gangneung and Yeosu become checked. Explicit selection rules remain readable. |
| 8.5–13 s | Explore the map beside the performance list | Actual production screenshot, dated 2026-10-16. A single cluster is emphasized with a maximum 1.05× finite pulse. |
| 13–17 s | Daily nationwide refresh continues while the website is closed | Source cards and a refresh icon, followed by a readable hold; source API availability qualification remains visible. |
| 17–21 s | Visit culture-desk.vercel.app | CTA enters in 0.35 s and holds for over 2.5 s. |

Motion selection follows `awesome-ai-motion`'s decision table and the `mask-reveal`, `stagger`, and `pulse` cards. These are independently implemented, seekable adaptations of the documented timing values; no third-party runtime is bundled. Scene transitions are clean cuts to avoid overlapping Korean text. Static poster and the MP4 player provide alternatives to the README's automatic GIF preview.

Production evidence is `docs/verification/final-production-map-desktop.png`. The region card is labelled as an illustration of selection behavior. The video claims nationwide search, map exploration and scheduled collection, without claiming real-time updates, exhaustive original-source coverage, unique-event counts, or nationwide photorealistic 3D.
