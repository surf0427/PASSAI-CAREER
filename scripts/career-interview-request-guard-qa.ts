/*
 * scripts/career-interview-request-guard-qa.ts
 *
 * PASSAI CAREER — 面接 AI route の request guard QA（dev-only 常設・決定的）。
 *
 * 対象:
 *   POST /api/career/interview/start
 *   POST /api/career/interview/turn
 *   POST /api/career/interview/complete
 *
 * 目的（Production Readiness Audit P0-1 の回帰ガード）:
 *   3 route が **AI へ到達する前に**
 *     1. Career（Project B）server identity を確定し（guest は拒否せずキーを分けるだけ）
 *     2. rate limit（member=user_id / guest=IP）を通し
 *     3. body サイズ・turns サイズの上限を適用する
 *   ことを固定する。加えて **正常な 5 ターン面接が 1 度も上限に触れない**ことを証明する。
 *
 *   外部 AI 非実行・実 DB 非接続（identity は request scope 外なので必ず guest へ倒れる）。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-interview-request-guard-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// rate limit を決定的にする（env による無効化を外し、in-memory store を注入する）。
delete process.env.CAREER_GD_RATE_LIMIT_DISABLED;

import {
  MAX_TURN_CONTENT_CHARS,
  MAX_TURN_ENTRIES,
  MAX_TURNS_TOTAL_CHARS,
  findInterviewTurnsViolation,
  guardInterviewRequest,
  selectInterviewRateLimitTarget,
  type InterviewIdentity,
  type InterviewOperation,
} from '@/app/api/career/interview/requestGuard';
import { MAX_BODY_BYTES } from '@/lib/careerApi/requestGuard';
import { CAREER_INTERVIEW_RATE_LIMITS } from '@/lib/rateLimit';
import { __setRateLimitStoreForTest, type RateLimitStore } from '@/lib/rateLimit/store';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

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

// ── in-memory store（プロセス内・決定的）────────────────────────────
class MemoryStore implements RateLimitStore {
  readonly backend = 'memory' as const;
  private map = new Map<string, { count: number; expiresAt: number }>();
  async incr(storeKey: string, ttlSeconds: number, nowMs: number): Promise<number> {
    const e = this.map.get(storeKey);
    if (!e || e.expiresAt <= nowMs) {
      this.map.set(storeKey, { count: 1, expiresAt: nowMs + ttlSeconds * 1000 });
      return 1;
    }
    e.count += 1;
    return e.count;
  }
  async resetAll(): Promise<void> {
    this.map.clear();
  }
}
const store = new MemoryStore();
__setRateLimitStoreForTest(store);

// ── request helper ──────────────────────────────────────────────────
// ★ IP をケースごとに変えて、rate limit のバケットを混ぜない。
function mkRequest(body: unknown, ip: string, headers: Record<string, string> = {}): Request {
  const raw = JSON.stringify(body);
  return new Request('https://x.test/api/career/interview/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers },
    body: raw,
  });
}

const TARGET = {
  companyName: '株式会社サンプル',
  industry: 'IT',
  jobType: '総合職',
  selectionType: 'main',
};
const NORMAL_BODY = {
  profile: { name: '田中', grade: '大学3年' },
  activity: { focusedActivities: ['大学祭の広報'] },
  target: TARGET,
  interviewType: 'real',
};
// 正常な 5 ターン面接の **最終ターン**（質問 5 + 回答 4 ＝ 9 要素）。
const NORMAL_TURNS = Array.from({ length: 9 }, (_, i) => ({
  role: i % 2 === 0 ? 'question' : 'answer',
  content: i % 2 === 0 ? 'これまでの経験について教えてください。' : 'あ'.repeat(600),
}));

const ROUTES: { name: string; file: string; op: InterviewOperation }[] = [
  { name: 'start', file: 'app/api/career/interview/start/route.ts', op: 'start' },
  { name: 'turn', file: 'app/api/career/interview/turn/route.ts', op: 'turn' },
  { name: 'complete', file: 'app/api/career/interview/complete/route.ts', op: 'complete' },
];

async function main() {
  // ══════════════════════════════════════════════════════════════════
  section('A. 3 route が共通 guard を AI 到達前に通している');

  for (const r of ROUTES) {
    const src = read(r.file);
    check(
      src.includes(`guardInterviewRequest(req, '${r.op}')`),
      `${r.name}: guardInterviewRequest を operation='${r.op}' で呼ぶ`,
    );
    check(
      /if \(!guard\.ok\) return guard\.response;/.test(src),
      `${r.name}: guard 失敗はそのまま返す（素通ししない）`,
    );
    // 生の req.json() が残っていると guard を迂回できる。
    check(!src.includes('await req.json()'), `${r.name}: 生の req.json() が残っていない`);

    const post = bodyOf(src, 'export async function POST');
    const guardAt = post.indexOf('guardInterviewRequest');
    const aiAt = post.indexOf('anthropic.messages.create');
    const ctxAt = post.indexOf('resolveInterviewContextInputs(');
    const companyAt = post.indexOf('resolveInterviewCompanyOfficial(');
    const memoryAt = post.indexOf('resolveInterviewPersonalMemory(');

    check(guardAt >= 0 && aiAt >= 0 && guardAt < aiAt, `${r.name}: guard は AI call より前`);
    check(guardAt >= 0 && ctxAt >= 0 && guardAt < ctxAt, `${r.name}: guard は context 解決より前`);
    check(
      guardAt >= 0 && companyAt >= 0 && guardAt < companyAt,
      `${r.name}: guard は Company Spine read より前（無認証で I/O させない）`,
    );
    check(
      guardAt >= 0 && memoryAt >= 0 && guardAt < memoryAt,
      `${r.name}: guard は Personal Memory read より前`,
    );
  }

  // guard 自身が AI を持たない＝ reject 経路で AI が走りようがない（静的証明）。
  const guardSrc = read('app/api/career/interview/requestGuard.ts');
  check(
    !/@\/lib\/ai|anthropic/.test(stripComments(guardSrc)),
    'guard module は AI client を import しない（reject 経路で AI コール 0 回）',
  );

  // ══════════════════════════════════════════════════════════════════
  section('B. identity — client 申告値を認証に使わない / guest を閉じない');

  const guardCode = stripComments(guardSrc);
  check(
    guardSrc.includes("from '@/lib/careerApi/requestGuard'"),
    '汎用 guard は機能非依存の共通基盤から使う（重複実装しない）',
  );
  // ★ 機能間の依存を作らない（面接が他機能の module を参照していたら architecture 違反）。
  check(
    !/from '\.\.\/(presentation|gd|es|matching)\//.test(guardSrc) &&
      !/@\/app\/api\/career\/(presentation|gd|es|matching)\//.test(guardSrc),
    '面接 guard は他機能（プレゼン等）の module を参照しない',
  );
  check(
    !/status:\s*401/.test(guardCode),
    '401 を返さない（guest 面接を壊さない）',
  );
  check(
    !/\bbody\b[^\n]*\buserId\b|\bb\.userId\b/.test(guardCode),
    'request body の userId を identity に使わない',
  );

  // ══════════════════════════════════════════════════════════════════
  section('C. rate limit — member / guest で別枠になる');

  const member: InterviewIdentity = { kind: 'member', userId: 'user-abc' };
  const guest: InterviewIdentity = { kind: 'guest' };

  for (const r of ROUTES) {
    const m = selectInterviewRateLimitTarget(member, r.op, '203.0.113.9');
    const g = selectInterviewRateLimitTarget(guest, r.op, '203.0.113.9');
    check(m.key === 'u:user-abc', `${r.name}: member は user_id キー`);
    check(g.key === 'i:203.0.113.9', `${r.name}: guest は IP キー`);
    check(m.rule.namespace !== g.rule.namespace, `${r.name}: member と guest は別 namespace`);
    check(
      g.rule.windows[0].limit < m.rule.windows[0].limit,
      `${r.name}: guest の上限は member より厳しい`,
    );
    check(g.rule.failClosed === true, `${r.name}: guest は fail-closed`);
    check(m.rule.failClosed !== true, `${r.name}: member は fail-open`);
  }

  check(
    CAREER_INTERVIEW_RATE_LIMITS.completeMember.windows[0].limit <
      CAREER_INTERVIEW_RATE_LIMITS.turnMember.windows[0].limit,
    'complete（max_tokens 4000 と最も高価）は turn より厳しい上限',
  );
  // 正常利用（1 面接 = start 1 + turn 4 + complete 1）を壊さない下限。
  check(
    CAREER_INTERVIEW_RATE_LIMITS.turnGuest.windows[0].limit >= 4,
    'guest でも 1 面接ぶんの turn（4 回）を 1 分内に完走できる',
  );
  check(
    CAREER_INTERVIEW_RATE_LIMITS.completeGuest.windows[1].limit >= 10,
    'guest でも 1 時間に 10 回以上の評価が可能（体験が完走できる水準）',
  );

  // ══════════════════════════════════════════════════════════════════
  section('D. turns 上限 — 正常な面接は絶対に引っかからない');

  check(findInterviewTurnsViolation({ turns: NORMAL_TURNS }) === null, '正常な 5 ターン面接は通る');
  // 最悪の正常系: 回答 5 件がすべて turn route の上限（8,000 字）ちょうど。
  const worstNormal = [
    ...Array.from({ length: 5 }, () => ({ role: 'answer', content: 'あ'.repeat(8000) })),
    ...Array.from({ length: 5 }, () => ({ role: 'question', content: 'い'.repeat(400) })),
  ];
  check(
    findInterviewTurnsViolation({ turns: worstNormal }) === null,
    '最悪の正常系（8,000 字 × 5 回答）でも上限に触れない',
  );
  check(findInterviewTurnsViolation({}) === null, 'turns なし（start）は検査対象外で通る');
  check(findInterviewTurnsViolation({ turns: 'x' }) === null, 'turns が配列でなくても throw しない');

  check(
    findInterviewTurnsViolation({
      turns: new Array(MAX_TURN_ENTRIES + 1).fill({ role: 'answer', content: 'a' }),
    }) === 'turns_count',
    `turns 件数超過を拒否（> ${MAX_TURN_ENTRIES}）`,
  );
  check(
    findInterviewTurnsViolation({
      turns: [{ role: 'answer', content: 'あ'.repeat(MAX_TURN_CONTENT_CHARS + 1) }],
    }) === 'turn_content_chars',
    `1 発話の文字数超過を拒否（> ${MAX_TURN_CONTENT_CHARS}）`,
  );
  check(
    findInterviewTurnsViolation({
      turns: new Array(20).fill({ role: 'answer', content: 'あ'.repeat(7000) }),
    }) === 'turns_total_chars',
    `transcript 合計の文字数超過を拒否（> ${MAX_TURNS_TOTAL_CHARS}）`,
  );

  // ══════════════════════════════════════════════════════════════════
  section('E. guard を実際に通す（Guard 1〜9）');

  // Guard 1〜3: 正常 request は allowed（identity は request scope 外なので guest へ倒れる）。
  for (const r of ROUTES) {
    const body =
      r.op === 'start'
        ? NORMAL_BODY
        : { ...NORMAL_BODY, turns: NORMAL_TURNS, answer: 'あ'.repeat(300) };
    const res = await guardInterviewRequest(mkRequest(body, `198.51.100.${ROUTES.indexOf(r) + 1}`), r.op);
    check(res.ok === true, `Guard ${ROUTES.indexOf(r) + 1}: 正常な ${r.name} request は allowed`);
    if (res.ok) {
      check(
        JSON.stringify(res.body) === JSON.stringify(body),
        `${r.name}: parse 済み body が route へそのまま渡る（契約不変）`,
      );
    }
  }

  // Guard 4: body oversize（実測バイト数で拒否）。
  const huge = { ...NORMAL_BODY, blob: 'x'.repeat(MAX_BODY_BYTES + 10) };
  const g4 = await guardInterviewRequest(mkRequest(huge, '198.51.100.21'), 'start');
  check(g4.ok === false && g4.response.status === 413, 'Guard 4: body oversize → 413（AI 到達前）');

  // Content-Length を偽装しても実測で弾く。
  const g4b = await guardInterviewRequest(
    mkRequest(huge, '198.51.100.22', { 'content-length': '10' }),
    'start',
  );
  check(
    g4b.ok === false && g4b.response.status === 413,
    'Guard 4b: Content-Length 偽装でも実測バイト数で 413',
  );

  // Guard 5: turns 件数超過。
  const g5 = await guardInterviewRequest(
    mkRequest(
      { ...NORMAL_BODY, turns: new Array(MAX_TURN_ENTRIES + 5).fill({ role: 'answer', content: 'あ' }) },
      '198.51.100.23',
    ),
    'turn',
  );
  check(g5.ok === false && g5.response.status === 413, 'Guard 5: turns 件数超過 → 413（AI 到達前）');

  // Guard 6: turns 合計文字数超過。
  const g6 = await guardInterviewRequest(
    mkRequest(
      { ...NORMAL_BODY, turns: new Array(20).fill({ role: 'answer', content: 'あ'.repeat(7000) }) },
      '198.51.100.24',
    ),
    'complete',
  );
  check(g6.ok === false && g6.response.status === 413, 'Guard 6: transcript 合計超過 → 413（AI 到達前）');

  // 不正 JSON は 400（既存 route の契約と同じ形）。
  const badJson = new Request('https://x.test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.25' },
    body: '{ not json',
  });
  const gBad = await guardInterviewRequest(badJson, 'start');
  check(gBad.ok === false && gBad.response.status === 400, '不正 JSON → 400（既存契約と同じ）');
  if (!gBad.ok) {
    const payload = (await gBad.response.clone().json()) as { error?: string };
    check(
      payload.error === 'リクエストボディが不正です。',
      '不正 JSON のレスポンス本文が既存 route と同一（client 契約不変）',
    );
  }

  // Guard 7: rate limit 超過 → 429（同一 IP で guest 上限まで叩く）。
  await store.resetAll();
  const burstIp = '198.51.100.30';
  const guestCompleteLimit = CAREER_INTERVIEW_RATE_LIMITS.completeGuest.windows[0].limit;
  let lastOk = true;
  for (let i = 0; i < guestCompleteLimit; i++) {
    const res = await guardInterviewRequest(
      mkRequest({ ...NORMAL_BODY, turns: NORMAL_TURNS }, burstIp),
      'complete',
    );
    lastOk = lastOk && res.ok === true;
  }
  check(lastOk, `Guard 7a: guest の上限内（${guestCompleteLimit} 回）はすべて allowed`);
  const over = await guardInterviewRequest(
    mkRequest({ ...NORMAL_BODY, turns: NORMAL_TURNS }, burstIp),
    'complete',
  );
  check(over.ok === false && over.response.status === 429, 'Guard 7b: 上限超過 → 429');
  if (!over.ok) {
    check(
      over.response.headers.get('retry-after') !== null,
      'Guard 7c: 429 に Retry-After header が付く',
    );
    const payload = (await over.response.clone().json()) as { error?: string };
    check(payload.error === 'RATE_LIMITED', 'Guard 7d: 429 の JSON は既存 convention（RATE_LIMITED）');
  }
  // ★ 429 は AI 到達前（guard は AI を import すらしない＝上の A 節で静的に証明済み）。

  // 別 IP は独立バケット（1 人の濫用が他ユーザーを巻き込まない）。
  const otherIp = await guardInterviewRequest(
    mkRequest({ ...NORMAL_BODY, turns: NORMAL_TURNS }, '198.51.100.31'),
    'complete',
  );
  check(otherIp.ok === true, 'Guard 7e: 別 IP は独立した枠（巻き添えにしない）');

  // Guard 8: guest 利用が維持されている（401 で閉じない）。
  await store.resetAll();
  const g8 = await guardInterviewRequest(mkRequest(NORMAL_BODY, '198.51.100.40'), 'start');
  check(
    g8.ok === true && g8.identity.kind === 'guest',
    'Guard 8: 未ログイン（guest）でも面接を開始できる',
  );

  // Guard 9: member はより緩い専用枠（キー・namespace が guest と別）。
  const m9 = selectInterviewRateLimitTarget(member, 'complete', '198.51.100.40');
  const g9 = selectInterviewRateLimitTarget(guest, 'complete', '198.51.100.40');
  check(
    m9.key.startsWith('u:') && m9.rule.namespace !== g9.rule.namespace,
    'Guard 9: member は user_id キーの専用枠で利用できる',
  );

  console.log(`\n${fails === 0 ? 'ALL_PASS' : `FAIL(${fails})`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
