// 0.2.8 デモの自動飛行の画面検証：node tests/e2e-demo.mjs <URL> <スクリーンショット出力dir> <RJAH の zip>
// 百里：機体登録 → ルート RJAH →（SID）→ HUC 360/40 →（APP RNP RWY21R）→ RJAH、代替 RJSK
// ① 1 番目のレグ：滑走路で離陸滑走 → 離陸（時刻を記録）→ SID の線をなぞって上昇（ログの高度）、×8 で時計も 8 倍
// ② 一時停止：位置も時計も止まる
// ③ アクティブを最終進入（H1R52）にして始める：レグの始点から → 3° で降りて RW21R で接地・停止
// ④ OMITT から → MISSED APP → 復行の線 → NAKAH で待機を回る
// ⑤ DIRECT TO にそのまま従う／手で針路を変えると自動が外れて模擬飛行が続く
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';

const [url, outDir, zip] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());
const R = {};
const wait = (ms) => page.waitForTimeout(ms);
await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector('body[data-ready="true"]');

// AIP（SID・APP）
await page.click('#settingsBtn');
await page.setInputFiles('#aipFile', [zip]);
await page.waitForSelector('[data-aip="apply"]', { timeout: 300000 });
await page.click('[data-aip="apply"]');
await wait(500);
await page.click('[data-close="settingsSheet"]');

// 機体
const fill = async (sel, v) => { await page.fill(sel, String(v)); await page.press(sel, 'Tab'); };
await page.click('#routeBtn');
await page.click('[data-tab="aircraft"]');
await page.click('[data-aact="newAc"]');
await fill('[data-acname]', 'F-16C');
await fill('[data-cf="name"]', 'CL');
const cfgVals = { fuelCap: 10000, taxiTakeoff: 500, approachLanding: 600, missedApproach: 900, reserve: 1500, 'climb.speed': 350, 'climb.roc': 6000, 'climb.ff': 9000, 'cruise.speed': 0.85, 'cruise.ff': 4000, 'descent.speed': 300, 'descent.rod': 4000, 'descent.ff': 1500 };
for (const [k, v] of Object.entries(cfgVals)) await fill(`[data-cf="${k}"]`, v);

// ルート
await page.click('[data-tab="route"]');
await page.click('[data-ract="new"]');
await page.selectOption('[data-rf="configRef"]', { index: 1 });
const add = async (list, text, alt) => {
  await page.fill(`[data-add-input="${list}"]`, text);
  if (alt !== undefined) await page.fill(`[data-add-alt="${list}"]`, String(alt));
  await page.click(`[data-add="${list}"]`);
};
await add('points', 'RJAH');
await add('points', 'RJAH');
await add('points', 'HUC 360/40', 15000);
await add('alternate', 'RJSK');
R.sidOptions = await page.$$eval('[data-rf="proc:SID"] option', (o) => o.map((x) => x.value).filter(Boolean));
const sid = R.sidOptions.find((v) => /GOPVU|21R/.test(v)) || R.sidOptions[0];
await page.selectOption('[data-rf="proc:SID"]', sid);
await page.selectOption('[data-rf="proc:APP"]', 'aip-RJAH-APP-RNP-RWY21R');
await wait(300);
const routeNames = () => page.evaluate(async () => { const m = await import('/js/route.js'); const r = m.activeRoute(); return { names: r.points.map((p) => p.name), idx: r.activeIdx, takeoffAt: r.flight.takeoffAt || null }; });
R.route = await routeNames();
await page.click('[data-close="routeSheet"]').catch(() => {});
await page.evaluate(async () => { const S = await import('/js/state.js'); S.updateSettings({ follow: true, orient: 'north' }); });

const snap = () => page.evaluate(async () => {
  const [S, D, C, Rt] = await Promise.all([import('/js/state.js'), import('/js/demo.js'), import('/js/clock.js'), import('/js/route.js')]);
  const o = S.state.own;
  const r = Rt.activeRoute();
  return { lat: o.lat, lon: o.lon, gs: o.gs, alt: o.alt, trk: o.trk, demo: D.demoState(), clockAhead: Math.round((C.now() - Date.now() - (S.state.settings.timeOffsetMs || 0)) / 1000), idx: r.activeIdx, active: r.points[r.activeIdx]?.name, takeoffAt: r.flight.takeoffAt || null, bar: !document.getElementById('demoBar').classList.contains('hidden'), phaseText: document.getElementById('demoPhase').textContent };
});
const startDemo = async () => {
  await page.click('#settingsBtn');
  await page.selectOption('#simMode', 'route');
  await page.click('#simToggle');
  await wait(300);
};
// 線からのずれ（SID の作図の線）
const offProc = (procId) => page.evaluate(async (id) => {
  const [S, P, W, A] = await Promise.all([import('/js/state.js'), import('/js/procedures.js'), import('/js/proc-wire.js'), import('/js/autopilot.js')]);
  const segs = W.buildForTest(P.findProcedure(id)).segments.filter((s) => !s.dashed && !s.hold);
  const path = segs.flatMap((s) => s.pts);
  const cum = A.pathCum(path);
  const o = S.state.own;
  const n = A.nearestOnPath(path, cum, o, 0, path.length);
  const G = await import('/js/geo.js');
  return +G.distanceNm(o, A.pointAlong(path, cum, n.along)).toFixed(2);
}, procId);

// ① 離陸から
await startDemo();
R.t0 = await snap();
await wait(3200);
R.roll = await snap();
await page.click('[data-demo-speed="8"]');
const offs = [];
for (let k = 0; k < 8; k += 1) { await wait(1500); offs.push(await offProc(sid)); }
R.climb = await snap();
R.sidMaxOff = Math.max(...offs);
await page.screenshot({ path: `${outDir}/d1_sid.png` });

// ② 一時停止
await page.click('#demoPause');
const p1 = await snap();
await wait(2200);
const p2 = await snap();
R.pause = { moved: p1.lat !== p2.lat || p1.lon !== p2.lon, clockFrozen: Math.abs(p2.clockAhead - p1.clockAhead) <= 3, text: p2.phaseText };
await page.click('#demoPause');
await page.click('#demoStop');
await wait(300);
R.stopped = await snap();

// ③ 最終進入（H1R52）から
const setActive = (name) => page.evaluate(async (n) => {
  const [Rt, S] = await Promise.all([import('/js/route.js'), import('/js/state.js')]);
  const r = Rt.activeRoute();
  const i = r.points.findIndex((p) => p.name === n);
  r.activeIdx = i; r.flight.takeoffAt = r.flight.takeoffAt || Date.now(); Rt.saveRoutes(); S.emit('route');
  return i;
}, name);
await setActive('H1R52');
await startDemo();
R.final0 = await snap();
await page.click('[data-demo-speed="8"]');
let fin = null;
const glide = [];
for (let k = 0; k < 40; k += 1) {
  await wait(1000);
  fin = await snap();
  glide.push([fin.alt, fin.demo.phase]);
  if (fin.demo.phase === 'landed') break;
}
R.final = fin;
R.glide = glide.slice(0, 12);
R.touch = await page.evaluate(async () => {
  const [S, Rt, G] = await Promise.all([import('/js/state.js'), import('/js/route.js'), import('/js/geo.js')]);
  const rw = Rt.activeRoute().points.find((p) => p.name === 'RW21R');
  return +G.distanceNm(S.state.own, rw).toFixed(2);
});
await page.screenshot({ path: `${outDir}/d2_landed.png` });
await page.click('#demoStop');

// ④ OMITT から → MISSED APP → 待機
await page.evaluate(async () => { const Rt = await import('/js/route.js'); Rt.resetFlight(Rt.activeRoute()); Rt.saveRoutes(); });
await setActive('OMITT');
await startDemo();
await page.click('[data-demo-speed="8"]');
await wait(2000);
await page.evaluate(async () => {
  const [Rt, W, S] = await Promise.all([import('/js/route.js'), import('/js/proc-wire.js'), import('/js/state.js')]);
  const r = Rt.activeRoute();
  Rt.executeMissed(r, W.routeMissedPoints(r)); S.emit('route');
});
let ho = null;
for (let k = 0; k < 70; k += 1) { await wait(1000); ho = await snap(); if (ho.demo.phase === 'hold') break; }
R.holdEnter = ho;
const holdTrk = [];
for (let k = 0; k < 14; k += 1) { await wait(1000); const s = await snap(); holdTrk.push(Math.round(s.trk)); }
R.holdTrk = holdTrk;
R.holdNear = await page.evaluate(async () => {
  const [S, W, Rt, G] = await Promise.all([import('/js/state.js'), import('/js/proc-wire.js'), import('/js/route.js'), import('/js/geo.js')]);
  const A = await import('/js/autopilot.js');
  const loop = W.routeHoldLoop(Rt.activeRoute());
  const cum = A.pathCum(loop);
  const n = A.nearestOnPath(loop, cum, S.state.own, 0, loop.length);
  return +G.distanceNm(S.state.own, A.pointAlong(loop, cum, n.along)).toFixed(2);
});
await page.screenshot({ path: `${outDir}/d3_hold.png` });

// ⑤ DIRECT TO（RJSK）→ その向きへ／手で針路 → 自動が外れる
await page.evaluate(async () => {
  const [Rt, S, P] = await Promise.all([import('/js/route.js'), import('/js/state.js'), import('/js/points.js')]);
  const r = Rt.activeRoute();
  const t = P.findPoint('RJSK');
  Rt.executeDirect(r, { name: 'RJSK', lat: t.lat, lon: t.lon }, S.state.own); S.emit('route');
});
await wait(25000);
R.direct = await page.evaluate(async () => {
  const [S, G, P, Rt] = await Promise.all([import('/js/state.js'), import('/js/geo.js'), import('/js/points.js'), import('/js/route.js')]);
  const t = P.findPoint('RJSK');
  const o = S.state.own;
  const org = Rt.activeRoute().flight.directOrigin;
  return { trk: Math.round(o.trk), brg: Math.round(G.bearingTrue(org, t)), xtk: +Math.abs(G.crossTrackNm(org, t, o)).toFixed(2) };
});
await page.click('#settingsBtn');
await page.fill('#simTrk', '180'); await page.press('#simTrk', 'Tab');
await wait(1500);
R.manual = await snap();
R.manualMode = await page.inputValue('#simMode');

// ⑥ ルートから飛行場を消す → つながる手順（SID・APP）も消える（UI の ×）
await page.click('#demoStop').catch(() => {});
await page.evaluate(async () => { const [Rt, G, S] = await Promise.all([import('/js/route.js'), import('/js/gps.js'), import('/js/state.js')]); G.stopSim(); Rt.resetFlight(Rt.activeRoute()); Rt.saveRoutes(); S.emit('route'); });
await page.click('[data-close="settingsSheet"]').catch(() => {});
await page.click('#routeBtn');
await page.click('[data-tab="route"]');
const delAt = async (name) => {
  const i = await page.evaluate(async (n) => { const Rt = await import('/js/route.js'); const pts = Rt.activeRoute().points; return pts.map((p, k) => (!p.proc && p.name === n ? k : -1)).filter((k) => k >= 0).at(-1); }, name);
  await page.click(`[data-pact="del"][data-list="points"][data-i="${i}"]`);
  await wait(400);
};
const procsNow = () => page.evaluate(async () => { const Rt = await import('/js/route.js'); const r = Rt.activeRoute(); return { names: r.points.map((p) => p.name), procs: r.procs, procPts: r.points.filter((p) => p.proc).length }; });
R.beforeDel = await procsNow();
await delAt('RJAH');   // 最後の RJAH＝DST
R.delDst = await procsNow();
await delAt('RJAH');   // DEP
R.delDep = await procsNow();
await browser.close();
console.log(JSON.stringify(R, null, 1));

const ang = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const checks = {
  '① 滑走路で止まった状態から': R.t0.demo.on && R.t0.demo.phase === 'roll' && R.t0.gs === 0 && R.t0.bar,
  '① 離陸滑走で加速（滑走路の向きのまま）': R.roll.gs >= 15 && R.roll.alt === R.t0.alt && Math.abs(R.roll.trk - R.t0.trk) < 0.1,
  '① 離陸時刻を記録': !!R.climb.takeoffAt,
  '① SID の線をなぞって上昇（線から 0.6nm 以内）': R.climb.demo.phase === 'air' && R.climb.alt > 3000 && R.sidMaxOff < 0.6,
  '① ×8 で時計も進む': R.climb.clockAhead >= 60,
  '② 一時停止：位置と時計が止まる': !R.pause.moved && R.pause.clockFrozen && R.pause.text === '一時停止',
  '② 停止で DEMO が消える': !R.stopped.demo.on && !R.stopped.bar,
  '③ レグの始点（H1R52 の前の点）から始める': R.final0.demo.phase === 'air' && ['H1R52', 'RW21R'].includes(R.final0.active),
  '③ RW21R の近くで接地して止まる': R.final.demo.phase === 'landed' && R.final.gs === 0 && R.touch < 1.5,
  '④ MISSED APP の後、NAKAH で待機を回る': R.holdEnter.demo.phase === 'hold' && R.holdNear < 1 && new Set(R.holdTrk.map((t) => Math.round(t / 30))).size >= 3,
  '⑤ DIRECT TO の直行線へ（近づく向き）': ang(R.direct.trk, R.direct.brg) < 25 && R.direct.xtk < 1.5,
  '⑥ DST を消すと APP が外れ点も消える': R.beforeDel.procs.APP && !R.delDst.procs.APP && !R.delDst.names.some((n) => ['NAKAH', 'RW21R', 'H1R52'].includes(n)) && !!R.delDst.procs.SID,
  '⑥ DEP を消すと SID が外れ点も消える': !R.delDep.procs.SID && R.delDep.procPts === 0,
  '⑤ 手で針路を変えると自動が外れて模擬飛行が続く': !R.manual.demo.on && R.manualMode === 'manual' && R.manual.gs > 0,
};
Object.entries(checks).forEach(([k, v]) => console.log(`${v ? 'OK ' : 'NG '} ${k}`));
console.log('errors:', errors.length ? errors : 'none');
process.exitCode = Object.values(checks).every(Boolean) && !errors.length ? 0 : 1;
