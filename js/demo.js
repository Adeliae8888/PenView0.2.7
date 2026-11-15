/* ==== demo.js ==== デモ：アクティブルートの自動飛行（0.2.8）。決定は SPEC.md §4b
 * 始め：アクティブレグの始点から（1 番目のレグなら DEP の滑走路で離陸滑走から）
 * 経路：手順の区間は作図の線、それ以外・DIRECT は直線。速度・高度はフライトログ（風もログの値で GS に入っている）。ログが無ければデモ設定の GS・高度
 * DST で接地して止まる。MISSED APP・DIVERT・DIRECT TO にはそのまま従う。復行の最後に待機があれば回り続ける
 * 一時停止・早送り（×1/×2/×4/×8）：時計（clock.now）も一緒に進める・止める */
import { state, emit } from './state.js';
import { startSim, stopSim, setSimStep } from './gps.js';
import { activeRoute } from './route.js';
import { navContext } from './nav.js';
import { procLegPath, routeHoldLoop } from './proc-wire.js';
import { apStep, pathCum, nearestOnPath, legProfile, rollStart, DEMO_VS_FPM, GLIDE_FT_PER_NM } from './autopilot.js';
import { distanceNm, bearingTrue } from './geo.js';

export const DEMO_SPEEDS = [1, 2, 4, 8];
const HOLD_ENTER_NM = 1.5;
const HOLD_KT = 230;
const d = { on: false, paused: false, speed: 1, key: '', env: null, s: null, fallback: { gs: 420, alt: 20000 } };

export function demoState() { return { on: d.on, paused: d.paused, speed: d.speed, phase: d.s?.phase || null }; }

/* ==== startRouteDemo ==== 自動飛行を始める。fallback＝ログが無いときの {gs, alt}（デモ設定）。始められなければ理由の文字列 */
export function startRouteDemo(fallback) {
  const route = activeRoute();
  if (!route || route.points.length < 2) return 'アクティブルートがありません';
  d.fallback = fallback;
  const start = startState(route);
  if (!start) return 'アクティブレグの線を作れません';
  Object.assign(d, { on: true, paused: false, speed: 1, key: '', env: null, s: start });
  state.simClockMs = 0;
  startSim({ ...start, step: tick });
  emit('demo');
  return null;
}

/* ==== stopRouteDemo ==== 止める（自機はその場に残る）。keepFlying＝手で針路などを変えたとき：まっすぐ飛ぶ模擬飛行に切り替える */
export function stopRouteDemo({ keepFlying = false } = {}) {
  if (!d.on) return;
  d.on = false;
  if (keepFlying) setSimStep(null); else stopSim();
  state.simClockMs = 0;
  emit('demo');
}

export function setDemoSpeed(n) { if (DEMO_SPEEDS.includes(n)) { d.speed = n; emit('demo'); } }
export function toggleDemoPause() { d.paused = !d.paused; emit('demo'); }

/* ==== tick ==== 1秒ごと（模擬飛行のタイマー）：早送りの倍数だけ 1 秒ずつ進める。一時停止中は時計も止める */
function tick() {
  if (!d.on) return null;
  if (d.paused) { state.simClockMs -= 1000; return null; }
  const route = activeRoute();
  if (!route) { stopRouteDemo(); return null; }
  const phase0 = d.s.phase;
  for (let i = 0; i < d.speed; i += 1) {
    if (reachedHold(route, d.s)) d.key = '';   // 待機フィックスに着いた：周回の線に替える
    const env = envFor(route, d.s);
    if (!env) break;
    d.s = apStep(d.s, env, 1);
  }
  state.simClockMs += (d.speed - 1) * 1000;
  if (d.s.phase !== phase0) emit('demo');
  return { lat: d.s.lat, lon: d.s.lon, trk: d.s.trk, gs: d.s.gs, alt: Math.round(d.s.alt) };
}

/* ==== startState ==== 1 番目のレグ（離陸前）は滑走路で止まった状態、それ以外はアクティブレグの始点をログの高度・GS で */
function startState(route) {
  const env = envFor(route, null, true);
  if (!env) return null;
  if (route.activeIdx <= 1) {
    const r = rollStart(env.path);
    return { lat: r.lat, lon: r.lon, trk: r.trk, gs: 0, alt: Number(route.points[0].alt) || 0, phase: 'roll', pos: 0 };
  }
  const t = env.target(0);
  const p = env.path[0];
  let alt = Number.isFinite(t.alt) ? t.alt : d.fallback.alt;
  if (env.td) alt = Math.min(alt, env.tdElev + GLIDE_FT_PER_NM * (env.legEnd + env.tdRest));   // 進入の途中から：3° の上限
  return { lat: p.lat, lon: p.lon, trk: bearingTrue(p, env.path[1]), gs: t.gs || d.fallback.gs, alt, phase: 'air', pos: 0 };
}

/* ==== legPathAt ==== i 番目の点へ向かう線：手順の作図の線、または前の点（DIRECT は直行の始まり、飛ばした点の後は今の位置）からの直線 */
function legPathAt(route, i, s) {
  const proc = procLegPath(route, i);
  if (proc) return proc;
  const to = route.points[i];
  const origin = i === route.activeIdx ? route.flight?.directOrigin : null;
  const prev = route.points.slice(0, i).reverse().find((p) => !p.skipped);
  const from = origin || (route.points[i - 1]?.skipped && s ? s : prev) || s;
  return from ? [from, to] : null;
}

/* ==== envFor ==== 今のアクティブレグ（＋次のレグ）の線と、速度・高度・接地点。ルートが変わったら（STPT の進行・MISSED・DIVERT・DIRECT）作り直す */
function envFor(route, s, fresh = false) {
  const i = route.activeIdx;
  const key = `${route.id}|${i}|${route.points.length}|${route.flight?.directOrigin?.lat ?? ''}|${route.flight?.missed ? 1 : 0}|${route.flight?.diverted ? 1 : 0}|${d.s?.phase === 'hold' ? 'h' : ''}`;
  if (!fresh && key === d.key && d.env) return d.env;
  const cur = legPathAt(route, i, s);
  if (!cur) return null;
  const nextIdx = route.points.findIndex((p, k) => k > i && !p.skipped);
  const next = nextIdx > 0 ? legPathAt(route, nextIdx, null) : null;
  const path = next ? [...cur, ...next.slice(1)] : cur;
  const cum = pathCum(path);
  const legEnd = pathCum(cur).at(-1);
  const td = touchdown(route);
  const env = { path, cum, legEnd, ...td, target: profileFn(route, i, legEnd, td.td ? legEnd + td.tdRest : null) };
  const wasHold = s?.phase === 'hold';
  if (wasHold) s.phase = 'air';   // 待機を外れた（DIRECT・DIVERT）なら空中に戻る。まだ待機の条件なら下で戻す
  holdIfThere(route, s, env, wasHold);
  if (s) s.pos = nearestOnPath(path, cum, s, 0, path.length).idx;   // 線が替わったら一番近いところから
  if (!fresh) { d.key = key; d.env = env; }
  return env;
}

/* ==== profileFn ==== 区間の始めから along nm の目標 {alt, gs, vs}：フライトログ（区間の長さの比で当てる）、無ければデモ設定 */
function profileFn(route, i, curLen, tdLeft) {
  const nav = navContext();
  const leg = nav.plan?.ok ? nav.plan.legs.find((l) => l.toIndex === i) : null;
  const cap = speedCap(route, i);
  const capAt = (along) => (Number.isFinite(tdLeft) && tdLeft - along < FINAL_NM ? FINAL_KT : cap);
  if (!leg) return (along) => ({ alt: d.fallback.alt, gs: Math.min(d.fallback.gs, capAt(along)), vs: DEMO_VS_FPM });
  return (along) => {
    const t = legProfile(leg, curLen > 0 ? (along / curLen) * leg.dist : 0, nav.cfg);
    return { ...t, gs: Math.min(t.gs, capAt(along)) };
  };
}

/* ==== touchdown ==== 進入（APP の点へのレグ）と行き先へのレグ：接地点（手順の滑走路末端 RWxx、無ければ行き先）と、そこまでの残り（3° の上限に使う）
 * 接地してよいのは接地点へのレグとその次（行き先）だけ（final）。復行の点が最後（MISSED 後）なら無し */
function touchdown(route) {
  const pts = route.points;
  const last = pts.length - 1;
  const dst = pts[last];
  const i = route.activeIdx;
  if (dst.mark === 'MA') return { td: null };
  let t = pts.findIndex((p, k) => k >= i - 1 && !p.skipped && p.mark !== 'MA' && /^RW\d{2}/.test(p.name || '') && p.proc?.role === 'APP');
  if (t < 0) t = last;
  const onApp = pts[i]?.proc?.role === 'APP' && pts[i].mark !== 'MA';
  if (!onApp && i < last) return { td: null };
  let rest = 0;
  for (let k = i + 1; k <= t; k += 1) if (!pts[k].skipped) rest += Number.isFinite(pts[k].pathNm) ? pts[k].pathNm : distanceNm(pts[k - 1], pts[k]);
  return { td: pts[t], tdElev: Number(dst.alt) || 0, tdRest: t >= i ? rest : 0, final: i >= t };
}

/* ==== speedCap ==== 進入・復行はログの GS をそのまま使わない（進入の点に速度が無い）：進入 250kt、接地点まで 12nm から 170kt、復行 250kt、待機 230kt */
export const APP_KT = 250;
export const FINAL_KT = 170;
const FINAL_NM = 12;
function speedCap(route, i) {
  const p = route.points[i];
  if (p?.mark === 'MA') return APP_KT;
  if (p?.proc?.role !== 'APP' && i < route.points.length - 1) return Infinity;
  return APP_KT;
}

/* ==== reachedHold ==== 復行の最後の点（待機フィックス）の近くに来たか */
function reachedHold(route, s) {
  if (s.phase === 'hold' || !route.flight?.missed || route.flight?.diverted || route.activeIdx !== route.points.length - 1) return false;
  const loop = routeHoldLoop(route);
  return !!loop && distanceNm(s, loop[0]) <= HOLD_ENTER_NM;
}

/* ==== holdIfThere ==== 復行の最後の点（待機フィックス）に着いたら、待機の周回を何周分もつないでなぞる */
function holdIfThere(route, s, env, wasHold) {
  const last = route.points.length - 1;
  if (!s || !route.flight?.missed || route.flight?.diverted || route.activeIdx !== last) return;
  const loop = routeHoldLoop(route);
  if (!loop || (!wasHold && distanceNm(s, loop[0]) > HOLD_ENTER_NM)) return;
  const laps = Array.from({ length: 30 }, (_, k) => (k ? loop.slice(1) : loop)).flat();
  const alt = Number(route.points[last].alt) || s.alt;
  Object.assign(env, { path: laps, cum: pathCum(laps), legEnd: Infinity, target: () => ({ alt, gs: HOLD_KT }), td: null });
  s.phase = 'hold';
}
