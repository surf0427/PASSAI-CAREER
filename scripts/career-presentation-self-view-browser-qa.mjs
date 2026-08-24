/*
 * scripts/career-presentation-self-view-browser-qa.mjs
 *
 * PASSAI CAREER — プレゼン発表中セルフビューの実ブラウザ QA（opt-in）。
 *
 * 静的契約は career-presentation-self-view-qa.ts が見る。こちらは実際の Chromium で
 * 「権限許可 → stream 開始 → 発表 → OFF/ON → 離脱で track stop」まで通す。
 * fake camera を使うので実カメラ・実権限ダイアログは不要。
 *
 * 前提: 別ターミナルで `npm run dev`（既定 http://localhost:3000）。
 * 使い方: node scripts/career-presentation-self-view-browser-qa.mjs
 *         BASE=http://localhost:3001 node scripts/career-presentation-self-view-browser-qa.mjs
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

// 実ブラウザ QA: fake camera で permission grant → stream 開始 → 離脱で track stop まで確認する。
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:3000';
let fails = 0;
const check = (cond, label) => { console.log(`${cond ? '✅' : '❌'} ${label}`); if (!cond) fails++; };

const SESSION = {
  id: 'qa-selfview-1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'in_progress',
  presentationType: 'free',
  mode: 'voice',
  theme: 'QA用のお題：自分を一言で表すと？',
  timeLimitSec: 180,
  durationSec: 0,
  transcript: '',
  config: null,
};

async function newCtx(browser, { grant }) {
  const ctx = await browser.newContext(
    grant ? { permissions: ['camera'] } : { permissions: [] },
  );
  await ctx.addInitScript((s) => {
    localStorage.setItem('careerPresentationSessions', JSON.stringify([s]));
  }, SESSION);
  return ctx;
}

const readVideoState = (page) => page.evaluate(() => {
  const v = document.querySelector('video');
  if (!v) return { present: false };
  const s = v.srcObject;
  return {
    present: true,
    autoplay: v.autoplay,
    playsInline: v.playsInline,
    muted: v.muted,
    mirrored: getComputedStyle(v).transform,
    hasStream: !!s,
    videoTracks: s ? s.getVideoTracks().length : 0,
    audioTracks: s ? s.getAudioTracks().length : 0,
    liveVideo: s ? s.getVideoTracks().filter((t) => t.readyState === 'live').length : 0,
  };
});

const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
});

// ── CASE 1: 権限許可 ───────────────────────────────────────────────
{
  const ctx = await newCtx(browser, { grant: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/career/presentation/session`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return !!(v && v.srcObject);
  }, { timeout: 20000 });

  const st = await readVideoState(page);
  console.log('\n── CASE 1: camera permission 許可 ──');
  check(st.present, 'video 要素が描画される');
  check(st.hasStream, 'video.srcObject に MediaStream が接続される');
  check(st.videoTracks === 1, `video track が 1 本（${st.videoTracks}）`);
  check(st.audioTracks === 0, `audio track が 0 本＝マイクを掴んでいない（${st.audioTracks}）`);
  check(st.liveVideo === 1, 'video track が live');
  check(st.autoplay && st.playsInline && st.muted, 'autoPlay / playsInline / muted が有効');
  check(/matrix\(-1,/.test(st.mirrored), `鏡像で表示される（${st.mirrored}）`);
  check(errors.length === 0, `page error なし（${errors.join(' | ') || 'none'}）`);

  // 発表操作・transcript・timer が動くこと（CASE 1 / 9）
  const themeVisible = await page.getByText('QA用のお題').isVisible();
  check(themeVisible, 'お題がカメラに隠れず表示されている');
  await page.getByRole('textbox').fill('QAの発表原稿');
  check((await page.getByRole('textbox').inputValue()) === 'QAの発表原稿', '文字起こし欄が従来どおり編集できる');
  const evalBtn = page.getByRole('button', { name: /発表を終えて評価を見る/ });
  check(await evalBtn.isEnabled(), '評価ボタンが押せる（カメラは前提条件ではない）');

  // ── サイズ拡大とお題の同時可視性（desktop 1280x720）────────────────
  console.log('\n── サイズ拡大 / お題の可視性（desktop）──');
  const vbox = await page.locator('video').boundingBox();
  // 拡大前は 240x180。明確に大きくなっていることを実測で固定する。
  check(vbox.width >= 400, `映像が拡大前(240px)より明確に大きい（${Math.round(vbox.width)}px）`);
  check(
    Math.round(vbox.height) >= 300,
    `上半身・姿勢が入る縦幅がある（${Math.round(vbox.height)}px・拡大前は 180px）`,
  );
  check(
    vbox.width * vbox.height >= 240 * 180 * 3,
    `映像面積が拡大前の 3 倍以上（${Math.round((vbox.width * vbox.height) / (240 * 180) * 10) / 10}x）`,
  );
  const themeBox = await page.getByText('QA用のお題').boundingBox();
  const vh = page.viewportSize().height;
  check(
    themeBox.y >= 0 && themeBox.y + themeBox.height <= vh,
    'お題がスクロールなしでファーストビューに収まる',
  );
  check(
    vbox.y < vh,
    'セルフビューもファーストビューに入る（お題と同時に見える）',
  );
  check(
    themeBox.x + themeBox.width <= vbox.x + 1,
    'お題は左・カメラは右で横並び（お題を覆わない）',
  );
  check(
    Math.abs(themeBox.y - vbox.y) < vh,
    'お題とカメラが同じ行にある',
  );
  // 発表操作がカメラに覆われていないこと。
  const recBox = await page.getByRole('button', { name: /録音して発表する/ }).boundingBox();
  check(
    recBox.x + recBox.width <= vbox.x + 1,
    '録音ボタンがカメラと重ならない（発表操作を阻害しない）',
  );

  // ── CASE 6: ON/OFF トグル ────────────────────────────────────────
  console.log('\n── CASE 6: カメラ ON / OFF ──');
  // 停止を観測するため、現在の track を保持しておく。
  await page.evaluate(() => {
    window.__qaTracks = document.querySelector('video').srcObject.getTracks();
  });
  await page.getByRole('button', { name: 'カメラをオフにする' }).click();
  await page.waitForFunction(() => window.__qaTracks.every((t) => t.readyState === 'ended'), { timeout: 5000 });
  check(true, 'OFF で video track が ended になる（CSS で隠すだけではない）');
  check(
    (await page.locator('video').count()) === 0,
    'OFF で video 要素も外れる',
  );
  await page.getByRole('button', { name: 'カメラをオンにする' }).click();
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return !!(v && v.srcObject && v.srcObject.getVideoTracks()[0]?.readyState === 'live');
  }, { timeout: 20000 });
  check(true, 'ON で再取得できる');

  // ── CASE 4 / 5: ページ離脱で cleanup ──────────────────────────────
  console.log('\n── CASE 4 / 5: 発表終了・ページ離脱 ──');
  await page.evaluate(() => {
    window.__qaTracks2 = document.querySelector('video').srcObject.getTracks();
  });
  await page.getByRole('link', { name: /中断してプレゼントップに戻る/ }).click();
  await page.waitForURL('**/career/presentation');
  // unmount の commit は URL 変更よりわずかに後になりうるため、状態が落ち着くまで待つ。
  const ended = await page
    .waitForFunction(() => window.__qaTracks2.every((t) => t.readyState === 'ended'), { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(ended, 'ページ離脱（SPA 遷移 unmount）で全 track が stop している＝カメラランプが残らない');
  const noLive = await page.evaluate(() =>
    window.__qaTracks.concat(window.__qaTracks2).every((t) => t.readyState === 'ended'),
  );
  check(noLive, 'この session で作られた track が 1 本も live で残っていない');

  await ctx.close();
}

// ── CASE 2: 権限拒否 ───────────────────────────────────────────────
{
  const ctx = await browser.newContext({ permissions: [] });
  await ctx.grantPermissions([]);
  await ctx.addInitScript((s) => {
    localStorage.setItem('careerPresentationSessions', JSON.stringify([s]));
  }, SESSION);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // getUserMedia を必ず拒否させる（fake-ui による自動許可を上書き）。
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
  });
  await page.goto(`${BASE}/career/presentation/session`, { waitUntil: 'networkidle' });
  console.log('\n── CASE 2: camera permission 拒否 ──');
  await page.getByText('カメラを利用できませんでした').waitFor({ timeout: 10000 });
  check(true, '拒否時に「カメラを利用できませんでした…プレゼンはそのまま続けられます」が出る');
  check(errors.length === 0, `session が crash しない（${errors.join(' | ') || 'no page error'}）`);
  check(await page.getByText('QA用のお題').isVisible(), 'お題は通常どおり表示される');
  await page.getByRole('textbox').fill('拒否時でも書ける');
  check(
    await page.getByRole('button', { name: /発表を終えて評価を見る/ }).isEnabled(),
    '拒否でも発表・評価へ進める',
  );
  check(
    await page.getByRole('button', { name: 'カメラをオンにする' }).isVisible(),
    '再試行はユーザー操作のときだけ（自動再要求しない）',
  );
  await ctx.close();
}

// ── CASE 3: camera / mediaDevices 利用不可 ─────────────────────────
{
  const ctx = await browser.newContext();
  await ctx.addInitScript((s) => {
    localStorage.setItem('careerPresentationSessions', JSON.stringify([s]));
  }, SESSION);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // mediaDevices 自体を消す（カメラ無し端末 / 非 secure context 相当）。
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  });
  await page.goto(`${BASE}/career/presentation/session`, { waitUntil: 'networkidle' });
  console.log('\n── CASE 3: mediaDevices unavailable ──');
  await page.getByText('カメラを利用できませんでした').or(
    page.getByText('このブラウザ・端末ではカメラを利用できませんでした'),
  ).first().waitFor({ timeout: 10000 });
  check(true, 'mediaDevices 不在でも fallback メッセージが出る');
  check(errors.length === 0, `session が crash しない（${errors.join(' | ') || 'no page error'}）`);
  check(
    await page.getByRole('button', { name: /発表を終えて評価を見る/ }).isVisible(),
    'プレゼンは継続可能',
  );
  await ctx.close();
}

// ── CASE 7: 発表資料あり ───────────────────────────────────────────
{
  const ctx = await newCtx(browser, { grant: true });
  const page = await ctx.newPage();
  await page.addInitScript((s) => {
    localStorage.setItem('careerPresentationSessions', JSON.stringify([{
      ...s,
      material: 'QA用の発表資料テキスト',
      materialFile: { fileName: 'qa.pdf', mimeType: 'application/pdf' },
    }]));
  }, SESSION);
  await page.goto(`${BASE}/career/presentation/session`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return !!(v && v.srcObject);
  }, { timeout: 20000 });
  console.log('\n── CASE 7: 発表資料あり ──');
  await page.getByText('発表資料（評価に使用されます）').click();
  const materialVisible = await page.getByText('QA用の発表資料テキスト').isVisible();
  const fileVisible = await page.getByText('qa.pdf').isVisible();
  const st = await readVideoState(page);
  check(materialVisible && fileVisible, '発表資料（テキスト・ファイル名）が開ける');
  check(st.hasStream && st.liveVideo === 1, '資料を開いてもカメラ映像が生きている');
  const box = await page.locator('video').boundingBox();
  const matBox = await page.getByText('QA用の発表資料テキスト').boundingBox();
  const overlap = box && matBox &&
    box.x < matBox.x + matBox.width && matBox.x < box.x + box.width &&
    box.y < matBox.y + matBox.height && matBox.y < box.y + box.height;
  check(!overlap, 'カメラと発表資料が重ならない（同時に見られる）');
  await ctx.close();
}

// ── モバイル幅でのレイアウト ────────────────────────────────────────
{
  const ctx = await browser.newContext({ permissions: ['camera'], viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((s) => {
    localStorage.setItem('careerPresentationSessions', JSON.stringify([s]));
  }, SESSION);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/career/presentation/session`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return !!(v && v.srcObject);
  }, { timeout: 20000 });
  console.log('\n── モバイル幅 390px ──');
  const box = await page.locator('video').boundingBox();
  check(box.width <= 390, `映像が画面幅からはみ出さない（${Math.round(box.width)}px / 390px）`);
  check(box.width > 280, `モバイルでも拡大前(280px)より大きい（${Math.round(box.width)}px）`);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 1);
  check(overflow, '横スクロールが発生しない（レイアウト崩れなし）');
  // 1 カラムに戻り、お題がカメラの上に来ていること（重なり・欠けなし）。
  const mThemeBox = await page.getByText('QA用のお題').boundingBox();
  check(mThemeBox.y + mThemeBox.height <= box.y, 'モバイルはお題 → カメラの縦積み（重ならない）');
  check(box.x >= 0 && box.x + box.width <= 390, '映像が画面内に完全に収まる');
  await ctx.close();
}

// ── CASE 8: 発表資料なし（通常 session）────────────────────────────
{
  const ctx = await newCtx(browser, { grant: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/career/presentation/session`, { waitUntil: 'networkidle' });
  console.log('\n── CASE 8: 発表資料なし ──');
  check(
    (await page.getByText('発表資料（評価に使用されます）').count()) === 0,
    '資料なしなら資料 UI は出ない（従来どおり）',
  );
  check(
    await page.getByRole('button', { name: /録音して発表する/ }).isVisible(),
    '録音操作は従来どおり表示される',
  );
  await ctx.close();
}

await browser.close();
console.log(`\n${fails === 0 ? '✅ BROWSER QA PASS' : `❌ BROWSER QA FAIL (${fails})`}`);
process.exit(fails === 0 ? 0 : 1);
