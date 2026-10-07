// analyze.js — DOM-free batch pipeline shared by batch.html (and usable from Node).
// Pure functions: no window/document access. The chess Engine is injected by the caller
// (global `Engine` from engine.js in the browser, or require('./engine.js').Engine in Node),
// so this file has zero load-time side effects and can be unit-tested headlessly.
//
// Pipeline:  splitGames() -> parseGame() -> [engine 5s on pre/post per blunder] -> verdictFor()
//            -> buildGamePgn() (annotated) + buildRow()/toCsv() (report)
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;           // Node
  else if (root) root.Analyze = api;                                                    // browser (window.Analyze)
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {

  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // Report columns (order fixed — matches the agreed CSV spec).
  const HEADER = [
    'GameLink', 'White', 'WhiteElo', 'Black', 'BlackElo', 'Result', 'Date', 'Moves',
    'WhiteBlunders', 'WhitePositional', 'WhiteSimpleMiss', 'WhiteSimpleLoss', 'WhiteMistakes', 'WhiteInaccuracies',
    'BlackBlunders', 'BlackPositional', 'BlackSimpleMiss', 'BlackSimpleLoss', 'BlackMistakes', 'BlackInaccuracies',
  ];

  // Split a multi-game PGN into individual game texts.
  // Primary rule: a game boundary is a blank line whose next line starts a tag ('[').
  // This is the canonical PGN separator and never splits a game at its header/movetext
  // blank line (movetext does not start with '[').
  function splitGames(text) {
    const t = (text || '').replace(/\r\n?/g, '\n').trim();
    if (!t) return [];
    const parts = t.split(/\n[ \t]*\n(?=[ \t]*\[)/).map(s => s.trim()).filter(Boolean);
    return parts.length ? parts : [t];
  }

  // Mate scores ([%eval #N]) map to +/-99900 (display/sort only), same as index.html.
  function mateScore(n) { return n > 0 ? 99900 : n < 0 ? -99900 : 0; }

  // Parse ONE game into a plain data object. Mirrors index.html loadPgn(), minus all DOM.
  function parseGame(pgn, EngineCls) {
    let t = (pgn || '').replace(/\r\n?/g, '\n');
    const tags = {};
    let fen = START;
    for (const m of t.matchAll(/\[([A-Za-z0-9_]+)\s+"([^"]*)"\]/g)) tags[m[1]] = m[2];
    const fm = t.match(/\[FEN\s+"([^"]+)"\]/);
    if (fm) fen = fm[1];

    // Strip header tag lines only (inline [%eval ...] inside comments must survive).
    t = t.replace(/^[ \t]*\[[A-Za-z0-9_]+\s+"[^"]*"\][ \t]*\r?$/gm, ' ');

    // Tokenize: keep comments, NAGs, moves, results; drop variations and move numbers later.
    const toks = [];
    let i = 0;
    while (i < t.length) {
      const c = t[i];
      if (c === '{') { const j = t.indexOf('}', i); toks.push(t.slice(i, j < 0 ? t.length : j + 1)); i = j < 0 ? t.length : j + 1; }
      else if (c === ';') { let j = t.indexOf('\n', i); if (j < 0) j = t.length; toks.push('{' + t.slice(i + 1, j) + '}'); i = j; }
      else if (c === '(') { let d = 1, j = i + 1; while (j < t.length && d) { if (t[j] === '(') d++; else if (t[j] === ')') d--; j++; } i = j; }
      else if (/\s/.test(c)) i++;
      else if (c === '$') { const m = t.slice(i).match(/^\$\d+/); toks.push(m[0]); i += m[0].length; }
      else { const m = t.slice(i).match(/^[^\s{}();$]+/); toks.push(m[0]); i += m[0].length; }
    }

    const e = new EngineCls(fen);
    const fens = [fen], sans = [], ucis = [], evals = [null], nags = [''], cmts = [''], verdicts = [''], lichEvals = [null];
    let err = '', pendEval = null, pendCmt = [], pendNag = '';

    const pushMove = s => {
      const san = s.replace(/[!?]+$/, '');
      const m = e.moveFromSan(san);
      if (!m) { err = 'Stopped at unreadable move: ' + s; return false; }
      let full = e.san(m);
      const suf = (s.match(/[!?]+$/) || [''])[0];
      if (suf && !full.endsWith(suf)) full += suf;
      sans.push(full); ucis.push(EngineCls.str(m));
      let ev = pendEval;
      for (const c of pendCmt) {
        const em = c.match(/\[%eval\s+(?:#(-?\d+)|([+-]?\d+(?:\.\d+)?))(?:,(\d+))?\]/);
        if (em) {
          ev = em[1] !== undefined ? mateScore(+em[1]) : Math.round(+em[2] * 100);
          if (em[3] !== undefined && em[1] === undefined) ev = ev >= 0 ? 100000 - (+em[3]) * 2 : -100000 - (+em[3]) * 2;
        }
      }
      e.make(m); fens.push(e.fen());
      evals.push(ev); lichEvals.push(ev); nags.push(pendNag);
      cmts.push(pendCmt.filter(c => !/\[%(eval|clk)[^\]]*\]/.test(c)).join(' ').trim());
      verdicts.push('');
      pendEval = null; pendCmt = []; pendNag = '';
      return true;
    };

    for (const tok of toks) {
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) { tags.Result = tags.Result || tok; break; }
      else if (/^\d+\.(\.\.)?$/.test(tok)) continue;
      else if (/^\{.*\}$/s.test(tok)) {
        const inner = tok.slice(1, -1);
        const em = inner.match(/\[%eval\s+(?:#(-?\d+)|([+-]?\d+(?:\.\d+)?))(?:,(\d+))?\]/);
        let ev = null;
        if (em) {
          ev = em[1] !== undefined ? mateScore(+em[1]) : Math.round(+em[2] * 100);
          if (em[3] !== undefined && em[1] === undefined) ev = ev >= 0 ? 100000 - (+em[3]) * 2 : -100000 - (+em[3]) * 2;
        }
        if (ev !== null && sans.length && (evals[sans.length] === null || evals[sans.length] === undefined) && pendEval === null) {
          // Comment FOLLOWS the move it annotates (Lichess style: "e4 { [%eval 0.17] }").
          evals[sans.length] = ev; lichEvals[sans.length] = ev;
          const flush = pendCmt.filter(c => !/\[%(eval|clk)[^\]]*\]/.test(c)).join(' ').trim();
          if (flush) cmts[sans.length] = (cmts[sans.length] ? cmts[sans.length] + ' ' : '') + flush;
          pendCmt = [];
          const clean = inner.replace(/\[%(eval|clk)[^\]]*\]/g, '').trim();
          if (clean) cmts[sans.length] = (cmts[sans.length] ? cmts[sans.length] + ' ' : '') + clean;
        } else {
          pendCmt.push(inner);
          if (ev !== null) pendEval = ev;
        }
      }
      else if (/^\$\d+$/.test(tok)) pendNag = tok;
      else if (/^[!?]+$/.test(tok)) {
        if (sans.length || nags.length > 1) { const k = sans.length; nags[k] = (nags[k] || '') + tok; sans[k - 1] = (sans[k - 1] || '') + tok; }
      }
      else { if (!pushMove(tok)) break; }
    }

    const blunders = detectBlunders(sans, nags);
    return { tags, fens, sans, ucis, evals, lichEvals, nags, cmts, verdicts, blunders, err };
  }

  // Blunders = ONLY what Lichess already tagged: a "??" glyph on the move or a $4 NAG.
  function detectBlunders(sans, nags) {
    const out = [];
    for (let k = 1; k <= sans.length; k++)
      if ((nags[k] || '').includes('$4') || /⁇|\?\?/.test(sans[k - 1] || '')) out.push(k);
    return out;
  }

  // Static material parity (piece values only, NO search), mover(side-to-move)-POV.
  // Caveat: raw count — in a mid-trade position it does not settle the pending recapture,
  // so it can be off by ~a piece for that one ply.
  function materialParity(fen, EngineCls) {
    const stm = fen.split(' ')[1] === 'w' ? 1 : -1;
    return new EngineCls(fen).mat * stm;   // engine .mat is White-POV; flip to side-to-move POV
  }

  // Material verdict (all centipawns, mover-POV), identical rule to index.html:
  //   mp0       = static material parity before the move
  //   s1best    = best-play eval from the pre-move position (== the pos0 search root score)
  //   s1blunder = eval after the played move (opponent's best reply is baked into the search)
  //   cpMiss = s1best - mp0      (material the best move could have gained over parity)
  //   cpLoss = mp0    - s1blunder (material the played move gave up below parity)
  // If max(cpMiss,cpLoss) < 100cp => positional; else the larger decides (tie => loss).
  // Because s1best is searched, a forced loss (piece already hanging) makes cpMiss <= 0,
  // so it is never mislabeled a "miss".
  function verdictFor(mp0, s1best, s1blunder) {
    if (mp0 === null || s1best === null || s1blunder === null) return 'positional';
    const cpMiss = s1best - mp0, cpLoss = mp0 - s1blunder;
    if (Math.max(cpMiss, cpLoss) >= 100) return cpMiss > cpLoss ? 'simple material miss' : 'simple material loss';
    return 'positional';
  }

  // Count blunders/mistakes/inaccuracies for one color ('w'|'b'), plus the blunder verdict split.
  function colorTally(g, color) {
    const r = { blunders: 0, positional: 0, simpleMiss: 0, simpleLoss: 0, mistakes: 0, inaccuracies: 0 };
    for (let k = 1; k <= g.sans.length; k++) {
      if ((g.fens[k - 1].split(' ')[1] || 'w') !== color) continue;
      const s = g.sans[k - 1] || '', nag = g.nags[k] || '';
      const gl = (s.match(/[!?]+$/) || [''])[0];
      const isBlunder = nag.includes('$4') || /⁇|\?\?/.test(s);
      if (isBlunder) {
        r.blunders++;
        const v = g.verdicts[k] || '';
        if (v === 'positional') r.positional++;
        else if (v === 'simple material miss') r.simpleMiss++;
        else if (v === 'simple material loss') r.simpleLoss++;
      } else if (gl === '?!' || nag.includes('$6')) r.inaccuracies++;
      else if (gl === '?' || nag.includes('$2')) r.mistakes++;
    }
    return r;
  }

  // One CSV row (array of cells) for a fully-classified game.
  function buildRow(g) {
    const t = g.tags;
    const link = t.Site && /^https?:\/\//i.test(t.Site) ? t.Site : (t.Site || '');
    const date = t.Date || t.UTCDate || '';
    const moves = Math.ceil(g.sans.length / 2);
    const w = colorTally(g, 'w'), b = colorTally(g, 'b');
    return [
      link, t.White || '', t.WhiteElo || '', t.Black || '', t.BlackElo || '', t.Result || '', date, moves,
      w.blunders, w.positional, w.simpleMiss, w.simpleLoss, w.mistakes, w.inaccuracies,
      b.blunders, b.positional, b.simpleMiss, b.simpleLoss, b.mistakes, b.inaccuracies,
    ];
  }

  function csvEscape(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(rows) { return rows.map(r => r.map(csvEscape).join(',')).join('\n') + '\n'; }

  // Re-emit ONE game as annotated PGN (headers + evals + `{ blunder — <verdict> }`),
  // same format as index.html buildPgn() but with a clean single verdict comment.
  function buildGamePgn(g) {
    const order = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result', 'ECO', 'Opening', 'WhiteElo', 'BlackElo', 'TimeControl', 'Termination'];
    let h = '';
    for (const k of order) if (g.tags[k]) h += `[${k} "${g.tags[k]}"]\n`;
    for (const k of Object.keys(g.tags)) if (!order.includes(k) && k !== 'FEN') h += `[${k} "${g.tags[k]}"]\n`;
    if (g.fens[0] !== START) h += `[FEN "${g.fens[0]}"]\n`;
    h += '\n';
    const first = g.fens[0].split(' ')[1] === 'w';
    let num = 1, wtm = first;
    g.sans.forEach((s, i) => {
      const k = i + 1;
      if (wtm) h += num + '. ';
      else if (i === 0) h += num + '... ';
      h += s + ' ';
      if (g.nags[k] && !/\?\?|⁇/.test(s)) h += g.nags[k] + ' ';
      const bits = [];
      if (g.lichEvals[k] !== null && g.lichEvals[k] !== undefined) {
        const e = g.lichEvals[k];
        bits.push(Math.abs(e) > 90000 ? `[#${e > 0 ? '+' : '-'}]` : `[%eval ${(e / 100).toFixed(2)}]`);
      }
      if (g.cmts[k]) bits.push(g.cmts[k]);
      if (g.verdicts[k]) bits.push(`blunder — ${g.verdicts[k]}`);
      if (bits.length) h += '{ ' + bits.join(' ').replace(/[{}]/g, '') + ' } ';
      if (!wtm) num++;
      wtm = !wtm;
    });
    h += (g.tags.Result || '*') + '\n';
    return h;
  }

  return { START, HEADER, splitGames, parseGame, detectBlunders, materialParity, verdictFor, colorTally, buildRow, csvEscape, toCsv, buildGamePgn };
});
