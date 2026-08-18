/*
 * scripts/career-presentation-api-security-qa.ts
 *
 * PASSAI CAREER — プレゼン AI route の security 契約 QA（dev-only 常設・決定的）。
 *
 * 対象:
 *   POST /api/career/presentation/theme
 *   POST /api/career/presentation/evaluate
 *   POST /api/career/presentation/qa
 *
 * 目的（Production Readiness Audit P0-1 の回帰ガード）:
 *   3 route が AI へ到達する前に
 *     1. Career（Project B）server identity を確定し
 *     2. rate limit（member=user_id / guest=IP）を通し
 *     3. body サイズ上限を適用する
 *   ことを、純関数レベルの検証 + route ソースのセンチネル検査で固定する。
 *
 *   外部 AI 非実行・実 DB 非接続・Supabase 非接続（identity 解決は呼ばない）。
 *
 * 使い方: npx tsx scripts/career-presentation-api-security-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  guardPresentationRequest,
  selectRateLimitTarget,
  type PresentationIdentity,
} from '@/app/api/career/presentation/requestGuard';
// 汎用部分（identity / IP / payload 上限）は機能非依存の共通基盤にある。
import {
  MAX_ARRAY_ITEMS,
  MAX_BODY_BYTES,
  MAX_DEPTH,
  MAX_NODES,
  MAX_STRING_CHARS,
  findPayloadViolation,
  resolveClientIp,
} from '@/lib/careerApi/requestGuard';
import { CAREER_PRESENTATION_RATE_LIMITS } from '@/lib/rateLimit';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// ── センチネル検査の下ごしらえ ───────────────────────────────────────
// ★ ソース全体に indexOf を掛けると import 行や関数定義そのものに当たり、
//   「呼び出し順」を測ったつもりで別物を測ってしまう。実行順を見るときは必ず
//   対象関数の本体だけを切り出す。同様に、コメント文（この QA の意図を書いた日本語）が
//   負のセンチネルに自己マッチしないよう、禁止語検査ではコメントを除去する。
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const bodyOf = (src: string, signature: string): string => {
  const at = src.indexOf(signature);
  return at < 0 ? '' : src.slice(at);
};

let fails = 0;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) fails++;
};
const section = (t: string) => console.log(`\n── ${t} ──`);

const ROUTES = [
  { name: 'theme', file: 'app/api/career/presentation/theme/route.ts', op: 'theme' as const },
  { name: 'evaluate', file: 'app/api/career/presentation/evaluate/route.ts', op: 'evaluate' as const },
  { name: 'qa', file: 'app/api/career/presentation/qa/route.ts', op: 'qa' as const },
];

// ════════════════════════════════════════════════════════════════════
section('A. 3 route が共通 guard を AI 到達前に通している');

for (const r of ROUTES) {
  const src = read(r.file);

  check(
    src.includes(`guardPresentationRequest(req, '${r.op}')`),
    `${r.name}: guardPresentationRequest を operation='${r.op}' で呼ぶ`,
  );
  check(
    /if \(!guard\.ok\) return guard\.response;/.test(src),
    `${r.name}: guard 失敗はそのまま返す（素通ししない）`,
  );

  // ★ 素の req.json() が残っていたら guard を迂回できてしまう。
  check(!src.includes('await req.json()'), `${r.name}: 生の req.json() が残っていない`);

  // guard が AI 呼び出し・context 解決より前にあること。
  //   ★ import 行に引っかからないよう POST の本体だけで順序を測る。
  const post = bodyOf(src, 'export async function POST');
  const guardAt = post.indexOf('guardPresentationRequest');
  const aiAt = post.indexOf('anthropic.messages.create');
  const ctxAt = post.indexOf('resolvePresentationContextInputs(');
  const companyAt = post.indexOf('resolvePresentationCompanyOfficial(');

  check(guardAt >= 0 && aiAt >= 0 && guardAt < aiAt, `${r.name}: guard は AI call より前にある`);
  check(guardAt >= 0 && ctxAt >= 0 && guardAt < ctxAt, `${r.name}: guard は context 解決より前にある`);
  check(
    guardAt >= 0 && companyAt >= 0 && guardAt < companyAt,
    `${r.name}: guard は Company Spine read より前にある（無認証で I/O させない）`,
  );
}

// ════════════════════════════════════════════════════════════════════
section('B. identity — client 申告値を認証に使わない');

const guardSrc = read('app/api/career/presentation/requestGuard.ts');
// identity 解決の実体は機能非依存の共通基盤にある（プレゼン adapter はそれを使うだけ）。
const sharedGuardSrc = read('lib/careerApi/requestGuard.ts');
check(
  guardSrc.includes("from '@/lib/careerApi/requestGuard'"),
  '汎用 guard は共通基盤から使う（機能ごとに再実装しない）',
);
check(
  sharedGuardSrc.includes('getCareerServerSupabaseClient'),
  'identity は Career（Project B）server client から解決する',
);
check(
  !/NEXT_PUBLIC_SUPABASE_URL|getBrowserSupabaseClient\b|lib\/supabase\/serverClient/.test(
    sharedGuardSrc,
  ),
  '受験版（Project A）の client / env を参照しない',
);
check(
  sharedGuardSrc.includes('is_anonymous'),
  '匿名ユーザーは member として扱わない',
);
// body 由来の userId を identity に使っていないこと（コメント文を除いた実コードで判定）。
const guardCode = stripComments(guardSrc);
check(
  !/\bbody\b[^\n]*\buserId\b|\bb\.userId\b/.test(guardCode),
  'request body の userId を identity に使わない',
);

// ════════════════════════════════════════════════════════════════════
section('C. rate limit — member / guest で別枠になる');

const member: PresentationIdentity = { kind: 'member', userId: 'user-abc' };
const guest: PresentationIdentity = { kind: 'guest' };

for (const r of ROUTES) {
  const m = selectRateLimitTarget(member, r.op, '203.0.113.9');
  const g = selectRateLimitTarget(guest, r.op, '203.0.113.9');

  check(m.key === 'u:user-abc', `${r.name}: member は user_id キー`);
  check(g.key === 'i:203.0.113.9', `${r.name}: guest は IP キー`);
  check(
    m.rule.namespace !== g.rule.namespace,
    `${r.name}: member と guest は別 namespace（枠を共有しない）`,
  );

  const mLimit = m.rule.windows[0].limit;
  const gLimit = g.rule.windows[0].limit;
  check(gLimit < mLimit, `${r.name}: guest の上限は member より厳しい（${gLimit} < ${mLimit}）`);
  check(g.rule.failClosed === true, `${r.name}: guest は fail-closed（store 障害中に無制限にしない）`);
  check(m.rule.failClosed !== true, `${r.name}: member は fail-open（障害でログイン中の機能を止めない）`);
}

// 最も高価な evaluate が最も厳しいこと。
check(
  CAREER_PRESENTATION_RATE_LIMITS.evaluateMember.windows[0].limit <
    CAREER_PRESENTATION_RATE_LIMITS.qaMember.windows[0].limit,
  'evaluate（最も高価）は qa より厳しい上限',
);
check(
  CAREER_PRESENTATION_RATE_LIMITS.evaluateGuest.windows[0].limit <
    CAREER_PRESENTATION_RATE_LIMITS.evaluateMember.windows[0].limit,
  'evaluate guest < evaluate member',
);

// 通常利用を壊さない下限（1 セッション = kickoff + 回答 4 回 = 5 call）。
check(
  CAREER_PRESENTATION_RATE_LIMITS.qaGuest.windows[0].limit >= 5,
  'qa guest でも 1 セッション（5 call）は完走できる',
);
check(
  CAREER_PRESENTATION_RATE_LIMITS.evaluateGuest.windows[1].limit >= 10,
  'evaluate guest は 1 時間に 10 回以上（体験が完走できる水準）',
);

// ════════════════════════════════════════════════════════════════════
section('D. client IP の解決');

const mk = (h: Record<string, string>) => new Request('https://x.test', { headers: h });
check(
  resolveClientIp(mk({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' })) === '198.51.100.7',
  'x-forwarded-for は先頭 hop を使う',
);
check(resolveClientIp(mk({ 'x-real-ip': '198.51.100.8' })) === '198.51.100.8', 'x-real-ip に fallback');
check(resolveClientIp(mk({})) === 'unknown', 'IP 不明は共有バケット unknown（個別に緩めない）');

// ════════════════════════════════════════════════════════════════════
section('E. body サイズ上限 — 無制限 payload を prompt へ通さない');

check(findPayloadViolation({ theme: 'ふつうのお題', transcript: 'ふつうの発表' }) === null, '通常 body は通る');

check(
  findPayloadViolation({ transcript: 'あ'.repeat(MAX_STRING_CHARS + 1) }) === 'string_chars',
  '巨大 transcript を拒否',
);
check(
  findPayloadViolation({ config: { focusPoint: 'x'.repeat(MAX_STRING_CHARS + 1) } }) === 'string_chars',
  '巨大 focusPoint を拒否',
);
check(
  findPayloadViolation({ activity: { items: new Array(MAX_ARRAY_ITEMS + 1).fill({ t: 'a' }) } }) ===
    'array_items',
  '巨大 activity 配列を拒否',
);
check(
  findPayloadViolation({ turns: new Array(MAX_ARRAY_ITEMS + 1).fill({ role: 'answer', content: 'a' }) }) ===
    'array_items',
  '巨大 Q&A turns を拒否',
);

// 深いネスト。
let deep: unknown = 'x';
for (let i = 0; i < MAX_DEPTH + 3; i++) deep = { n: deep };
check(findPayloadViolation(deep) === 'depth', '深すぎるネストを拒否');

// ノード総数（幅×深さ）。
const wide = { a: new Array(400).fill(null).map(() => ({ b: new Array(400).fill('x') })) };
check(findPayloadViolation(wide) !== null, '幅×深さの組合せ爆発を拒否');

check(MAX_BODY_BYTES <= 512 * 1024, `body 全体の上限が有限（${MAX_BODY_BYTES} bytes）`);
check(MAX_NODES <= 100_000, `ノード総数の上限が有限（${MAX_NODES}）`);

// ★ 黙って縮めない（truncate して意味を変える設計になっていない）。
//   コメントに「truncate しない」と書いてあるため、判定は実コードのみで行う。
check(
  !/\.slice\(|\.substring\(|\.substr\(/.test(guardCode),
  'guard は payload を黙って truncate しない（拒否する）',
);

// ════════════════════════════════════════════════════════════════════
section('F. guard の判定順序（安い判定が先・AI/DB より前）');

// ★ 関数定義や import に当たらないよう guardPresentationRequest の本体だけで測る。
//   サイズ上限（content-length → 実測バイト）は共通基盤の readRawBodyWithinCap が担うため、
//   adapter 側では「その呼び出しが最初にある」ことを測る。
const guardFn = bodyOf(guardSrc, 'export async function guardPresentationRequest');
const order = [
  'readRawBodyWithinCap(',
  'resolvePresentationIdentity(',
  'checkRateLimits(',
  'JSON.parse(',
];
const positions = order.map((k) => guardFn.indexOf(k));
check(
  positions.every((p) => p >= 0),
  `guard に 4 段すべてが存在する（${order.join(' → ')}）`,
);
check(
  positions.every((p, i) => i === 0 || positions[i - 1] < p),
  'サイズ上限 → identity → rate limit → parse の順である',
);
// 共通基盤側でも「宣言値 → 実測バイト数」の二段が保たれていること。
const sharedReadFn = bodyOf(sharedGuardSrc, 'export async function readRawBodyWithinCap');
const sharedOrder = ['content-length', 'req.text()', 'Buffer.byteLength('];
const sharedPositions = sharedOrder.map((k) => sharedReadFn.indexOf(k));
check(
  sharedPositions.every((p) => p >= 0) &&
    sharedPositions.every((p, i) => i === 0 || sharedPositions[i - 1] < p),
  '共通基盤の body 読み出しは Content-Length → 実測バイト数の二段',
);

// ════════════════════════════════════════════════════════════════════
section('G. 既存の timeout / retry 契約を壊していない');

const evaluateSrc = read('app/api/career/presentation/evaluate/route.ts');
const qaSrc = read('app/api/career/presentation/qa/route.ts');
const themeSrc = read('app/api/career/presentation/theme/route.ts');

check(evaluateSrc.includes('TOTAL_BUDGET_MS = 74_000'), 'evaluate: 合計 AI 予算 74s が維持されている');
check(evaluateSrc.includes('PER_CALL_TIMEOUT_MS = 60_000'), 'evaluate: per-call 60s が維持されている');
check(evaluateSrc.includes('attempt <= 2'), 'evaluate: retry 2 attempt が維持されている');
check(evaluateSrc.includes('MAX_TRANSCRIPT_CHARS = 20000'), 'evaluate: transcript 20,000 字 cap が維持されている');
check(qaSrc.includes('AI_BUDGET_PRESET_80S_WALL'), 'qa: AI 予算 preset が維持されている');
check(qaSrc.includes('MAX_ANSWER_CHARS = 8000'), 'qa: 回答 8,000 字 cap が維持されている');
check(themeSrc.includes('createTimeoutSignal()'), 'theme: timeout signal が維持されている');
for (const r of ROUTES) {
  check(read(r.file).includes('export const maxDuration = 80'), `${r.name}: maxDuration=80 が維持されている`);
}

// ════════════════════════════════════════════════════════════════════
section('H. Company Data Spine を今回変更していない（scope guard）');

for (const r of ROUTES) {
  const src = read(r.file);
  check(
    src.includes('resolvePresentationCompanyOfficial'),
    `${r.name}: Company Spine 解決は従来どおり残っている`,
  );
}
check(
  !/CAREER_COMPANY_PREFETCH_ENABLED|IDENTITY_UI_ENABLED/.test(guardSrc),
  'guard は Company Data Spine の flag に触れない',
);

// ════════════════════════════════════════════════════════════════════
// I. guard を実際に動かす（センチネルだけに頼らない）
//
// ★ resolvePresentationIdentity は request scope の外では cookie を読めないが、
//   guard は never-throw で guest に倒すため、この環境でも guest 経路を実測できる。
//   rate limit store は env 未設定なら in-memory fallback なので DB も不要。
// ════════════════════════════════════════════════════════════════════
async function runtimeChecks(): Promise<void> {
  section('I. guard の実挙動（guest 経路を実測）');

  const mk = (body: string, ip: string) =>
    new Request('https://qa.test/api/career/presentation/theme', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body,
    });

  const normal = await guardPresentationRequest(mk(JSON.stringify({ theme: 'お題' }), '198.51.100.1'), 'theme');
  check(normal.ok, '通常 request は通る');
  check(normal.ok && normal.identity.kind === 'guest', '未ログインは guest として解決される（401 にしない）');

  const oversized = await guardPresentationRequest(
    mk(JSON.stringify({ blob: 'あ'.repeat(MAX_BODY_BYTES) }), '198.51.100.2'),
    'theme',
  );
  check(!oversized.ok && oversized.response.status === 413, 'body 全体が上限超過 → 413');

  const longString = await guardPresentationRequest(
    mk(JSON.stringify({ transcript: 'a'.repeat(MAX_STRING_CHARS + 1000) }), '198.51.100.3'),
    'theme',
  );
  check(!longString.ok && longString.response.status === 413, '単一フィールドが上限超過 → 413');

  const badJson = await guardPresentationRequest(mk('{not json', '198.51.100.4'), 'theme');
  check(!badJson.ok && badJson.response.status === 400, '壊れた JSON → 400');

  // guest evaluate は 3/分。4 回目以降は 429 になる。
  const limit = CAREER_PRESENTATION_RATE_LIMITS.evaluateGuest.windows[0].limit;
  const seen: Array<number | 'pass'> = [];
  for (let i = 0; i < limit + 2; i++) {
    const r = await guardPresentationRequest(mk(JSON.stringify({ i }), '203.0.113.77'), 'evaluate');
    seen.push(r.ok ? 'pass' : r.response.status);
  }
  check(
    seen.slice(0, limit).every((v) => v === 'pass'),
    `guest evaluate: 上限内（${limit} 回）は通る`,
  );
  check(
    seen.slice(limit).every((v) => v === 429),
    'guest evaluate: 上限超過は 429',
  );

  // 429 の contract（Retry-After / 安定 JSON / key を漏らさない）。
  const blocked = await guardPresentationRequest(mk('{}', '203.0.113.77'), 'evaluate');
  if (!blocked.ok) {
    const res = blocked.response;
    check(res.headers.get('Retry-After') !== null, '429 は Retry-After header を返す');
    check(res.headers.get('X-RateLimit-Limit') !== null, '429 は X-RateLimit-Limit を返す');
    const text = await res.clone().text();
    check(JSON.parse(text).error === 'RATE_LIMITED', '429 の body は安定 JSON（error=RATE_LIMITED）');
    check(!/203\.0\.113\.77|user-abc/.test(text), '429 の body に IP / user_id を含めない');
  } else {
    check(false, '429 contract を検証できた');
  }

  // 別 IP は別枠（1 人の濫用が他ユーザーを巻き込まない）。
  const otherIp = await guardPresentationRequest(mk('{}', '203.0.113.99'), 'evaluate');
  check(otherIp.ok, '別 IP は別枠（巻き込み 429 にならない）');

  // operation ごとに枠が独立（evaluate を使い切っても theme は通る）。
  const otherOp = await guardPresentationRequest(mk('{}', '203.0.113.77'), 'theme');
  check(otherOp.ok, 'operation ごとに枠が独立している');

  console.log(`\n${fails === 0 ? '✅ PASS' : `❌ FAIL (${fails})`}`);
  process.exit(fails === 0 ? 0 : 1);
}

void runtimeChecks();
