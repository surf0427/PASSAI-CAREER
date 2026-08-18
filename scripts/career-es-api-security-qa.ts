/*
 * scripts/career-es-api-security-qa.ts
 *
 * PASSAI CAREER — ES AI route の security 契約 QA（dev-only 常設・決定的）。
 *
 * 対象:
 *   POST /api/career/es/materials
 *   POST /api/career/es/deep
 *   POST /api/career/es/organize
 *   POST /api/career/es-review
 *
 * 目的（ES Production Readiness Audit P0 の回帰ガード）:
 *   4 route が AI へ到達する前に
 *     1. Career（Project B）server identity を確定し
 *     2. rate limit（member=user_id / guest=IP）を通し
 *     3. raw body サイズ上限を適用し
 *     4. ES 固有の構造サイズ上限（設問 / 本文 / 会話 / 候補 / 既知事実）を適用する
 *   ことを、純関数レベルの検証 + route ソースのセンチネル検査 + guard の実挙動で固定する。
 *
 *   ★ とくに es-review の `answer` は監査時点で **完全に無制限**だった。
 *     その回帰を許さないことが本 QA の中心的な役割である。
 *
 *   外部 AI 非実行・実 DB 非接続（identity 解決は never-throw で guest に倒れる）。
 *
 * 使い方: npx tsx scripts/career-es-api-security-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  guardEsRequest,
  findEsPayloadViolation,
  selectEsRateLimitTarget,
  MAX_ES_ANSWER_CHARS,
  MAX_ES_CANDIDATES,
  MAX_ES_KNOWN_FACTS,
  MAX_ES_META_CHARS,
  MAX_ES_QUESTION_CHARS,
  MAX_ES_TURN_CONTENT_CHARS,
  MAX_ES_TURN_ENTRIES,
  MAX_ES_TURNS_TOTAL_CHARS,
  type EsIdentity,
  type EsOperation,
} from '@/app/api/career/es/requestGuard';
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
import { CAREER_ES_RATE_LIMITS } from '@/lib/rateLimit';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

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

const ROUTES: Array<{ name: string; file: string; op: EsOperation }> = [
  { name: 'materials', file: 'app/api/career/es/materials/route.ts', op: 'materials' },
  { name: 'deep', file: 'app/api/career/es/deep/route.ts', op: 'deep' },
  { name: 'organize', file: 'app/api/career/es/organize/route.ts', op: 'organize' },
  { name: 'review', file: 'app/api/career/es-review/route.ts', op: 'review' },
];

// ════════════════════════════════════════════════════════════════════
section('A. 4 route が共通 guard を AI 到達前に通している');

for (const r of ROUTES) {
  const src = read(r.file);

  check(
    src.includes(`guardEsRequest(req, '${r.op}')`),
    `${r.name}: guardEsRequest を operation='${r.op}' で呼ぶ`,
  );
  check(
    /if \(!guard\.ok\) return guard\.response;/.test(src),
    `${r.name}: guard 失敗はそのまま返す（素通ししない）`,
  );

  // ★ 素の req.json() が残っていたら guard を迂回できてしまう。
  check(!src.includes('await req.json()'), `${r.name}: 生の req.json() が残っていない`);

  // guard が AI 呼び出しより前にあること（import 行に当たらないよう POST 本体だけで測る）。
  const post = bodyOf(src, 'export async function POST');
  const guardAt = post.indexOf('guardEsRequest');
  const aiAt = post.indexOf('anthropic.messages.create');
  check(guardAt >= 0 && aiAt >= 0 && guardAt < aiAt, `${r.name}: guard は AI call より前にある`);
}

// Data Spine / Company Spine の I/O よりも前に guard があること（無認証で I/O させない）。
{
  const deepPost = bodyOf(read('app/api/career/es/deep/route.ts'), 'export async function POST');
  check(
    deepPost.indexOf('guardEsRequest') < deepPost.indexOf('resolveEsFallbackContextBlock('),
    'deep: guard は User Data Spine read より前にある',
  );
  check(
    deepPost.indexOf('guardEsRequest') < deepPost.indexOf('resolveEsDeepCompanyOfficialBlock('),
    'deep: guard は Company Spine read より前にある',
  );
  check(
    deepPost.indexOf('guardEsRequest') < deepPost.indexOf('triggerCompanyPrefetch('),
    'deep: guard は prefetch trigger より前にある（無認証で外部 I/O を起動させない）',
  );

  const reviewPost = bodyOf(read('app/api/career/es-review/route.ts'), 'export async function POST');
  check(
    reviewPost.indexOf('guardEsRequest') < reviewPost.indexOf('resolveEsReviewContextInputs('),
    'review: guard は User Data Spine read より前にある',
  );
  check(
    reviewPost.indexOf('guardEsRequest') < reviewPost.indexOf('resolveEsReviewCompanyOfficial('),
    'review: guard は Company Spine read より前にある',
  );
  check(
    reviewPost.indexOf('guardEsRequest') < reviewPost.indexOf('triggerCompanyPrefetch('),
    'review: guard は prefetch trigger より前にある（無認証で外部 I/O を起動させない）',
  );

  const organizePost = bodyOf(read('app/api/career/es/organize/route.ts'), 'export async function POST');
  check(
    organizePost.indexOf('guardEsRequest') < organizePost.indexOf('resolveEsFallbackContextBlock('),
    'organize: guard は User Data Spine read より前にある',
  );
}

// ════════════════════════════════════════════════════════════════════
section('B. identity — client 申告値を認証に使わない');

const guardSrc = read('app/api/career/es/requestGuard.ts');
const sharedGuardSrc = read('lib/careerApi/requestGuard.ts');
const guardCode = stripComments(guardSrc);

check(
  guardSrc.includes("from '@/lib/careerApi/requestGuard'"),
  '汎用 guard は共通基盤から使う（機能ごとに再実装しない）',
);
check(
  !/getCareerServerSupabaseClient|createHash|x-forwarded-for/.test(guardCode),
  'ES adapter は identity / IP / hash を再実装していない（共通基盤へ委譲）',
);
check(
  sharedGuardSrc.includes('getCareerServerSupabaseClient'),
  'identity は Career（Project B）server client から解決する',
);
check(
  sharedGuardSrc.includes('is_anonymous'),
  '匿名ユーザーは member として扱わない',
);
check(
  !/\bbody\b[^\n]*\buserId\b|\bb\.userId\b/.test(guardCode),
  'request body の userId を identity に使わない',
);
// ES の 4 route はそもそも userId を受け取らない（IDOR 面をゼロに保つ）。
for (const r of ROUTES) {
  check(
    !/\buserId\b/.test(stripComments(read(r.file))),
    `${r.name}: route は body から userId を受け取らない`,
  );
}

// ════════════════════════════════════════════════════════════════════
section('C. guest ES 利用を閉じない（401 にしない）');

check(!/401/.test(guardCode), 'guard は 401 を返さない（guest ES 利用は正式に許可されている）');
for (const r of ROUTES) {
  check(
    !/401|Unauthorized/.test(stripComments(read(r.file))),
    `${r.name}: route も 401 を返さない`,
  );
}

// ════════════════════════════════════════════════════════════════════
section('D. rate limit — member / guest で別枠になる');

const member: EsIdentity = { kind: 'member', userId: 'user-abc' };
const guest: EsIdentity = { kind: 'guest' };

for (const r of ROUTES) {
  const m = selectEsRateLimitTarget(member, r.op, '203.0.113.9');
  const g = selectEsRateLimitTarget(guest, r.op, '203.0.113.9');

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

// operation ごとに namespace が完全に独立していること。
{
  const namespaces = ROUTES.flatMap((r) => [
    selectEsRateLimitTarget(member, r.op, 'x').rule.namespace,
    selectEsRateLimitTarget(guest, r.op, 'x').rule.namespace,
  ]);
  check(new Set(namespaces).size === namespaces.length, '8 系統すべて別 namespace（枠の混線なし）');
}

// ★ deep は 1 ES で seed 1 + followup 最大 6 = 最大 7 call。review と同じ上限をコピーすると
//   正常な深掘りが途中で 429 になる。ここが本 QA の最重要 assert のひとつ。
check(
  CAREER_ES_RATE_LIMITS.deepMember.windows[0].limit >
    CAREER_ES_RATE_LIMITS.reviewMember.windows[0].limit,
  'deep（1 ES で最大 7 call）は review より緩い上限を持つ',
);
check(
  CAREER_ES_RATE_LIMITS.deepMember.windows[0].limit >= 7,
  `deep member: ES 1 本ぶん（7 call）を 1 分で完走できる（${CAREER_ES_RATE_LIMITS.deepMember.windows[0].limit}/分）`,
);
check(
  CAREER_ES_RATE_LIMITS.deepGuest.windows[0].limit >= 7,
  `deep guest: ES 1 本ぶん（7 call）を 1 分で完走できる（${CAREER_ES_RATE_LIMITS.deepGuest.windows[0].limit}/分）`,
);
check(
  CAREER_ES_RATE_LIMITS.deepGuest.windows[1].limit >= 7,
  'deep guest: 1 時間に最低 1 本は深掘りを完走できる',
);
// review は最も高価（max_tokens 3000）。materials（max_tokens 900）より緩めない。
check(
  CAREER_ES_RATE_LIMITS.reviewMember.windows[0].limit <=
    CAREER_ES_RATE_LIMITS.materialsMember.windows[0].limit,
  'review（最も高価）は materials より緩くない',
);
// 「もう一度添削 → 改善版 → 再添削」の UX ループが 1 時間で回る水準。
check(
  CAREER_ES_RATE_LIMITS.reviewGuest.windows[1].limit >= 10,
  'review guest は 1 時間に 10 回以上（改善ループが回る水準）',
);
check(
  CAREER_ES_RATE_LIMITS.materialsGuest.windows[0].limit >= 2,
  'materials guest は再検索できる余地がある',
);
// 全 window が有限であること（無制限 namespace を作らない）。
for (const [name, rule] of Object.entries(CAREER_ES_RATE_LIMITS)) {
  check(
    rule.windows.length > 0 && rule.windows.every((w) => w.limit > 0 && w.windowSeconds > 0),
    `${name}: window がすべて有限で正の値`,
  );
}

// ════════════════════════════════════════════════════════════════════
section('E. client IP の解決');

const mkReq = (h: Record<string, string>) => new Request('https://x.test', { headers: h });
check(
  resolveClientIp(mkReq({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' })) === '198.51.100.7',
  'x-forwarded-for は先頭 hop を使う',
);
check(resolveClientIp(mkReq({ 'x-real-ip': '198.51.100.8' })) === '198.51.100.8', 'x-real-ip に fallback');
check(resolveClientIp(mkReq({})) === 'unknown', 'IP 不明は共有バケット unknown（個別に緩めない）');

// ════════════════════════════════════════════════════════════════════
section('F. 汎用 payload 上限 — 無制限 payload を prompt へ通さない');

check(findPayloadViolation({ question: '設問', answer: '本文' }) === null, '通常 body は通る');
check(
  findPayloadViolation({ answer: 'あ'.repeat(MAX_STRING_CHARS + 1) }) === 'string_chars',
  '巨大 answer を拒否（汎用層）',
);
check(
  findPayloadViolation({ turns: new Array(MAX_ARRAY_ITEMS + 1).fill({ role: 'answer', content: 'a' }) }) ===
    'array_items',
  '巨大 turns 配列を拒否（汎用層）',
);
check(
  findPayloadViolation({ candidates: new Array(MAX_ARRAY_ITEMS + 1).fill({ id: 'a', label: 'b' }) }) ===
    'array_items',
  '巨大 candidates 配列を拒否（汎用層）',
);

let deep: unknown = 'x';
for (let i = 0; i < MAX_DEPTH + 3; i++) deep = { n: deep };
check(findPayloadViolation(deep) === 'depth', '深すぎるネストを拒否');

const wide = { a: new Array(400).fill(null).map(() => ({ b: new Array(400).fill('x') })) };
check(findPayloadViolation(wide) !== null, '幅×深さの組合せ爆発を拒否');

check(MAX_BODY_BYTES <= 512 * 1024, `body 全体の上限が有限（${MAX_BODY_BYTES} bytes）`);
check(MAX_NODES <= 100_000, `ノード総数の上限が有限（${MAX_NODES}）`);

// ★ 黙って縮めない（truncate して意味を変える設計になっていない）。
check(
  !/\.slice\(|\.substring\(|\.substr\(/.test(guardCode),
  'guard は payload を黙って truncate しない（拒否する）',
);

// ════════════════════════════════════════════════════════════════════
section('G. ES 固有の入力上限（監査 P0 の中核）');

// ── 設問（全 operation 共通）──
for (const r of ROUTES) {
  check(
    findEsPayloadViolation({ question: 'あ'.repeat(MAX_ES_QUESTION_CHARS + 1) }, r.op) === 'question_chars',
    `${r.name}: 巨大な設問文を拒否`,
  );
  check(
    findEsPayloadViolation({ question: 'あ'.repeat(MAX_ES_QUESTION_CHARS) }, r.op) === null,
    `${r.name}: 上限ちょうどの設問文は通る（境界で正常系を切らない）`,
  );
}

// ── review: answer が無制限だった経路 ──
check(
  findEsPayloadViolation({ answer: 'あ'.repeat(MAX_ES_ANSWER_CHARS + 1) }, 'review') === 'answer_chars',
  '★ review: 巨大な ES 本文を拒否（監査時点では完全に無制限だった）',
);
check(
  findEsPayloadViolation({ answer: 'あ'.repeat(MAX_ES_ANSWER_CHARS) }, 'review') === null,
  'review: 上限ちょうどの本文は通る',
);
check(
  MAX_ES_ANSWER_CHARS === 8_000,
  'review の本文上限は deep の既存 MAX_ANSWER_CHARS(8,000) と同値',
);
// 実際の ES（200〜1,000 字）に対して十分な余裕があること。
check(MAX_ES_ANSWER_CHARS >= 4_000, '本文上限は現実の ES（最大 1,000 字程度）の 4 倍以上');

// ── review: 応募メタ ──
for (const field of ['companyName', 'industry', 'jobType']) {
  check(
    findEsPayloadViolation({ [field]: 'あ'.repeat(MAX_ES_META_CHARS + 1) }, 'review') === 'meta_chars',
    `review: 巨大な ${field} を拒否`,
  );
}
check(
  findEsPayloadViolation(
    { answer: '本文', question: '設問', companyName: 'トヨタ自動車', industry: '自動車', jobType: '営業' },
    'review',
  ) === null,
  'review: 現実的な ES 添削 request は通る',
);

// ── deep: 回答 / 会話 / 既知事実 ──
check(
  findEsPayloadViolation({ answer: 'あ'.repeat(MAX_ES_ANSWER_CHARS + 1) }, 'deep') === 'answer_chars',
  'deep: 巨大な回答を拒否',
);
check(
  findEsPayloadViolation({ companyName: 'あ'.repeat(MAX_ES_META_CHARS + 1) }, 'deep') === 'meta_chars',
  'deep: 巨大な企業名を拒否',
);
check(
  findEsPayloadViolation(
    { turns: new Array(MAX_ES_TURN_ENTRIES + 1).fill({ role: 'answer', content: 'a' }) },
    'deep',
  ) === 'turns_count',
  'deep: turns 件数超過を拒否',
);
check(
  findEsPayloadViolation(
    { turns: [{ role: 'answer', content: 'あ'.repeat(MAX_ES_TURN_CONTENT_CHARS + 1) }] },
    'deep',
  ) === 'turn_content_chars',
  'deep: turn 1 件の巨大 content を拒否',
);
check(
  findEsPayloadViolation(
    {
      turns: new Array(20).fill({ role: 'answer', content: 'あ'.repeat(MAX_ES_TURN_CONTENT_CHARS) }),
    },
    'deep',
  ) === 'turns_total_chars',
  'deep: turns 合計文字数の超過を拒否（1 件ずつは合法でも合計で膨らむ経路）',
);
check(
  findEsPayloadViolation({ knownFacts: new Array(MAX_ES_KNOWN_FACTS + 1).fill('x') }, 'deep') === 'known_facts',
  'deep: knownFacts 件数超過を拒否',
);
check(
  findEsPayloadViolation({ knownFacts: ['あ'.repeat(3_000)] }, 'deep') === 'known_facts',
  'deep: knownFacts 1 行の超過を拒否',
);
check(
  findEsPayloadViolation({ missingAxes: new Array(500).fill('k') }, 'deep') === 'missing_axes',
  'deep: missingAxes 件数超過を拒否',
);

// 正常系の深掘り（ガクチカ = 最大 7 問 = turns 15 件前後）は絶対に通ること。
check(
  findEsPayloadViolation(
    {
      question: '学生時代に最も力を入れたことを教えてください。',
      questionType: 'gakuchika',
      answer: 'あ'.repeat(1_200),
      turns: new Array(15).fill(null).map((_, i) => ({
        role: i % 2 === 0 ? 'question' : 'answer',
        content: 'あ'.repeat(600),
      })),
      knownFacts: new Array(40).fill('あ'.repeat(160)),
      missingAxes: ['difficulty', 'result'],
      companyName: 'トヨタ自動車',
    },
    'deep',
  ) === null,
  '★ deep: 正常系の最大構成（7 問 / knownFacts 40 行）は通る（正常な深掘りを止めない）',
);

// ── organize ──
check(
  findEsPayloadViolation(
    { turns: new Array(MAX_ES_TURN_ENTRIES + 1).fill({ role: 'answer', content: 'a' }) },
    'organize',
  ) === 'turns_count',
  'organize: turns 件数超過を拒否',
);
check(
  findEsPayloadViolation({ knownFacts: new Array(MAX_ES_KNOWN_FACTS + 1).fill('x') }, 'organize') ===
    'known_facts',
  'organize: knownFacts 件数超過を拒否',
);
check(
  findEsPayloadViolation(
    { question: '設問', turns: new Array(15).fill({ role: 'answer', content: 'あ'.repeat(600) }) },
    'organize',
  ) === null,
  'organize: 正常系の整理 request は通る',
);

// ── materials ──
check(
  findEsPayloadViolation(
    { candidates: new Array(MAX_ES_CANDIDATES + 1).fill({ id: 'a', label: 'b' }) },
    'materials',
  ) === 'candidates',
  'materials: 候補件数超過を拒否（client 側 24 件契約を server でも固定）',
);
check(
  findEsPayloadViolation({ candidates: [{ id: 'a', label: 'あ'.repeat(3_000) }] }, 'materials') === 'candidates',
  'materials: 巨大な候補 label を拒否',
);
check(
  findEsPayloadViolation({ candidates: [{ id: 'あ'.repeat(3_000), label: 'b' }] }, 'materials') === 'candidates',
  'materials: 巨大な候補 id を拒否',
);
check(
  findEsPayloadViolation(
    { question: '設問', candidates: new Array(24).fill(null).map((_, i) => ({ id: `c${i}`, label: 'ラベル' })) },
    'materials',
  ) === null,
  'materials: 正常系（24 件）は通る',
);

// ★ 上限は各 route の既存 normalizer の truncate 値より必ず大きいこと
//   （＝ 正規の client では発火せず、異常な request だけを弾く）。
check(MAX_ES_KNOWN_FACTS > 40, 'knownFacts 上限 > route の truncate 値(40)');
check(MAX_ES_CANDIDATES > 24, 'candidates 上限 > route の truncate 値(24)');
check(MAX_ES_TURN_ENTRIES > 15, 'turns 上限 > ES 正常系の最大件数(15)');
check(MAX_ES_TURNS_TOTAL_CHARS >= 60_000, 'turns 合計上限が正常系（15×8,000 未満）を覆う');

// 型が違う値は guard の担当外（各 route の normalizer が捨てる）＝ ここで誤検出しない。
check(findEsPayloadViolation({ question: 12345 }, 'deep') === null, '非文字列の設問は guard の担当外');
check(findEsPayloadViolation({ turns: 'not-an-array' }, 'deep') === null, '非配列 turns は guard の担当外');
check(findEsPayloadViolation(null, 'deep') === null, 'null body でも throw しない');
check(findEsPayloadViolation({}, 'review') === null, '空 body でも throw しない');

// ════════════════════════════════════════════════════════════════════
section('H. guard の判定順序（安い判定が先・AI/DB より前）');

const guardFn = bodyOf(guardSrc, 'export async function guardEsRequest');
const order = [
  'readRawBodyWithinCap(',
  'resolveEsIdentity(',
  'checkRateLimits(',
  'JSON.parse(',
  'findEsPayloadViolation(',
];
const positions = order.map((k) => guardFn.indexOf(k));
check(positions.every((p) => p >= 0), `guard に 5 段すべてが存在する（${order.join(' → ')}）`);
check(
  positions.every((p, i) => i === 0 || positions[i - 1] < p),
  'サイズ上限 → identity → rate limit → parse → ES 固有上限 の順である',
);
const sharedReadFn = bodyOf(sharedGuardSrc, 'export async function readRawBodyWithinCap');
const sharedOrder = ['content-length', 'req.text()', 'Buffer.byteLength('];
const sharedPositions = sharedOrder.map((k) => sharedReadFn.indexOf(k));
check(
  sharedPositions.every((p) => p >= 0) &&
    sharedPositions.every((p, i) => i === 0 || sharedPositions[i - 1] < p),
  '共通基盤の body 読み出しは Content-Length → 実測バイト数の二段',
);

// ════════════════════════════════════════════════════════════════════
section('I. 既存の timeout / retry / 文字数契約を壊していない');

const deepSrc = read('app/api/career/es/deep/route.ts');
const organizeSrc = read('app/api/career/es/organize/route.ts');
const materialsSrc = read('app/api/career/es/materials/route.ts');
const reviewSrc = read('app/api/career/es-review/route.ts');

check(deepSrc.includes('MAX_ANSWER_CHARS = 8000'), 'deep: 既存の回答 8,000 字 cap が維持されている');
check(deepSrc.includes('QUESTION_AI_TOTAL_BUDGET_MS = 45_000'), 'deep: 合計 AI 予算 45s が維持されている');
check(organizeSrc.includes('AI_BUDGET_PRESET_80S_WALL'), 'organize: AI 予算 preset が維持されている');
check(materialsSrc.includes('MATERIALS_AI_TOTAL_BUDGET_MS = 45_000'), 'materials: 合計 AI 予算 45s が維持されている');
check(reviewSrc.includes('AI_BUDGET_PRESET_80S_WALL'), 'review: AI 予算 preset が維持されている');
check(reviewSrc.includes('attempt <= 2'), 'review: retry 2 attempt が維持されている');
check(reviewSrc.includes('MAX_TOKENS = 3000'), 'review: max_tokens 3000 が維持されている');
for (const r of ROUTES) {
  check(read(r.file).includes('export const maxDuration = 80'), `${r.name}: maxDuration=80 が維持されている`);
}

// ════════════════════════════════════════════════════════════════════
section('J. User Data Spine / Company Spine / ai_policy の非退行');

check(deepSrc.includes('resolveEsFallbackContextBlock('), 'deep: User Data Spine 接続が残っている');
check(organizeSrc.includes('resolveEsFallbackContextBlock('), 'organize: User Data Spine 接続が残っている');
check(reviewSrc.includes('resolveEsReviewContextInputs('), 'review: User Data Spine 接続が残っている');
check(reviewSrc.includes('resolveEsReviewCompanyOfficial('), 'review: Company Spine 接続が残っている');
check(deepSrc.includes('resolveEsDeepCompanyOfficialBlock('), 'deep: Company Spine 接続が残っている');
// materials は設計上 CONTEXT_FREE（本人材料の関連度判定のみ）。
check(
  !/resolveEsFallbackContextBlock|resolveEs.*CompanyOfficial/.test(materialsSrc),
  'materials: CONTEXT_FREE 契約を維持（Spine を足していない）',
);
check(
  !/resolveEs.*CompanyOfficial/.test(organizeSrc),
  'organize: 企業情報を載せない設計を維持',
);
// guard は Company Identity の flag に触れない（勝手に ON にしない）。
check(
  !/CAREER_COMPANY_PREFETCH_ENABLED|CAREER_COMPANY_IDENTITY_ENABLED|IDENTITY_UI_ENABLED/.test(guardSrc),
  'guard は Company Data Spine / Identity の flag に触れない',
);

// ════════════════════════════════════════════════════════════════════
// K. guard を実際に動かす（センチネルだけに頼らない）
//
// ★ resolveEsIdentity は request scope の外では cookie を読めないが、
//   guard は never-throw で guest に倒れるため、この環境でも guest 経路を実測できる。
//   rate limit store は env 未設定なら in-memory fallback なので DB も不要。
// ════════════════════════════════════════════════════════════════════
async function runtimeChecks(): Promise<void> {
  section('K. guard の実挙動（guest 経路を実測）');

  const mk = (body: string, ip: string) =>
    new Request('https://qa.test/api/career/es/deep', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body,
    });

  const normal = await guardEsRequest(mk(JSON.stringify({ question: '設問' }), '198.51.100.1'), 'deep');
  check(normal.ok, '通常 request は通る');
  check(normal.ok && normal.identity.kind === 'guest', '未ログインは guest として解決される（401 にしない）');

  const oversized = await guardEsRequest(
    mk(JSON.stringify({ blob: 'あ'.repeat(MAX_BODY_BYTES) }), '198.51.100.2'),
    'deep',
  );
  check(!oversized.ok && oversized.response.status === 413, 'body 全体が上限超過 → 413');

  const longString = await guardEsRequest(
    mk(JSON.stringify({ answer: 'a'.repeat(MAX_STRING_CHARS + 1000) }), '198.51.100.3'),
    'deep',
  );
  check(!longString.ok && longString.response.status === 413, '単一フィールドが汎用上限超過 → 413');

  // ★ ES 固有上限（汎用上限は下回るが ES としては過大）も 413 で止まること。
  const longAnswer = await guardEsRequest(
    mk(JSON.stringify({ answer: 'あ'.repeat(MAX_ES_ANSWER_CHARS + 1) }), '198.51.100.5'),
    'review',
  );
  check(
    !longAnswer.ok && longAnswer.response.status === 413,
    '★ ES 本文が ES 固有上限を超過 → 413（汎用 40,000 字上限より手前で止まる）',
  );

  const bigTurns = await guardEsRequest(
    mk(
      JSON.stringify({ turns: new Array(MAX_ES_TURN_ENTRIES + 1).fill({ role: 'answer', content: 'a' }) }),
      '198.51.100.6',
    ),
    'organize',
  );
  check(!bigTurns.ok && bigTurns.response.status === 413, 'turns 件数超過 → 413');

  const bigCandidates = await guardEsRequest(
    mk(
      JSON.stringify({ candidates: new Array(MAX_ES_CANDIDATES + 1).fill({ id: 'a', label: 'b' }) }),
      '198.51.100.7',
    ),
    'materials',
  );
  check(!bigCandidates.ok && bigCandidates.response.status === 413, '候補件数超過 → 413');

  // ── エラー契約: すべて JSON で、client が読む detail を持つ ──
  for (const rejected of [oversized, longAnswer, bigTurns, bigCandidates]) {
    if (rejected.ok) continue;
    const res = rejected.response.clone();
    check(
      (res.headers.get('content-type') ?? '').includes('application/json'),
      '413 は JSON を返す（HTML / plain text に退行しない）',
    );
    const parsed = JSON.parse(await res.text()) as { detail?: unknown };
    check(
      typeof parsed.detail === 'string' && parsed.detail.length > 0,
      '413 の body に client が表示できる日本語 detail がある',
    );
  }

  // ── 壊れた JSON: route ごとの既存 400 契約を維持する ──
  const badReview = await guardEsRequest(mk('{not json', '198.51.100.8'), 'review');
  check(!badReview.ok && badReview.response.status === 400, '壊れた JSON → 400（review）');
  if (!badReview.ok) {
    const parsed = JSON.parse(await badReview.response.clone().text()) as { error?: unknown };
    check(
      parsed.error === 'リクエストボディが不正です。',
      'review: 既存の 400 レスポンス形（error のみ）を維持',
    );
  }
  for (const op of ['deep', 'organize', 'materials'] as const) {
    const bad = await guardEsRequest(mk('{not json', '198.51.100.9'), op);
    check(!bad.ok && bad.response.status === 400, `壊れた JSON → 400（${op}）`);
    if (!bad.ok) {
      const parsed = JSON.parse(await bad.response.clone().text()) as {
        error?: unknown;
        code?: unknown;
        detail?: unknown;
      };
      check(
        parsed.error === 'BAD_REQUEST' && parsed.code === 'BAD_REQUEST' && typeof parsed.detail === 'string',
        `${op}: 既存の 400 レスポンス形（error/code/detail）を維持`,
      );
    }
  }

  // ── rate limit: 上限を超えたら 429（AI へは到達しない）──
  const limit = CAREER_ES_RATE_LIMITS.organizeGuest.windows[0].limit;
  const seen: Array<number | 'pass'> = [];
  for (let i = 0; i < limit + 2; i++) {
    const r = await guardEsRequest(mk(JSON.stringify({ i }), '203.0.113.77'), 'organize');
    seen.push(r.ok ? 'pass' : r.response.status);
  }
  check(seen.slice(0, limit).every((v) => v === 'pass'), `guest organize: 上限内（${limit} 回）は通る`);
  check(seen.slice(limit).every((v) => v === 429), 'guest organize: 上限超過は 429');

  const blocked = await guardEsRequest(mk('{}', '203.0.113.77'), 'organize');
  if (!blocked.ok) {
    const res = blocked.response;
    check(res.headers.get('Retry-After') !== null, '429 は Retry-After header を返す');
    check(res.headers.get('X-RateLimit-Limit') !== null, '429 は X-RateLimit-Limit を返す');
    const text = await res.clone().text();
    const parsed = JSON.parse(text) as { error?: unknown; detail?: unknown };
    check(parsed.error === 'RATE_LIMITED', '429 の body は安定 JSON（error=RATE_LIMITED）');
    check(typeof parsed.detail === 'string', '429 の body に client が表示できる detail がある');
    check(!/203\.0\.113\.77|user-abc/.test(text), '429 の body に IP / user_id を含めない');
  } else {
    check(false, '429 contract を検証できた');
  }

  // ★ guard が拒否した request は body を返さない ＝ route が prompt を組む材料を得ない
  //   ＝ Anthropic へ到達しえない（route は `if (!guard.ok) return guard.response;` で即返す）。
  check(
    !('body' in blocked) && !blocked.ok,
    '★ 拒否された request は body を返さない（AI へ渡す材料が存在しない）',
  );

  // 別 IP は別枠（1 人の濫用が他ユーザーを巻き込まない）。
  const otherIp = await guardEsRequest(mk('{}', '203.0.113.99'), 'organize');
  check(otherIp.ok, '別 IP は別枠（巻き込み 429 にならない）');

  // operation ごとに枠が独立（organize を使い切っても deep は通る）。
  const otherOp = await guardEsRequest(mk('{}', '203.0.113.77'), 'deep');
  check(otherOp.ok, 'operation ごとに枠が独立している');

  console.log(`\n${fails === 0 ? '✅ PASS' : `❌ FAIL (${fails})`}`);
  process.exit(fails === 0 ? 0 : 1);
}

void runtimeChecks();
