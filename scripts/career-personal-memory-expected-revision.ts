/*
 * scripts/career-personal-memory-expected-revision.ts
 *
 * PASSAI CAREER — P16-I-X: expected revision local verifier（dev-only・offline）。
 *
 * 実 production builder / canonicalization / revision を再利用し、ローカルで **expected revision の短縮値だけ**を
 * 算出する。Operator Packet の「実 Source と実 row の revision 一致」確認を、payload 本文を出さずに補助する。
 * network / Supabase / env 参照なし。input を echo しない・temp file を作らない・input を永続化しない。
 *
 * 使い方:
 *   自己テスト（QA）:  npx tsx scripts/career-personal-memory-expected-revision.ts
 *   実 Source 判定:     echo '{"section":"base","profile":{...},"activity":{...},"values":{...}}' | \
 *                       npx tsx scripts/career-personal-memory-expected-revision.ts --stdin
 *
 * ★ base のみ対応。production の base shadow write と同じ normalization（buildCareerAiContext.profile）を通す。
 */

import { buildCareerAiContext } from '@/lib/careerAi';
import { buildBaseMemorySection } from '@/lib/careerMemory/persistence/rebuild';
import { validateCareerPersonalMemorySection, payloadByteSize } from '@/lib/careerMemory/persistence/validate';

// 出力してよい sanitized 結果（Source/payload 本文・PII は含めない）。
export type ExpectedRevisionResult = {
  section: string | null;
  builderSuccess: boolean;
  validationSuccess: boolean;
  expectedRevisionShort: string | null; // <= 24 chars
  payloadByteSize: number | null;
  schemaVersion: number | null;
  forbiddenFieldAbsent: boolean;
  piiGuardPass: boolean;
  reason?: string; // sanitized（input 内容を含めない）
};

const PII_KEYS = new Set(['name', 'email', 'phone', 'tel', 'address']);
function hasPiiKey(v: unknown, d = 0): boolean {
  if (d > 12) return false;
  if (Array.isArray(v)) return v.some((x) => hasPiiKey(x, d + 1));
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (PII_KEYS.has(k.toLowerCase())) return true;
      if (hasPiiKey(val, d + 1)) return true;
    }
  }
  return false;
}

// base の expected revision を算出（never-throw・sanitized）。
export function computeExpectedRevision(input: unknown): ExpectedRevisionResult {
  const fail = (reason: string, section: string | null = null): ExpectedRevisionResult => ({
    section, builderSuccess: false, validationSuccess: false, expectedRevisionShort: null,
    payloadByteSize: null, schemaVersion: null, forbiddenFieldAbsent: false, piiGuardPass: false, reason,
  });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('invalid_input');
  const obj = input as Record<string, unknown>;
  const section = typeof obj.section === 'string' ? obj.section : 'base';
  if (section !== 'base') return fail('section_not_supported (base only)', section);
  try {
    const ctx = buildCareerAiContext({
      featureKey: 'career-consultation',
      profile: (obj.profile ?? null) as never,
      activity: (obj.activity ?? null) as never,
      values: (obj.values ?? null) as never,
      userInput: '',
    });
    const built = buildBaseMemorySection(ctx.profile, (obj.activity ?? null) as never, (obj.values ?? null) as never);
    const v = validateCareerPersonalMemorySection('base', built.section.schemaVersion, built.section.payload);
    const size = payloadByteSize(built.section.payload);
    return {
      section: 'base',
      builderSuccess: true,
      validationSuccess: v.ok,
      expectedRevisionShort: built.sourceRevision.slice(0, 24),
      payloadByteSize: size,
      schemaVersion: built.section.schemaVersion,
      forbiddenFieldAbsent: v.ok,
      piiGuardPass: !hasPiiKey(built.section.payload),
      ...(v.ok ? {} : { reason: `validation_failed:${v.reason}` }),
    };
  } catch {
    return fail('builder_threw'); // input 内容は含めない
  }
}

function readStdin(): string {
  try { return readFileSyncFd(0); } catch { return ''; }
}
function readFileSyncFd(fd: number): string {
  // 同期 stdin 読取（tsx/node）。
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  return readFileSync(fd, 'utf8');
}

function selfTest(): number {
  let f = 0;
  const check = (ok: boolean, name: string) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`); if (!ok) f++; };
  const base = (over: Record<string, unknown> = {}) => ({
    section: 'base',
    profile: { name: '山田太郎', email: 'a@b.com', university: '東京大学', faculty: '工学部', grade: 'B3', graduationYear: '2027', targetIndustries: ['IT'], targetJobs: ['eng'], jobHuntingStatus: '準備中', strengths: ['実行力'], weaknesses: [], preferredLocations: ['東京'], ...over },
    activity: { focusedActivities: [{ title: 'x' }], updatedAt: '2026-07-01T00:00:00.000Z' },
    values: { selections: { priorities: ['成長'], industries: ['IT'] }, updatedAt: '2026-07-02T00:00:00.000Z' },
  });

  const r1 = computeExpectedRevision(base());
  check(r1.builderSuccess && r1.validationSuccess && !!r1.expectedRevisionShort, 'valid base → builder+validation success + revision');
  check(r1.piiGuardPass && r1.forbiddenFieldAbsent, 'PII(name/email) は projection で除去（PII guard pass）');
  check((r1.payloadByteSize ?? 0) > 0 && (r1.payloadByteSize ?? 1e9) < 32768, 'payload byte size < 32KB');

  // same source → same revision
  check(computeExpectedRevision(base()).expectedRevisionShort === r1.expectedRevisionShort, 'same Source → same revision');
  // object key order 差 → same revision（stableStringify で吸収）
  const reordered = { values: base().values, activity: base().activity, profile: base().profile, section: 'base' };
  check(computeExpectedRevision(reordered).expectedRevisionShort === r1.expectedRevisionShort, 'key order 差 → same revision');
  // projected field 変更 → revision 変化
  check(computeExpectedRevision(base({ targetIndustries: ['IT', 'コンサル'] })).expectedRevisionShort !== r1.expectedRevisionShort, 'projected field 変更 → revision 変化');
  // non-projected field 変更 → revision 不変（notes は projection されない）
  check(computeExpectedRevision(base({ notes: 'メモ' })).expectedRevisionShort === r1.expectedRevisionShort, 'non-projected field 変更 → revision 不変');
  // PII 混入しても revision は projection ベース（name 有無で不変）
  const noPii = base(); delete (noPii.profile as Record<string, unknown>).name; delete (noPii.profile as Record<string, unknown>).email;
  check(computeExpectedRevision(noPii).expectedRevisionShort === r1.expectedRevisionShort, 'PII 有無で revision 不変（projection が PII 非依存）');
  // invalid source → sanitized failure（input を出さない）
  check(computeExpectedRevision(null).builderSuccess === false && computeExpectedRevision(null).reason === 'invalid_input', 'invalid source → sanitized failure');
  check(computeExpectedRevision('x').reason === 'invalid_input', 'string input → invalid_input');
  // base 以外の section → reject
  check(computeExpectedRevision({ section: 'es' }).reason?.startsWith('section_not_supported') === true, 'section=es → reject (base only)');
  // 出力に PII/Source 本文が含まれない（結果 object の key 検査）
  const keys = Object.keys(r1);
  check(!keys.some((k) => /profile|activity|values|source|payload$|name|email/i.test(k) && k !== 'payloadByteSize'), '結果 object に Source/payload 本文 key なし');

  console.log('');
  console.log(f === 0 ? 'career-personal-memory-expected-revision-qa: ALL PASS' : `career-personal-memory-expected-revision-qa: ${f} FAIL`);
  return f;
}

function mainCli() {
  if (process.argv.includes('--stdin')) {
    const text = readStdin().trim();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const res = computeExpectedRevision(parsed);
    // sanitized JSON のみ出力（input を echo しない）。
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.builderSuccess && res.validationSuccess ? 0 : 1);
  }
  process.exit(selfTest() === 0 ? 0 : 1);
}

mainCli();
