/*
 * scripts/career-event-writer-qa.ts
 *
 * PASSAI CAREER — Career Event Log **writer** の DB 非依存 決定論 QA（P9-G 常設 harness）。
 *
 * 背景（P9-F 監査で残った既知ギャップ）:
 *   sanitize / timeline の純関数は qa:careerEvents（timeline）で厚くカバーされていたが、
 *   `recordCareerEvent` の **row 構築 / guard / error isolation** を直接固定する QA が無かった。
 *   P9-G で row 構築を純関数 `buildCareerEventInsertRow` に切り出したので、その契約を回帰固定する。
 *
 * 何を守るか:
 *   A. 正常系 — eventType→event_type / feature / clientEventId→client_event_id の snake_case row。
 *      user_id は引数（認証 user）からのみ。created_at / occurred_at はクライアントから送らない。
 *   B. Consultation 冪等 ID — 同じ message id を 2 回渡すと client_event_id が完全一致し、
 *      別の応答 id では別 client_event_id になる（(user_id, client_event_id) unique index の前提）。
 *   C. Guard — guest / 未知 feature / 未知 event_type は row=null（記録しない）。
 *      invalid score_band → null / invalid company_id → null / 空 clientEventId → null。
 *   D. PII / raw text — 危険 key・非スカラー・長文・改行・本文値は metadata row に残らない。
 *   E. Error isolation — insert が throw / reject しても recordCareerEvent は throw せず、
 *      guest / 未知 enum では insert adapter を呼ばない（no-op）。
 *
 * 厳守:
 *   - production の `buildCareerEventInsertRow` / `recordCareerEvent` を **読むだけ**。
 *   - 本番 Supabase へ接続しない（insert adapter を stub 注入）。env / secret 非参照。
 *   - AI prompt / body / CareerMemorySnapshot は扱わない。完全決定論。
 *
 * 使い方: npx tsx scripts/career-event-writer-qa.ts
 * 終了コード: 全 assertion PASS → 0 / いずれか FAIL → 1。
 */

import {
  buildCareerEventInsertRow,
  recordCareerEvent,
  type CareerEventInsertRow,
} from '@/lib/careerEvents/record';
import type { CareerEventInput } from '@/types/careerEvents';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const USER = 'user-abc';
// 実 assistant message id を模した安定 UUID（consultation の clientEventId 供給元）。
const MSG_ID_1 = '11111111-1111-4111-8111-111111111111';
const MSG_ID_2 = '22222222-2222-4222-8222-222222222222';

function baseInput(overrides: Partial<CareerEventInput> = {}): CareerEventInput {
  return {
    feature: 'consultation',
    eventType: 'consultation_asked',
    completionStatus: 'completed',
    ...overrides,
  };
}

// ── A. 正常系（snake_case row / user_id / created_at 非送信） ──────────
console.log('[A] 正常系 row 構築');
{
  const row = buildCareerEventInsertRow(
    USER,
    baseInput({ clientEventId: MSG_ID_1, scoreBand: 'A', metadata: { companyCount: 5, foo: 'x' } }),
  );
  check('row が生成される', row !== null);
  if (row) {
    check('user_id は引数 user', row.user_id === USER);
    check('eventType → event_type', row.event_type === 'consultation_asked');
    check('feature 保存', row.feature === 'consultation');
    check('clientEventId → client_event_id', row.client_event_id === MSG_ID_1);
    check('completionStatus → completion_status', row.completion_status === 'completed');
    check('score_band 採用（A）', row.score_band === 'A');
    check('metadata 許可 key のみ（companyCount 残る）', (row.metadata as Record<string, unknown>).companyCount === 5);
    check('metadata 未許可 key drop（foo 落ちる）', !('foo' in (row.metadata as Record<string, unknown>)));
    check('created_at をクライアントから送らない', !('created_at' in (row as Record<string, unknown>)));
    check('occurred_at をクライアントから送らない', !('occurred_at' in (row as Record<string, unknown>)));
  }
}

// ── B. Consultation 冪等 ID（同一応答 → 同一 client_event_id） ─────────
console.log('[B] consultation 冪等 ID');
{
  const r1 = buildCareerEventInsertRow(USER, baseInput({ clientEventId: MSG_ID_1 }));
  const r2 = buildCareerEventInsertRow(USER, baseInput({ clientEventId: MSG_ID_1 }));
  const r3 = buildCareerEventInsertRow(USER, baseInput({ clientEventId: MSG_ID_2 }));
  check('同一 message id → client_event_id 完全一致', r1?.client_event_id === r2?.client_event_id);
  check('同一 message id は非 null', r1?.client_event_id === MSG_ID_1);
  check('別 message id → 別 client_event_id', r1?.client_event_id !== r3?.client_event_id);
  check('別 message id は非 null', r3?.client_event_id === MSG_ID_2);
  // user が変われば同じ message id でも DB 上は (user_id, client_event_id) で別行（別 user は衝突しない）。
  const rOther = buildCareerEventInsertRow('user-other', baseInput({ clientEventId: MSG_ID_1 }));
  check('別 user + 同一 id は user_id で区別', rOther?.user_id !== r1?.user_id && rOther?.client_event_id === r1?.client_event_id);
}

// ── C. Guard（guest / 未知 enum / invalid 値） ────────────────────────
console.log('[C] guard');
{
  check('guest("") → null', buildCareerEventInsertRow('', baseInput()) === null);
  check('guest(null) → null', buildCareerEventInsertRow(null, baseInput()) === null);
  check('guest(undefined) → null', buildCareerEventInsertRow(undefined, baseInput()) === null);
  check(
    '未知 feature → null',
    buildCareerEventInsertRow(USER, baseInput({ feature: 'unknown' as CareerEventInput['feature'] })) === null,
  );
  check(
    '未知 event_type → null',
    buildCareerEventInsertRow(USER, baseInput({ eventType: 'bogus' as CareerEventInput['eventType'] })) === null,
  );
  const badBand = buildCareerEventInsertRow(USER, baseInput({ scoreBand: 'Z' as never }));
  check('invalid score_band → null', badBand?.score_band === null);
  const numBand = buildCareerEventInsertRow(USER, baseInput({ scoreBand: 95 as never }));
  check('生スコア数値 score_band → null', numBand?.score_band === null);
  const badCompany = buildCareerEventInsertRow(USER, baseInput({ companyId: 'not-a-uuid' }));
  check('invalid company_id → null', badCompany?.company_id === null);
  const goodCompany = buildCareerEventInsertRow(USER, baseInput({ companyId: MSG_ID_1 }));
  check('valid uuid company_id → 採用', goodCompany?.company_id === MSG_ID_1);
  const emptyCid = buildCareerEventInsertRow(USER, baseInput({ clientEventId: '   ' }));
  check('空白 clientEventId → client_event_id null', emptyCid?.client_event_id === null);
  const nullCid = buildCareerEventInsertRow(USER, baseInput({ clientEventId: null }));
  check('null clientEventId → client_event_id null', nullCid?.client_event_id === null);
}

// ── D. PII / raw text drop（危険 key・非スカラー・長文・改行・本文値） ──
console.log('[D] PII / raw text drop');
{
  const DENIED_KEYS = [
    'name', 'email', 'university', 'companyName', 'text', 'body', 'content',
    'answer', 'question', 'transcript', 'message', 'memo', 'raw', 'verified',
    'prompt', 'response', 'result', 'note', 'comment', 'summary', 'description',
    'reason', 'userInput', 'joinCode', 'roomTitle', 'participantName',
  ];
  const BODY_MARKERS = [
    'ES本文です',
    '面接の回答本文',
    '相談本文の中身',
    'AIが生成した回答本文',
    'GD発言の本文',
    'user@example.com',
    '山田太郎',
    '東京大学',
    '株式会社ヒミツ',
  ];
  const metadata: Record<string, unknown> = {};
  // 危険 key には各々異なる本文/PII マーカーを入れる（すべて allowlist 外なので drop される）。
  DENIED_KEYS.forEach((k, i) => {
    metadata[k] = BODY_MARKERS[i % BODY_MARKERS.length];
  });
  // 許可 key に非スカラー / 改行を入れても drop、長文は 64 字へ truncate（本文全文は残さない）。
  metadata.mode = { nested: 'x' }; // object → drop
  metadata.format = ['a', 'b']; // array → drop
  metadata.selectionType = 'x'.repeat(200); // 長文 → 64 字へ truncate（drop ではなく backstop）
  metadata.interviewType = 'line1\nline2'; // 改行 → drop
  // 安全 key。
  metadata.companyCount = 3;
  metadata.turnCount = 4;

  const row = buildCareerEventInsertRow(USER, baseInput({ metadata }));
  const meta = (row?.metadata ?? {}) as Record<string, unknown>;
  for (const k of DENIED_KEYS) {
    check(`危険 key drop: ${k}`, !(k in meta));
  }
  check('object 値 drop（mode）', !('mode' in meta));
  check('array 値 drop（format）', !('format' in meta));
  check('改行 value drop（interviewType）', !('interviewType' in meta));
  check(
    '長文 value は 64 字へ truncate（許可 key backstop）',
    typeof meta.selectionType === 'string' && (meta.selectionType as string).length === 64,
  );
  check('安全 companyCount 残る', meta.companyCount === 3);
  check('安全 turnCount 残る', meta.turnCount === 4);

  const serialized = JSON.stringify(row);
  for (const marker of BODY_MARKERS) {
    check(`本文/PII 値 非出力: "${marker.slice(0, 8)}…"`, !serialized.includes(marker));
  }

  // ラベル列も長文 / 改行は drop（industry / job_type 等）。
  const labelRow = buildCareerEventInsertRow(
    USER,
    baseInput({ industry: 'x'.repeat(200), jobType: 'multi\nline', selectionPhase: '本選考' }),
  );
  check('長文 industry → null', labelRow?.industry === null);
  check('改行 job_type → null', labelRow?.job_type === null);
  check('正常 selection_phase 採用', labelRow?.selection_phase === '本選考');
}

// ── E. Error isolation（insert stub 注入・never throw / no-op） ─────────
// tsx(cjs) は top-level await 非対応のため await を使う E + 最終レポートは async IIFE で包む。
void (async () => {
console.log('[E] error isolation / no-op');
{
  // insert が throw → recordCareerEvent は throw しない。
  let threw = false;
  try {
    await recordCareerEvent(USER, baseInput({ clientEventId: MSG_ID_1 }), async () => {
      throw new Error('insert boom');
    });
  } catch {
    threw = true;
  }
  check('insert throw でも recordCareerEvent は throw しない', threw === false);

  // insert が reject → 同上。
  let threw2 = false;
  try {
    await recordCareerEvent(USER, baseInput(), () => Promise.reject(new Error('reject boom')));
  } catch {
    threw2 = true;
  }
  check('insert reject でも throw しない', threw2 === false);

  // 正常時: insert adapter が sanitize 済み row で 1 回だけ呼ばれる。
  const calls: CareerEventInsertRow[] = [];
  await recordCareerEvent(
    USER,
    baseInput({ clientEventId: MSG_ID_1, metadata: { companyCount: 2, prompt: '秘密プロンプト' } }),
    async (row) => {
      calls.push(row);
    },
  );
  check('正常時 insert は 1 回呼ばれる', calls.length === 1);
  check('注入 row の client_event_id は安定 id', calls[0]?.client_event_id === MSG_ID_1);
  check('注入 row の metadata は sanitize 済み（prompt drop）', !('prompt' in (calls[0]?.metadata as Record<string, unknown>)));
  check('注入 row に本文 prompt 値が無い', !JSON.stringify(calls[0]).includes('秘密プロンプト'));

  // guest → insert 呼ばれない（no-op）。
  const guestCalls: CareerEventInsertRow[] = [];
  await recordCareerEvent('', baseInput(), async (row) => {
    guestCalls.push(row);
  });
  check('guest → insert 呼ばれない（no-op）', guestCalls.length === 0);

  // 未知 feature → insert 呼ばれない。
  const unknownCalls: CareerEventInsertRow[] = [];
  await recordCareerEvent(
    USER,
    baseInput({ feature: 'nope' as CareerEventInput['feature'] }),
    async (row) => {
      unknownCalls.push(row);
    },
  );
  check('未知 feature → insert 呼ばれない', unknownCalls.length === 0);

  // env/client 未設定（既定 adapter・第3引数なし）でも throw しない no-op。
  let threw3 = false;
  try {
    await recordCareerEvent(USER, baseInput({ clientEventId: MSG_ID_1 }));
  } catch {
    threw3 = true;
  }
  check('既定 adapter・env 未設定でも throw しない', threw3 === false);
}

console.log('');
if (failures === 0) {
  console.log('career-event-writer-qa: ALL PASS');
  process.exit(0);
} else {
  console.error(`career-event-writer-qa: ${failures} FAIL`);
  process.exit(1);
}
})();
