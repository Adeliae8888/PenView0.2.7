/* ==== autopilot.js ==== デモの自動飛行の計算（0.2.8）。DOM・ルートの保存に依存しない（テストでそのまま使う）
 * 経路の線（折れ線）を先読みの点に向かってなぞる（バンク 30° の旋回率まで）。次の区間の線もつなげておくので STPT の手前から回り込む（フライバイ）
 * 速度・高度はフライトログの区間（上昇・巡航・降下の GS と高度）。離陸滑走・着陸（3° の進入角で接地 → 停止）・待機の周回もここ */
import { destination, distanceNm, bearingTrue, norm360 } from './geo.js';

export const BANK_DEG = 30;
export const ROTATE_KT = 150;          // 離陸滑走でこの GS になったら浮く
export const ROLL_ACCEL_KT_S = 6;      // 離陸滑走の加速
export const DECEL_KT_S = 4;           // 着陸滑走の減速
export const GS_ACCEL_KT_S = 4;        // 空中の速度変化
export const MAX_VS_FPM = 6000;        // 高度変化の上限（ログの高度へ寄せるとき）
export const DEMO_VS_FPM = 2500;       // ログが無いとき（デモ設定の高度へ）の上昇・降下率
export const GLIDE_FT_PER_NM = 318;    // 3° の進入角
const TOUCH_NM = 0.15;
const LAND_ABOVE_FT = 300;          // 接地点の標高からこれ以下なら接地できる

/* ==== flat ==== 近くの点どうしの平面近似（nm）。原点 o からの東・北 */
function flat(o, p) {
  const k = Math.cos((o.lat * Math.PI) / 180);
  return { x: (p.lon - o.lon) * 60 * k, y: (p.lat - o.lat) * 60 };
}

/* ==== pathCum ==== 折れ線の各点までの累積距離 */
export function pathCum(path) {
  const cum = [0];
  for (let i = 1; i < path.length; i += 1) cum.push(cum[i - 1] + distanceNm(path[i - 1], path[i]));
  return cum;
}

/* ==== nearestOnPath ==== 折れ線の上で p に一番近いところ。from 以降の区間だけ探す（戻らない。待機の周回で反対側に飛ばない）→ { idx, along } */
export function nearestOnPath(path, cum, p, from = 0, span = 400) {
  let best = { idx: Math.max(0, from), along: cum[Math.max(0, from)] || 0, d: Infinity };
  for (let i = Math.max(0, from); i < Math.min(path.length - 1, from + span); i += 1) {
    const a = flat(p, path[i]);
    const b = flat(p, path[i + 1]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len2)) : 0;
    const d = Math.hypot(a.x + dx * t, a.y + dy * t);
    if (d < best.d - 1e-9) best = { idx: i, along: cum[i] + (cum[i + 1] - cum[i]) * t, d };
  }
  return best;
}

/* ==== pointAlong ==== 折れ線の始まりから along nm の点。終わりより先は最後の向きに延ばす */
export function pointAlong(path, cum, along) {
  const n = path.length;
  if (n === 1) return path[0];
  if (along >= cum[n - 1]) return destination(path[n - 1], bearingTrue(path[n - 2], path[n - 1]), along - cum[n - 1]);
  let i = 0;
  while (i < n - 2 && cum[i + 1] < along) i += 1;
  const seg = cum[i + 1] - cum[i];
  return destination(path[i], bearingTrue(path[i], path[i + 1]), seg > 0 ? along - cum[i] : 0);
}

/* ==== turnRateDeg ==== バンク 30° の旋回率（°/秒）。遅いときも 100kt として扱う */
export function turnRateDeg(gs) {
  return (1091 * Math.tan((BANK_DEG * Math.PI) / 180)) / Math.max(100, gs || 0);
}

/* ==== lookAheadNm ==== 先読みの距離：旋回半径の 1.2 倍（0.4〜3nm） */
export function lookAheadNm(gs) {
  const r = (Math.max(100, gs) ** 2) / (68625 * Math.tan((BANK_DEG * Math.PI) / 180));
  return Math.max(0.4, Math.min(3, r * 1.2));
}

/* ==== steer ==== 今の航跡から目標の向きへ、旋回率まで回す */
export function steer(trk, want, gs, dt) {
  const diff = ((want - trk + 540) % 360) - 180;
  const max = turnRateDeg(gs) * dt;
  return norm360(trk + Math.max(-max, Math.min(max, diff)));
}

/* ==== approach ==== 値を目標へ、1秒あたり rate まで寄せる */
export function approach(v, target, rate, dt) {
  if (!Number.isFinite(target)) return v;
  const d = target - v;
  return Math.abs(d) <= rate * dt ? target : v + Math.sign(d) * rate * dt;
}

/* ==== legProfile ==== フライトログの区間の、区間の始めから dist nm の高度と GS。scaled（巡航に届かない上昇・降下）は上昇率・降下率で延ばす */
export function legProfile(leg, dist, cfg) {
  let cum = 0;
  let alt = leg.segs[0]?.altStart ?? null;
  for (const s of leg.segs) {
    const rate = s.phase === 'climb' ? cfg?.climb?.roc : s.phase === 'descent' ? -(cfg?.descent?.rod || 0) : 0;
    const a0 = Number.isFinite(s.altStart) ? s.altStart : alt;
    const a1 = Number.isFinite(s.altEnd) ? s.altEnd : a0 + (rate || 0) * s.time * 60;
    if (dist <= cum + s.dist || s === leg.segs.at(-1)) {
      const f = s.dist > 0 ? Math.max(0, Math.min(1, (dist - cum) / s.dist)) : 1;
      return { alt: a0 + (a1 - a0) * f, gs: s.gs };
    }
    cum += s.dist;
    alt = a1;
  }
  return { alt: null, gs: null };
}

/* ==== apStep ==== 1秒分（dt 秒）進める。s：{lat, lon, trk, gs, alt, phase:'roll'|'air'|'landing'|'landed', pos}
 * env：{ path, cum, legEnd（今の区間の終わりの along）, target(along) → {alt, gs, vs}, td（接地点）|null, tdElev, tdRest（今の区間の後、接地点までの距離）, final（接地してよい区間） } → 新しい s */
export function apStep(s, env, dt = 1) {
  if (s.phase === 'landed') return s;
  if (s.phase === 'landing') {
    const gs = Math.max(0, s.gs - DECEL_KT_S * dt);
    const p = destination(s, s.trk, ((s.gs + gs) / 2) * dt / 3600);
    return { ...s, ...p, gs, alt: env.tdElev ?? s.alt, phase: gs <= 0 ? 'landed' : 'landing' };
  }
  const near = nearestOnPath(env.path, env.cum, s, s.pos ?? 0);
  const want = bearingTrue(s, pointAlong(env.path, env.cum, near.along + lookAheadNm(s.gs)));
  const tgt = env.target(Math.min(near.along, env.legEnd));
  let { alt, gs } = s;
  if (s.phase === 'roll') {
    gs = s.gs + ROLL_ACCEL_KT_S * dt;
  } else {
    gs = approach(s.gs, tgt.gs, GS_ACCEL_KT_S, dt);
    let ta = tgt.alt;
    if (env.td) ta = Math.min(ta ?? Infinity, (env.tdElev || 0) + GLIDE_FT_PER_NM * tdDistance(s, env, near.along));   // 進入は 3° より上に出ない
    alt = approach(s.alt, ta, (tgt.vs || MAX_VS_FPM) / 60, dt);
  }
  const trk = s.phase === 'roll' ? s.trk : steer(s.trk, want, s.gs, dt);
  const p = destination(s, trk, ((s.gs + gs) / 2) * dt / 3600);
  let phase = s.phase === 'roll' && gs >= ROTATE_KT ? 'air' : s.phase;
  if (phase === 'air' && env.td && env.final !== false && alt <= (env.tdElev || 0) + LAND_ABOVE_FT && touchedDown(s, env.td)) phase = 'landing';   // 高すぎれば降りない（そのまま進む）
  return { ...s, ...p, trk, gs, alt: phase === 'landing' ? env.tdElev ?? alt : alt, phase, pos: near.idx };
}

/* ==== tdDistance ==== 接地点までの残りの距離：経路に沿って（今の区間の残り＋その先の区間 tdRest）。tdRest が無ければ直線 */
function tdDistance(s, env, along) {
  return Number.isFinite(env.tdRest) ? Math.max(0, env.legEnd - along) + env.tdRest : distanceNm(s, env.td);
}

/* ==== touchedDown ==== 接地点の上（0.15nm 以内）か、3nm 以内で接地点を過ぎた */
function touchedDown(s, td) {
  const d = distanceNm(s, td);
  if (d <= TOUCH_NM) return true;
  const rel = Math.abs(((bearingTrue(s, td) - s.trk + 540) % 360) - 180);
  return d < 3 && rel > 90;
}

/* ==== rollStart ==== 離陸滑走の始まり：経路の始まりから、浮くまでの滑走距離だけ手前（最初の向きの反対） */
export function rollStart(path) {
  const trk = bearingTrue(path[0], path[1] || path[0]);
  const rollNm = (ROTATE_KT ** 2 / (2 * ROLL_ACCEL_KT_S)) / 3600;
  return { ...destination(path[0], trk + 180, rollNm), trk };
}
