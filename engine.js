// Material-only chess engine. 0x88 board, alpha-beta, quiescence, MVV-LVA, iterative deepening.
// Node: node engine.js [fen] [seconds]    |   Browser/other: import { Engine }
'use strict';
const VAL = [0, 100, 320, 330, 500, 900, 0];
const MAXP = 64, MATE = 100000;
const KN = [33, 31, 18, 14, -33, -31, -18, -14];
const BD = [17, 15, -17, -15], RD = [16, -16, 1, -1], KD = [17, 15, -17, -15, 16, -16, 1, -1];
const EP = 1, CASTLE = 2, DOUBLE = 3;
const MASK = new Uint8Array(128).fill(15);
MASK[0] = 13; MASK[4] = 12; MASK[7] = 14; MASK[112] = 7; MASK[116] = 3; MASK[119] = 11;
let _s = 0x9E3779B9;
const rnd = () => { _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5; return _s | 0; };
const mk = n => Int32Array.from({ length: n }, rnd);
const ZL = mk(13 * 128), ZH = mk(13 * 128), CL = mk(16), CH = mk(16), EL = mk(8), EH = mk(8), SL = rnd(), SH = rnd();
const TTBITS = 19, TTM = (1 << TTBITS) - 1;

class Engine {
  constructor(fen) {
    this.b = new Int8Array(128);
    this.kingSq = [4, 116];
    this.moves = Array.from({ length: MAXP + 2 }, () => new Int32Array(256));
    this.scores = Array.from({ length: MAXP + 2 }, () => new Int32Array(256));
    this.uCap = new Int8Array(2048); this.uCastle = new Uint8Array(2048);
    this.uEp = new Int16Array(2048); this.uMat = new Int32Array(2048);
    this.uHL = new Int32Array(2048); this.uHH = new Int32Array(2048);
    this.uN0 = new Int32Array(2048); this.uN1 = new Int32Array(2048);
    this.killers = Array.from({ length: MAXP + 2 }, () => new Int32Array(2));
    this.npm = [0, 0]; this.sp = 0; this.nodes = 0;
    this.setFen(fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  }
  setFen(fen) {
    const [pos, stm, cr, ep] = fen.split(' ');
    this.b.fill(0); this.mat = 0; this.npm = [0, 0]; this.sp = 0;
    let r = 7, f = 0;
    for (const c of pos) {
      if (c === '/') { r--; f = 0; }
      else if (c >= '1' && c <= '8') f += +c;
      else {
        const t = 'pnbrqk'.indexOf(c.toLowerCase()) + 1, col = c === c.toLowerCase() ? -1 : 1;
        const sq = r * 16 + f++;
        this.b[sq] = t * col; this.mat += col * VAL[t]; if (t > 1 && t < 6) this.npm[col === 1 ? 0 : 1] += VAL[t];
        if (t === 6) this.kingSq[col === 1 ? 0 : 1] = sq;
      }
    }
    this.side = stm === 'b' ? -1 : 1;
    this.castle = (cr.includes('K') ? 1 : 0) | (cr.includes('Q') ? 2 : 0) | (cr.includes('k') ? 4 : 0) | (cr.includes('q') ? 8 : 0);
    this.ep = ep && ep !== '-' ? (+ep[1] - 1) * 16 + ep.charCodeAt(0) - 97 : -1;
    this.hash();
  }
  attacked(sq, by) {
    const b = this.b;
    let s = sq - 15 * by, p;
    if (!(s & 0x88) && b[s] === by) return true;
    s = sq - 17 * by;
    if (!(s & 0x88) && b[s] === by) return true;
    for (let i = 0; i < 8; i++) {
      s = sq + KN[i]; if (!(s & 0x88) && b[s] === 2 * by) return true;
      s = sq + KD[i]; if (!(s & 0x88) && b[s] === 6 * by) return true;
    }
    for (let i = 0; i < 4; i++) {
      for (s = sq + BD[i]; !(s & 0x88); s += BD[i]) {
        p = b[s]; if (p) { if (p === 3 * by || p === 5 * by) return true; break; }
      }
      for (s = sq + RD[i]; !(s & 0x88); s += RD[i]) {
        p = b[s]; if (p) { if (p === 4 * by || p === 5 * by) return true; break; }
      }
    }
    return false;
  }
  gen(ply, caps) {
    const b = this.b, side = this.side, mv = this.moves[ply], sc = this.scores[ply];
    let n = 0;
    const add = (from, to, promo, flag) => {
      const cap = Math.abs(b[to]);
      mv[n] = from | (to << 7) | (promo << 14) | (flag << 17);
      sc[n++] = (cap ? 10 * VAL[cap] - VAL[Math.abs(b[from])] / 10 : 0) + (promo ? VAL[promo] : 0) + (flag === EP ? 1000 : 0);
    };
    for (let from = 0; from < 128; from++) {
      if (from & 0x88) { from += 7; continue; }
      const p = b[from];
      if (p * side <= 0) continue;
      const t = p * side;
      if (t === 1) {
        const dir = 16 * side, promoRank = side === 1 ? 6 : 1, startRank = side === 1 ? 1 : 6;
        const rank = from >> 4, to = from + dir;
        if (b[to] === 0) {
          if (rank === promoRank) {
            add(from, to, 5, 0);
            if (!caps) { add(from, to, 4, 0); add(from, to, 3, 0); add(from, to, 2, 0); }
          } else if (!caps) {
            add(from, to, 0, 0);
            if (rank === startRank && b[to + dir] === 0) add(from, to + dir, 0, DOUBLE);
          }
        }
        for (const d of [dir + 1, dir - 1]) {
          const c = from + d;
          if (c & 0x88) continue;
          if (b[c] * side < 0) {
            if (rank === promoRank) { add(from, c, 5, 0); add(from, c, 4, 0); add(from, c, 3, 0); add(from, c, 2, 0); }
            else add(from, c, 0, 0);
          } else if (c === this.ep) add(from, c, 0, EP);
        }
      } else if (t === 2 || t === 6) {
        const D = t === 2 ? KN : KD;
        for (let i = 0; i < 8; i++) {
          const to = from + D[i];
          if (to & 0x88) continue;
          const q = b[to] * side;
          if (q > 0) continue;
          if (q < 0 || !caps) add(from, to, 0, 0);
        }
        if (t === 6 && !caps) {
          const off = side === 1 ? 0 : 112, opp = -side;
          if (from === off + 4 && !this.attacked(from, opp)) {
            if ((this.castle & (side === 1 ? 1 : 4)) && !b[off + 5] && !b[off + 6] && !this.attacked(off + 5, opp) && !this.attacked(off + 6, opp))
              add(from, off + 6, 0, CASTLE);
            if ((this.castle & (side === 1 ? 2 : 8)) && !b[off + 3] && !b[off + 2] && !b[off + 1] && !this.attacked(off + 3, opp) && !this.attacked(off + 2, opp))
              add(from, off + 2, 0, CASTLE);
          }
        }
      } else {
        const nd = t === 3 ? 4 : t === 4 ? 4 : 8;
        for (let i = 0; i < nd; i++) {
          const d = t === 3 ? BD[i] : t === 4 ? RD[i] : KD[i];
          for (let to = from + d; !(to & 0x88); to += d) {
            const q = b[to] * side;
            if (q > 0) break;
            if (q < 0) { add(from, to, 0, 0); break; }
            if (!caps) add(from, to, 0, 0);
          }
        }
      }
    }
    return n;
  }
  make(m) {
    const b = this.b, side = this.side;
    const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flag = (m >> 17) & 7;
    const p = b[from], sp = this.sp++, mi = side === 1 ? 0 : 1;
    this.uCastle[sp] = this.castle; this.uEp[sp] = this.ep; this.uMat[sp] = this.mat;
    this.uHL[sp] = this.hl; this.uHH[sp] = this.hh; this.uN0[sp] = this.npm[0]; this.uN1[sp] = this.npm[1];
    this.hl ^= CL[this.castle]; this.hh ^= CH[this.castle];
    if (this.ep >= 0) { this.hl ^= EL[this.ep & 7]; this.hh ^= EH[this.ep & 7]; }
    let cap = b[to];
    if (flag === EP) { cap = b[to - 16 * side]; b[to - 16 * side] = 0; this.x(cap, to - 16 * side); }
    else if (cap) this.x(cap, to);
    this.uCap[sp] = cap;
    if (cap) { this.mat += side * VAL[Math.abs(cap)]; if (Math.abs(cap) > 1) this.npm[1 - mi] -= VAL[Math.abs(cap)]; }
    this.x(p, from);
    if (promo) { b[to] = promo * side; this.mat += side * (VAL[promo] - 100); this.npm[mi] += VAL[promo]; this.x(promo * side, to); }
    else { b[to] = p; this.x(p, to); }
    b[from] = 0;
    this.ep = flag === DOUBLE ? (from + to) >> 1 : -1;
    if (flag === CASTLE) {
      const rf = to > from ? to + 1 : to - 2, rt = to > from ? to - 1 : to + 1;
      b[rt] = b[rf]; b[rf] = 0; this.x(4 * side, rf); this.x(4 * side, rt);
    }
    if (p === 6 * side) this.kingSq[mi] = to;
    this.castle &= MASK[from] & MASK[to];
    this.hl ^= CL[this.castle] ^ SL; this.hh ^= CH[this.castle] ^ SH;
    if (this.ep >= 0) { this.hl ^= EL[this.ep & 7]; this.hh ^= EH[this.ep & 7]; }
    this.side = -side;
    if (this.attacked(this.kingSq[side === 1 ? 0 : 1], -side)) { this.unmake(m); return false; }
    return true;
  }
  unmake(m) {
    const b = this.b;
    const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flag = (m >> 17) & 7;
    const side = this.side = -this.side, sp = --this.sp, cap = this.uCap[sp];
    b[from] = promo ? side : b[to];
    if (flag === EP) { b[to] = 0; b[to - 16 * side] = cap; } else b[to] = cap;
    if (flag === CASTLE) {
      if (to > from) { b[to + 1] = b[to - 1]; b[to - 1] = 0; } else { b[to - 2] = b[to + 1]; b[to + 1] = 0; }
    }
    if (b[from] === 6 * side) this.kingSq[side === 1 ? 0 : 1] = from;
    this.castle = this.uCastle[sp]; this.ep = this.uEp[sp]; this.mat = this.uMat[sp];
    this.hl = this.uHL[sp]; this.hh = this.uHH[sp]; this.npm[0] = this.uN0[sp]; this.npm[1] = this.uN1[sp];
  }
  x(p, s) { this.hl ^= ZL[(p + 6) * 128 + s]; this.hh ^= ZH[(p + 6) * 128 + s]; }
  hash() {
    let l = 0, h = 0;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = this.b[s];
      if (p) { l ^= ZL[(p + 6) * 128 + s]; h ^= ZH[(p + 6) * 128 + s]; }
    }
    l ^= CL[this.castle]; h ^= CH[this.castle];
    if (this.ep >= 0) { l ^= EL[this.ep & 7]; h ^= EH[this.ep & 7]; }
    if (this.side === -1) { l ^= SL; h ^= SH; }
    this.hl = l; this.hh = h;
  }
  makeNull() {
    const sp = this.sp++;
    this.uEp[sp] = this.ep; this.uHL[sp] = this.hl; this.uHH[sp] = this.hh;
    if (this.ep >= 0) { this.hl ^= EL[this.ep & 7]; this.hh ^= EH[this.ep & 7]; }
    this.ep = -1; this.side = -this.side; this.hl ^= SL; this.hh ^= SH;
  }
  unmakeNull() {
    const sp = --this.sp;
    this.side = -this.side; this.ep = this.uEp[sp]; this.hl = this.uHL[sp]; this.hh = this.uHH[sp];
  }
  legal(m) { if (this.make(m)) { this.unmake(m); return true; } return false; }
  san(m) {
    const b = this.b, from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flag = (m >> 17) & 7, t = Math.abs(b[from]);
    let s;
    if (flag === CASTLE) s = to > from ? 'O-O' : 'O-O-O';
    else {
      const cap = b[to] || flag === EP, f = 'abcdefgh'[from & 7];
      if (t === 1) s = (cap ? f + 'x' : '') + Engine.sq(to) + (promo ? '=' + 'NBRQ'[promo - 2] : '');
      else {
        let amb = false, sf = false, sr = false;
        const n = this.gen(MAXP + 1, false);
        for (let i = 0; i < n; i++) {
          const o = this.moves[MAXP + 1][i], of = o & 127;
          if (o !== m && ((o >> 7) & 127) === to && Math.abs(b[of]) === t && this.legal(o)) {
            amb = true; if ((of & 7) === (from & 7)) sf = true; if ((of >> 4) === (from >> 4)) sr = true;
          }
        }
        s = 'NBRQK'[t - 2] + (amb ? (!sf ? f : !sr ? '' + ((from >> 4) + 1) : Engine.sq(from)) : '') + (cap ? 'x' : '') + Engine.sq(to);
      }
    }
    if (this.make(m)) {
      const chk = this.attacked(this.kingSq[this.side === 1 ? 0 : 1], -this.side);
      let any = false;
      const n = this.gen(MAXP + 1, false);
      for (let i = 0; i < n && !any; i++) any = this.legal(this.moves[MAXP + 1][i]);
      this.unmake(m);
      if (chk) s += any ? '+' : '#';
    }
    return s;
  }
  moveFromSan(s) {
    s = s.replace(/[+#]/g, '').replace(/0/g, 'O').replace(/([a-h][18])([NBRQ])$/, '$1=$2');
    const n = this.gen(0, false);
    for (let i = 0; i < n; i++) { const m = this.moves[0][i]; if (this.legal(m) && this.san(m).replace(/[+#]/g, '') === s) return m; }
    return 0;
  }
  pvSan(ucis) {
    const out = [], made = [];
    for (const u of ucis) {
      const n = this.gen(0, false); let m = 0;
      for (let i = 0; i < n; i++) if (Engine.str(this.moves[0][i]) === u) { m = this.moves[0][i]; break; }
      if (!m) break;
      out.push(this.san(m));
      if (!this.make(m)) break;
      made.push(m);
    }
    for (let j = made.length - 1; j >= 0; j--) this.unmake(made[j]);
    return out;
  }
  fen() {
    let s = '';
    for (let r = 7; r >= 0; r--) {
      let e = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.b[r * 16 + f];
        if (!p) e++; else { if (e) { s += e; e = 0; } const c = 'pnbrqk'[Math.abs(p) - 1]; s += p > 0 ? c.toUpperCase() : c; }
      }
      if (e) s += e; if (r) s += '/';
    }
    const c = (this.castle & 1 ? 'K' : '') + (this.castle & 2 ? 'Q' : '') + (this.castle & 4 ? 'k' : '') + (this.castle & 8 ? 'q' : '');
    return s + (this.side === 1 ? ' w ' : ' b ') + (c || '-') + ' ' + (this.ep >= 0 ? Engine.sq(this.ep) : '-') + ' 0 1';
  }
  pick(ply, i, n) {
    const mv = this.moves[ply], sc = this.scores[ply];
    let best = i;
    for (let j = i + 1; j < n; j++) if (sc[j] > sc[best]) best = j;
    if (best !== i) {
      let t = mv[i]; mv[i] = mv[best]; mv[best] = t;
      t = sc[i]; sc[i] = sc[best]; sc[best] = t;
    }
    return mv[i];
  }
  qsearch(alpha, beta, ply) {
    this.nodes++;
    const stand = this.side * this.mat;
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (ply >= MAXP) return stand;
    const n = this.gen(ply, true);
    for (let i = 0; i < n; i++) {
      const m = this.pick(ply, i, n);
      if (!this.make(m)) continue;
      const s = -this.qsearch(-beta, -alpha, ply + 1);
      this.unmake(m);
      if (s >= beta) return beta;
      if (s > alpha) alpha = s;
    }
    return alpha;
  }
  search(depth, alpha, beta, ply) {
    if (depth <= 0) return this.qsearch(alpha, beta, ply);
    if ((++this.nodes & 2047) === 0 && Date.now() > this.stopAt) this.stopped = true;
    if (this.stopped) return 0;
    const idx = this.side === 1 ? 0 : 1, i0 = this.hl & TTM, hit = this.tk[i0] === this.hh, d0 = depth;
    if (hit && this.td[i0] >= depth) {
      let s = this.ts[i0];
      if (s > MATE - 200) s -= ply; else if (s < -MATE + 200) s += ply;
      const f = this.tf[i0];
      if (f === 1 || (f === 2 && s >= beta) || (f === 3 && s <= alpha)) return s;
    }
    const ttMove = hit ? this.tm[i0] : 0;
    const inCheck = this.attacked(this.kingSq[idx], -this.side);
    if (inCheck && ply < MAXP - 2) depth++;
    if (!inCheck && depth >= 3 && this.side * this.mat >= beta && this.npm[idx] > 0 && beta < MATE - 200 && ply < MAXP - 2) {
      this.makeNull();
      const s = -this.search(depth - 3 - (depth >= 6 ? 1 : 0), -beta, -beta + 1, ply + 1);
      this.unmakeNull();
      if (this.stopped) return 0;
      if (s >= beta) return beta;
    }
    const n = this.gen(ply, false), mv = this.moves[ply], sc = this.scores[ply], k = this.killers[ply];
    for (let i = 0; i < n; i++) {
      const m = mv[i];
      if (m === ttMove) sc[i] += 1e6;
      else if (sc[i] === 0) { if (m === k[0]) sc[i] = 5000; else if (m === k[1]) sc[i] = 4000; }
    }
    let legal = 0, best = 0, flag = 3;
    for (let i = 0; i < n; i++) {
      const m = this.pick(ply, i, n);
      if (!this.make(m)) continue;
      legal++;
      const s = -this.search(depth - 1, -beta, -alpha, ply + 1);
      this.unmake(m);
      if (this.stopped) return 0;
      if (s >= beta) {
        if (!this.b[(m >> 7) & 127] && !((m >> 14) & 7) && ((m >> 17) & 7) !== EP && k[0] !== m) { k[1] = k[0]; k[0] = m; }
        this.store(i0, d0, beta, 2, m, ply);
        return beta;
      }
      if (s > alpha) { alpha = s; best = m; flag = 1; }
    }
    if (!legal) return inCheck ? -MATE + ply : 0;
    this.store(i0, d0, alpha, flag, best, ply);
    return alpha;
  }
  store(i, d, s, f, m, ply) {
    if (s > MATE - 200) s += ply; else if (s < -MATE + 200) s -= ply;
    this.tk[i] = this.hh; this.td[i] = d; this.ts[i] = s; this.tf[i] = f; this.tm[i] = m;
  }
  pv(m, maxLen) {
    const out = [Engine.str(m)], made = [], seen = new Set();
    if (!this.make(m)) return out;
    made.push(m);
    while (out.length < maxLen + 6) {
      const i = this.hl & TTM;
      if (this.tk[i] !== this.hh || !this.tm[i] || seen.has(this.hl)) break;
      seen.add(this.hl);
      const mm = this.tm[i], n = this.gen(MAXP + 1, false);
      let ok = false;
      for (let j = 0; j < n; j++) if (this.moves[MAXP + 1][j] === mm) { ok = true; break; }
      if (!ok || !this.make(mm)) break;
      made.push(mm); out.push(Engine.str(mm));
    }
    for (let j = made.length - 1; j >= 0; j--) this.unmake(made[j]);
    return out;
  }
  // think(ms, maxDepth, multipv, onInfo) -> { move, score, depth, nodes, nps }; onInfo gets {depth, multipv, score, pv:[uci], nodes, nps}
  think(ms = 1000, maxDepth = 64, multipv = 1, onInfo = null) {
    if (!this.tk) {
      const N = 1 << TTBITS;
      this.tk = new Int32Array(N); this.tm = new Int32Array(N); this.ts = new Int32Array(N);
      this.td = new Int8Array(N); this.tf = new Uint8Array(N);
    }
    const t0 = Date.now();
    this.stopAt = t0 + ms; this.stopped = false; this.nodes = 0;
    for (const k of this.killers) k.fill(0);
    const n = this.gen(0, false), root = [];
    for (let i = 0; i < n; i++) { const m = this.moves[0][i]; if (this.make(m)) { this.unmake(m); root.push({ m, s: 0 }); } }
    if (!root.length) return null;
    for (let i = root.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [root[i], root[j]] = [root[j], root[i]]; }
    multipv = Math.min(multipv, root.length);
    let res = null;
    for (let d = 1; d <= maxDepth; d++) {
      const out = []; let mate = false;
      for (let k = 0; k < multipv; k++) {
        let alpha = -MATE - 1, bi = -1;
        for (let i = k; i < root.length; i++) {
          this.make(root[i].m);
          const s = -this.search(d - 1, -MATE - 1, -alpha, 1);
          this.unmake(root[i].m);
          if (this.stopped) break;
          root[i].s = s;
          if (s > alpha) { alpha = s; bi = i; }
        }
        if (this.stopped) break;
        [root[k], root[bi]] = [root[bi], root[k]];
        if (k === 0 && root[0].s > MATE - 100) mate = true;
        out.push({ depth: d, multipv: k + 1, score: root[k].s, pv: this.pv(root[k].m, d) });
      }
      if (this.stopped) break;
      const nps = Math.round(this.nodes / Math.max(1, Date.now() - t0) * 1000);
      for (const o of out) { o.nodes = this.nodes; o.nps = nps; if (onInfo) onInfo(o); }
      res = { move: Engine.str(root[0].m), score: root[0].s, depth: d, nodes: this.nodes, nps };
      const rest = root.splice(multipv).sort((a, b) => b.s - a.s); root.push(...rest);
      if (mate) break;
    }
    return res;
  }
  static sq(s) { return String.fromCharCode(97 + (s & 7)) + ((s >> 4) + 1); }
  static str(m) { return Engine.sq(m & 127) + Engine.sq((m >> 7) & 127) + '  nbrq'[(m >> 14) & 7].trim(); }
  perft(d, ply = 0) {
    if (d === 0) return 1;
    const n = this.gen(ply, false); let c = 0;
    for (let i = 0; i < n; i++) { const m = this.moves[ply][i]; if (this.make(m)) { c += this.perft(d - 1, ply + 1); this.unmake(m); } }
    return c;
  }
  play(str) { // e.g. "e2e4", "e7e8q"
    const n = this.gen(0, false);
    for (let i = 0; i < n; i++) if (Engine.str(this.moves[0][i]) === str && this.make(this.moves[0][i])) return true;
    return false;
  }
}

if (typeof module !== 'undefined') module.exports = { Engine };
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = e => {
    const { fen, ms, depth, multipv } = e.data;
    new Engine(fen).think(ms, depth, multipv, i => self.postMessage(i));
    self.postMessage({ done: true });
  };
}
if (typeof require !== 'undefined' && require.main === module) {
  const e = new Engine(process.argv[2]);
  console.log(e.think((+process.argv[3] || 2) * 1000));
}
