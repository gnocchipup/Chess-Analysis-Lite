# Chess-Analysis-Lite

Frontend-only PGN viewer + material-engine annotator. No build, no backend — just open `index.html` (or serve the folder statically).

## Features
- Interactive board (fixed square sizing: `grid-template-rows: repeat(8,1fr)` + `aspect-ratio: 1/1`, so empty rows never collapse) with flip, eval bar, Multi-PV lines, PGN movelist.
- **Lichess import with `evals=true`**: paste a game URL like `https://lichess.org/xxxxxxxx` (or bare 8-char ID) → Fetch calls:
  `GET https://lichess.org/game/export/{id}?moves=1&tags=1&clocks=1&evals=1&opening=1&literate=1`
  and loads PGN headers (players, ratings, Event/Site/Date, ECO/Opening, Result) plus per-move `[%eval x]` / mate markers, `??`/inaccuracy/mistake/blunder glyphs (`!?`, `$1..$4`), and comments.
- **Blunder detection**: for Lichess imports (server evals present) trusts Lichess server markers (`??`, `$4`) only — no extra eval-drop rule, so `?` moves like 47...e3 (`?`, not `??`) stay untagged. Mate scores (`[%eval #N]`) parse to ±99900. For pasted PGNs without server evals, a quick local scan (~400ms/pos) fills evals first and a flat mover-POV drop `>= 100cp` applies.
- **Material litigator (5s each)**: for every Lichess blunder, the bundled material-only engine (`engine.js`, Web Worker) runs 5s on the pre- and post-blunder positions. If mover-POV swing `S0 - S1 >= 100cp` → material, else `positional`. Material splits into:
  - `simple material miss` — had a winning line (`S0 >= 150`) and threw it (`S1 <= 50`), i.e. missed a material win;
  - `simple material loss` — allowed the opponent a material win.
  Verdict is shown inline in the movelist, in the Blunders panel, and appended as a PGN comment `{ blunder — <verdict> }`.
- **Export annotated PGN**: Update preview → Copy / Download `annotated.pgn`. Headers (players/ratings/etc.) preserved, evals re-emitted as `[%eval]`, verdicts as comments.

## Run
Just double-click `index.html`, or: `npx serve .` then open the URL. Everything runs in-browser; Lichess fetch uses CORS-enabled `lichess.org/game/export`.

## Files
- `index.html` — UI + PGN parser, Lichess fetch, blunder detect/classify, PGN builder.
- `engine.js` — material-only 0x88 engine (alpha-beta + quiescence, also usable as Web Worker / Node CLI: `node engine.js "<fen>" [seconds]`).
- `pieces/*.svg` — (unused by current unicode-glyph board; kept for future SVG board).
- `.gitignore` — frontend-only ignores.

## Thanks
- [Lichess](https://lichess.org) for free games, open API, and server-side evals/markers.
- Claude Sonnet 5.5, Muse Spark 1.3, and Cline Desktop for assistance building this update.
