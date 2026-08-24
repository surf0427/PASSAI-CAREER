/*
 * scripts/career-ai-route-guard-qa.ts
 *
 * PASSAI CAREER — 残り CAREER AI route の request guard QA（dev-only 常設・決定的）。
 *
 * 対象（Production Readiness Audit P0: identity も rate limit も無いまま Anthropic を
 * 呼んでいた 9 route）:
 *   POST /api/career/company-research
 *   POST /api/career/company-research/extract   （multipart / Vision OCR）
 *   POST /api/career/consultation
 *   POST /api/career/matching
 *   POST /api/career/self-analysis
 *   POST /api/career/self-analysis/question
 *   POST /api/career/gd/theme
 *   POST /api/career/gd/turn
 *   POST /api/career/gd/feedback
 *
 * 目的:
 *   1. 9 route が AI へ到達する **前に** guard を通すこと（順序を含めて固定）。
 *   2. guard を迂回できる生の req.json() / req.formData() が残っていないこと。
 *   3. rate limit の key が member=user_id / guest=IP の 2 系統であること。
 *   4. guest 側 rule が fail-closed であること（store 障害中に匿名から無制限の AI 課金を
 *      許さない）。member 側は fail-open（既存 CAREER 方針と同一）。
 *   5. namespace が全 rule で一意であること（衝突するとバケットを共有してしまう）。
 *   6. ★ 回帰ガード: **anthropic を呼ぶ CAREER route はすべて** 何らかの guard を
 *      持つこと。新しい AI route を無防備なまま増やせないようにする。
 *
 *   外部 AI 非実行・実 DB 非接続（identity 解決は never-throw で guest に倒れる）。
 *
 * 使い方: npx tsx scripts/career-ai-route-guard-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  selectCareerAiRateLimitTarget,
  type CareerRequestIdentity,
} from '@/lib/careerApi/requestGuard';
import { CAREER_AI_RATE_LIMITS, type RateLimitRule } from '@/lib/rateLimit';

// CAREER_AI_RATE_LIMITS は `as const` なので、failClosed を持たない member rule では
// リテラル型から当該プロパティが消える。宣言の意図（RateLimitRule）で読み直す。
const rule = (key: keyof typeof CAREER_AI_RATE_LIMITS): RateLimitRule =>
  CAREER_AI_RATE_LIMITS[key];

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// コメント文（この QA の意図を書いた日本語）が負のセンチネルへ自己マッチしないよう除去する。
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

type Guarded = {
  name: string;
  file: string;
  memberRule: keyof typeof CAREER_AI_RATE_LIMITS;
  guestRule: keyof typeof CAREER_AI_RATE_LIMITS;
  /** multipart（formData）route は guardCareerAiUpload を使う。 */
  upload?: true;
};

const ROUTES: Guarded[] = [
  {
    name: 'company-research',
    file: 'app/api/career/company-research/route.ts',
    memberRule: 'companyResearchMember',
    guestRule: 'companyResearchGuest',
  },
  {
    name: 'company-research/extract',
    file: 'app/api/career/company-research/extract/route.ts',
    memberRule: 'companyExtractMember',
    guestRule: 'companyExtractGuest',
    upload: true,
  },
  {
    name: 'consultation',
    file: 'app/api/career/consultation/route.ts',
    memberRule: 'consultationMember',
    guestRule: 'consultationGuest',
  },
  {
    name: 'matching',
    file: 'app/api/career/matching/route.ts',
    memberRule: 'matchingMember',
    guestRule: 'matchingGuest',
  },
  {
    name: 'self-analysis',
    file: 'app/api/career/self-analysis/route.ts',
    memberRule: 'selfAnalysisMember',
    guestRule: 'selfAnalysisGuest',
  },
  {
    name: 'self-analysis/question',
    file: 'app/api/career/self-analysis/question/route.ts',
    memberRule: 'selfAnalysisQuestionMember',
    guestRule: 'selfAnalysisQuestionGuest',
  },
  {
    name: 'presentation/material',
    file: 'app/api/career/presentation/material/route.ts',
    memberRule: 'presentationMaterialMember',
    guestRule: 'presentationMaterialGuest',
    upload: true,
  },
  {
    name: 'gd/theme',
    file: 'app/api/career/gd/theme/route.ts',
    memberRule: 'gdThemeMember',
    guestRule: 'gdThemeGuest',
  },
  {
    name: 'gd/turn',
    file: 'app/api/career/gd/turn/route.ts',
    memberRule: 'gdTurnMember',
    guestRule: 'gdTurnGuest',
  },
  {
    name: 'gd/feedback',
    file: 'app/api/career/gd/feedback/route.ts',
    memberRule: 'gdFeedbackMember',
    guestRule: 'gdFeedbackGuest',
  },
];

console.log('PASSAI CAREER — CAREER AI route request guard QA');

// ════════════════════════════════════════════════════════════════════
section('A. 10 route が guard を AI 到達前に通している');

for (const r of ROUTES) {
  const src = read(r.file);
  const fn = r.upload ? 'guardCareerAiUpload' : 'guardCareerAiRequest';

  check(src.includes(`${fn}(req, {`), `${r.name}: ${fn} を呼ぶ`);
  check(
    /if \(!guard\.ok\) return guard\.response;/.test(src),
    `${r.name}: guard 失敗はそのまま返す（素通ししない）`,
  );
  check(
    src.includes(`CAREER_AI_RATE_LIMITS.${r.memberRule}`) &&
      src.includes(`CAREER_AI_RATE_LIMITS.${r.guestRule}`),
    `${r.name}: member/guest の 2 系統 rule を渡す`,
  );

  const bare = stripComments(src);
  if (r.upload) {
    // 生の formData() は guard の後ろに 1 箇所だけ（guard 前に parse しない）。
    const post = bodyOf(bare, 'export async function POST');
    const guardAt = post.indexOf(fn);
    const formAt = post.indexOf('await req.formData()');
    check(
      guardAt >= 0 && formAt >= 0 && guardAt < formAt,
      `${r.name}: guard は formData() より前にある（10MB を parse する前に 429）`,
    );
  } else {
    // ★ 生の req.json() が残っていたら guard を迂回できてしまう。
    check(!bare.includes('await req.json()'), `${r.name}: 生の req.json() が残っていない`);
  }

  // guard が AI 呼び出しより前にあること（import 行に当たらないよう POST 本体だけで測る）。
  const post = bodyOf(bare, 'export async function POST');
  const guardAt = post.indexOf(fn);
  const aiAt = post.indexOf('anthropic.messages.create');
  if (aiAt >= 0) {
    check(guardAt >= 0 && guardAt < aiAt, `${r.name}: guard は AI call より前にある`);
  } else {
    // AI 呼び出しを helper へ切り出している route（self-analysis 等）は
    // guard が POST 本体の先頭付近にあることだけ確認する。
    check(guardAt >= 0, `${r.name}: guard が POST 本体にある`);
  }
}

// ════════════════════════════════════════════════════════════════════
section('B. kill switch（flag OFF）は guard より前に残っている');

// GD / matching は flag OFF なら 404。identity 解決すらせず打ち切る位置を維持する。
for (const [name, file, sentinel] of [
  ['gd/theme', 'app/api/career/gd/theme/route.ts', 'requireCareerGdEnabled'],
  ['gd/turn', 'app/api/career/gd/turn/route.ts', 'requireCareerGdEnabled'],
  ['gd/feedback', 'app/api/career/gd/feedback/route.ts', 'requireCareerGdEnabled'],
  ['matching', 'app/api/career/matching/route.ts', 'isCareerCompanyMatchingEnabled'],
] as const) {
  const post = bodyOf(stripComments(read(file)), 'export async function POST');
  const gateAt = post.indexOf(sentinel);
  const guardAt = post.indexOf('guardCareerAiRequest');
  check(
    gateAt >= 0 && guardAt >= 0 && gateAt < guardAt,
    `${name}: ${sentinel}() は guard より前（OFF 中は identity すら解決しない）`,
  );
}

// ════════════════════════════════════════════════════════════════════
section('C. rate limit の key は member=user_id / guest=IP の 2 系統');

const member: CareerRequestIdentity = { kind: 'member', userId: 'user-abc' };
const guest: CareerRequestIdentity = { kind: 'guest' };

for (const r of ROUTES) {
  const rules = { member: rule(r.memberRule), guest: rule(r.guestRule) };
  const m = selectCareerAiRateLimitTarget(member, rules, '203.0.113.9');
  const g = selectCareerAiRateLimitTarget(guest, rules, '203.0.113.9');

  check(m.key === 'u:user-abc', `${r.name}: member は user_id をキーにする`);
  check(g.key === 'i:203.0.113.9', `${r.name}: guest は IP をキーにする`);
  check(
    m.rule.namespace !== g.rule.namespace,
    `${r.name}: member / guest は別 namespace（バケットを共有しない）`,
  );
  // client 申告の identity は使わない（key に body 由来の値が混ざらない）。
  check(
    !m.key.includes('undefined') && !g.key.includes('undefined'),
    `${r.name}: key に undefined が混ざらない`,
  );
}

// ════════════════════════════════════════════════════════════════════
section('D. guest rule は fail-closed / member rule は fail-open');

for (const r of ROUTES) {
  check(
    rule(r.guestRule).failClosed === true,
    `${r.name}: guest は fail-closed（store 障害中に匿名の無制限 AI 課金を許さない）`,
  );
  check(
    rule(r.memberRule).failClosed !== true,
    `${r.name}: member は fail-open（store 障害でログイン済みユーザーを止めない）`,
  );
  check(
    rule(r.guestRule).windows.every(
      (w, i) => w.limit <= rule(r.memberRule).windows[i]!.limit,
    ),
    `${r.name}: guest 上限は member 以下`,
  );
  check(
    rule(r.memberRule).windows.length >= 2,
    `${r.name}: 短期 + 中期の複数 window を持つ`,
  );
}

// ════════════════════════════════════════════════════════════════════
section('E. namespace は全 rule で一意');

const namespaces: string[] = Object.values(CAREER_AI_RATE_LIMITS).map((r) => r.namespace);
check(
  new Set(namespaces).size === namespaces.length,
  `CAREER_AI_RATE_LIMITS の namespace が一意（${namespaces.length} 件）`,
);
check(
  namespaces.every((n) => n.startsWith('career_')),
  'namespace はすべて career_ 接頭辞',
);

// ════════════════════════════════════════════════════════════════════
section('F. 回帰ガード: anthropic を呼ぶ CAREER route はすべて guard を持つ');

// app/api/career 配下の route.ts を走査し、AI を呼ぶのに guard を 1 つも持たないものを検出する。
const GUARD_SENTINELS = [
  'guardCareerAiRequest',
  'guardCareerAiUpload',
  'guardEsRequest',
  'guardInterviewRequest',
  'guardPresentationRequest',
  'enforceRateLimit',
];

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === 'route.ts') out.push(full);
  }
  return out;
};

const apiRoot = join(ROOT, 'app/api/career');
const unguarded: string[] = [];
let aiRouteCount = 0;

for (const full of walk(apiRoot)) {
  const src = stripComments(readFileSync(full, 'utf8'));
  const callsAi =
    src.includes('anthropic.messages.create') || src.includes('anthropic.messages.stream');
  if (!callsAi) continue;
  aiRouteCount += 1;
  if (!GUARD_SENTINELS.some((s) => src.includes(s))) {
    unguarded.push(full.slice(ROOT.length + 1));
  }
}

check(aiRouteCount > 0, `AI route を検出できている（${aiRouteCount} 件）`);
check(
  unguarded.length === 0,
  `guard を持たない AI route が 0 件${unguarded.length ? ` — ${unguarded.join(', ')}` : ''}`,
);

// ════════════════════════════════════════════════════════════════════
console.log(
  fails === 0
    ? '\nALL PASS — every CAREER AI route enforces identity + rate limit before the model call.'
    : `\n${fails} FAIL`,
);
process.exit(fails === 0 ? 0 : 1);
