// PASSAI 就活版 — GD Production Readiness QA（STEP-GD-31・登録済み・再実行可能）。
//
// 実行:  npx tsx --tsconfig tsconfig.realtime-test.json scripts/gd-qa/production.qa.ts
//        （npm run qa:careerGdProduction）
//
// 役割の分離（既存 qa:careerGd と混同しないこと）:
//   qa:careerGd            … GD の **product 仕様**（お題モード / テーマ入力 / 部屋終了）の回帰。
//   qa:careerGdProduction  … GD を **本番運用できる状態か**の回帰。すなわち
//                            kill switch / Realtime の security 設計 / 切断検知 /
//                            timer の server 権威 / Data Spine 接続 / rate limit / 観測。
//
// 検証の種別（正直に区別する。ここは静的 + 単体であり、実 DB / 実 Realtime は E2E の担当）:
//   [UNIT]   純関数の入出力（閾値・状態遷移・clock drift・prompt 結合）
//   [STATIC] ソース / SQL の構造的検査（gate の網羅・policy の形・publication 対象）
//
// ★ 本 QA が PASS しても「Realtime が実配信されている」ことの証明にはならない。
//   それは tests/e2e/careerGdRealtime.spec.ts（実 DB・複数 client）が担当する。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { evalCareerGdFlag } from '../../lib/careerGd/../careerGdGate/flag';
import {
  deriveGdConnectionState,
  mergeGdConnectionState,
  asGdConnectionState,
  isActiveHumanMember,
  GD_HEARTBEAT_INTERVAL_MS,
  GD_DISCONNECT_AFTER_SEC,
  GD_STALE_AFTER_SEC,
} from '../../lib/careerGd/presence';
import {
  deriveGdSyncMode,
  gdPollIntervalMs,
  isGdSyncModeAlarming,
  GD_POLL_INTERVAL_LIVE_MS,
  GD_POLL_INTERVAL_FALLBACK_MS,
} from '../../lib/careerGd/syncMode';
import { computeGdRemainingSeconds } from '../../hooks/useCareerGdTimer';
import { buildGdCrossFeatureContext } from '../../lib/careerMemory/renderers/gdCrossFeature';
import { getCareerContextPolicy } from '../../lib/careerContext/purpose';
import {
  COMPANY_OFFICIAL_PURPOSES,
  renderCompanyOfficialForPurpose,
} from '../../lib/careerContextRenderers/companyOfficialContext';
// projection が context builder の canonical な置き場（renderer とは別モジュール）。
import { buildCompanyOfficialContext } from '../../lib/careerCompanyOfficial/projection';
import { CAREER_GD_RATE_LIMITS, type RateLimitRule } from '../../lib/rateLimit';

const ROOT = path.resolve(__dirname, '..', '..');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name);
  }
}
function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * TS/TSX からコメントを除去する。
 *
 * ★ 必要な理由: 本 QA の構造検査は「コードがそうなっているか」を見る。
 *   本文コメントに `NEXT_PUBLIC_` や `DROP TABLE` の**説明**が書いてあるだけで
 *   FAIL / PASS が動くと、検査が文章の言い回しに依存してしまい無意味になる。
 *   （逆に、コメントを消し忘れた版で PASS してしまう偽陰性も防ぐ。）
 */
function stripTsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
    .replace(/^[ \t]*\/\/.*$/gm, '')     // full-line line comments
    .replace(/([^:'"\`])\/\/.*$/gm, '$1'); // trailing line comments（URL の // は除外）
}

/** SQL からコメント（-- 行）を除去する。 */
function stripSqlComments(src: string): string {
  return src.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 関数本体だけを切り出す（宣言位置ではなく実行順序を検査するため）。 */
function handlerBody(src: string, method: 'GET' | 'POST'): string {
  const i = src.indexOf(`export async function ${method}(`);
  return i === -1 ? '' : src.slice(i);
}

// ════════════════════════════════════════════════════════════════
// [A] Feature Flag / kill switch
// ════════════════════════════════════════════════════════════════
console.log('\n[A] Feature Flag / kill switch');

// A-1 [UNIT] 受理値は 'true' のみ。未設定は必ず OFF（fail-closed）。
check('A1 unset -> OFF', evalCareerGdFlag(undefined) === false);
check('A1 null -> OFF', evalCareerGdFlag(null) === false);
check('A1 empty -> OFF', evalCareerGdFlag('') === false);
check('A1 "1" -> OFF', evalCareerGdFlag('1') === false);
check('A1 "yes" -> OFF', evalCareerGdFlag('yes') === false);
check('A1 "false" -> OFF', evalCareerGdFlag('false') === false);
check('A1 non-string -> OFF', evalCareerGdFlag(1 as unknown) === false);
check('A1 "true" -> ON', evalCareerGdFlag('true') === true);
check('A1 " TRUE " -> ON', evalCareerGdFlag(' TRUE ') === true);

// A-2 [STATIC] server flag は NEXT_PUBLIC_ を読まない（UI flag が権限に昇格しない）。
{
  const serverFlagRaw = read('lib/careerGdGate/flags.server.ts');
  const serverFlag = stripTsComments(serverFlagRaw);
  check('A2 server flag reads CAREER_GD_ENABLED', serverFlag.includes('process.env.CAREER_GD_ENABLED'));
  // ★ code 上で NEXT_PUBLIC_* を一切読まない（UI flag が実行権限へ昇格しない）。
  check('A2 server flag never reads NEXT_PUBLIC_', !serverFlag.includes('NEXT_PUBLIC_'));
  check('A2 server flag is server-only', serverFlag.includes("import 'server-only'"));
}

// A-3 [STATIC] すべての GD route handler が gate を通る（1 本でも漏れたら FAIL）。
{
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e === 'route.ts') routes.push(p);
    }
  };
  walk(path.join(ROOT, 'app/api/career/gd'));
  check('A3 gd routes found', routes.length >= 20);

  let gatedAll = true;
  let missing = '';
  for (const r of routes) {
    const src = readFileSync(r, 'utf8');
    const handlers = (src.match(/^export async function (GET|POST|PUT|DELETE|PATCH)/gm) ?? []).length;
    const gates = (src.match(/const gdGate = requireCareerGdEnabled\(\);/g) ?? []).length;
    if (handlers === 0 || gates !== handlers) {
      gatedAll = false;
      missing = path.relative(ROOT, r);
    }
  }
  check(`A3 every GD route handler is gated${gatedAll ? '' : ` (missing: ${missing})`}`, gatedAll);
}

// A-4 [STATIC] gate は「body parse / auth / DB / AI より前」に置かれている
//     （＝OFF のとき AI コストも DB write も発生しない）。
{
  // import 宣言の位置ではなく **handler 内の実行順序**を見る。
  const body = stripTsComments(handlerBody(read('app/api/career/gd/room/create/route.ts'), 'POST'));
  const gateAt = body.indexOf('requireCareerGdEnabled()');
  const parseAt = body.indexOf('await req.json()');
  const authAt = body.indexOf('getCareerServerSupabaseClient(');
  const dbAt = body.indexOf('getCareerServiceRoleSupabaseClient(');
  check('A4 gate precedes body parse', gateAt >= 0 && parseAt > gateAt);
  check('A4 gate precedes auth', gateAt >= 0 && authAt > gateAt);
  check('A4 gate precedes service-role DB client', gateAt >= 0 && dbAt > gateAt);
}

// A-5 [STATIC] UI gate は導線を落とすだけ（server flag を読まない）。
{
  const home = stripTsComments(read('app/career/home/page.tsx'));
  check('A5 home imports UI flag', home.includes('isCareerGdUiEnabled'));
  check('A5 home filters gd feature', home.includes("f.key !== 'gd'"));
  // ★ UI は server flag を読まない（client bundle へ server 権限を持ち込まない）。
  check('A5 home does not read server flag', !home.includes('process.env.CAREER_GD_ENABLED'));
}

// ════════════════════════════════════════════════════════════════
// [B] Realtime security（publication / RLS）— SQL の構造検査
// ════════════════════════════════════════════════════════════════
console.log('\n[B] Realtime security (publication / RLS)');
{
  // ★ 説明コメントに引きずられないよう、SQL コメントを除いた **実 DDL** を検査する。
  const sql = stripSqlComments(read('supabase/career_gd_realtime_apply.sql'));

  // B-1 publication に載せる表 / 載せない表。
  check('B1 rooms in publication', sql.includes('ADD TABLE public.career_gd_rooms'));
  check('B1 members in publication', sql.includes('ADD TABLE public.career_gd_room_members'));
  check('B1 messages in publication', sql.includes('ADD TABLE public.career_gd_room_messages'));
  // ★ 本人 FB（results）と待機列（queue）は配信経路へ出さない。
  check('B1 results NOT in publication', !sql.includes('ADD TABLE public.career_gd_room_results'));
  check('B1 match_queue NOT in publication', !sql.includes('ADD TABLE public.career_gd_match_queue'));

  // B-2 membership-scoped SELECT のみ。INSERT/UPDATE/DELETE policy を作らない。
  check('B2 membership helper exists', sql.includes('career_gd_is_room_member'));
  check('B2 helper is SECURITY DEFINER', /career_gd_is_room_member[\s\S]{0,400}SECURITY DEFINER/.test(sql));
  check('B2 helper pins search_path', /career_gd_is_room_member[\s\S]{0,400}SET search_path/.test(sql));
  check('B2 helper requires left_at IS NULL', /career_gd_is_room_member[\s\S]{0,600}left_at IS NULL/.test(sql));
  check('B2 rooms policy is FOR SELECT', /ON public\.career_gd_rooms\s+FOR SELECT TO authenticated/.test(sql));
  check('B2 members policy is FOR SELECT', /ON public\.career_gd_room_members\s+FOR SELECT TO authenticated/.test(sql));
  check('B2 messages policy is FOR SELECT', /ON public\.career_gd_room_messages\s+FOR SELECT TO authenticated/.test(sql));
  check('B2 no FOR INSERT policy', !/FOR INSERT TO authenticated/.test(sql));
  check('B2 no FOR UPDATE policy', !/FOR UPDATE TO authenticated/.test(sql));
  check('B2 no FOR DELETE policy', !/FOR DELETE TO authenticated/.test(sql));
  check('B2 no blanket USING (true)', !/USING \(true\)/.test(sql));

  // B-3 authenticated への GRANT は SELECT のみ（書き込み権限を開けない）。
  const authGrants = sql.match(/GRANT [^;]*TO authenticated/g) ?? [];
  check('B3 authenticated grants exist', authGrants.length >= 3);
  check(
    'B3 authenticated grants are SELECT/USAGE/EXECUTE only',
    // 付与動詞は GRANT の直後にしか現れない。列名（updated_at 等）と取り違えないよう、
    // 「GRANT の直後のトークン」だけを見る。
    authGrants.every((g) => /^GRANT\s+(SELECT|USAGE|EXECUTE)\b/.test(g)),
  );
  check(
    'B3 no write verb granted to authenticated',
    authGrants.every((g) => !/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL PRIVILEGES)\b/.test(g)),
  );

  // B-4 join_code_hash は member にも渡さない（列単位 GRANT から除外）。
  const roomsGrant = sql.match(/GRANT SELECT \(([\s\S]*?)\) ON public\.career_gd_rooms/);
  check('B4 rooms uses column-level GRANT', !!roomsGrant);
  check('B4 join_code_hash excluded from GRANT', !!roomsGrant && !roomsGrant[1].includes('join_code_hash'));

  // B-5 破壊的操作を含まない（再実行安全）。
  check('B5 no DROP TABLE', !/\bDROP TABLE\b/i.test(sql));
  check('B5 no TRUNCATE', !/\bTRUNCATE\b/i.test(sql));
  check('B5 no DELETE FROM', !/\bDELETE FROM\b/i.test(sql));
  check('B5 no ALTER on exam-side tables', !/ALTER TABLE public\.(?!career_gd_)/.test(sql));
  check('B5 idempotent column add', sql.includes('ADD COLUMN IF NOT EXISTS'));

  // B-6 Project B 専用であることが明記されている（Project A へ適用しない）。
  //     これは運用者向けの **文書要件**なので、コメントを含む raw を見るのが正しい。
  const sqlRaw = read('supabase/career_gd_realtime_apply.sql');
  check('B6 documents Project B only', sqlRaw.includes('Project B') && sqlRaw.includes('Project A'));
}

// ════════════════════════════════════════════════════════════════
// [C] Disconnect detection（切断 ≠ 退室）
// ════════════════════════════════════════════════════════════════
console.log('\n[C] Disconnect detection');
{
  const now = Date.parse('2026-08-18T12:00:00.000Z');
  const at = (secAgo: number) => new Date(now - secAgo * 1000).toISOString();

  // C-1 [UNIT] 閾値どおりの状態遷移。
  check('C1 fresh -> online', deriveGdConnectionState(at(5), now) === 'online');
  check('C1 just under disconnect -> online', deriveGdConnectionState(at(GD_DISCONNECT_AFTER_SEC - 1), now) === 'online');
  check('C1 at disconnect -> disconnected', deriveGdConnectionState(at(GD_DISCONNECT_AFTER_SEC), now) === 'disconnected');
  check('C1 just under stale -> disconnected', deriveGdConnectionState(at(GD_STALE_AFTER_SEC - 1), now) === 'disconnected');
  check('C1 at stale -> stale', deriveGdConnectionState(at(GD_STALE_AFTER_SEC), now) === 'stale');

  // C-2 [UNIT] 情報が無いときは online 側へ倒す（誤検知で人を消さない）。
  check('C2 null lastSeen -> online', deriveGdConnectionState(null, now) === 'online');
  check('C2 garbage lastSeen -> online', deriveGdConnectionState('not-a-date', now) === 'online');

  // C-3 [UNIT] grace period が heartbeat 間隔より十分長い（1 回落としただけで切断にしない）。
  check('C3 disconnect grace >= 3 heartbeats', GD_DISCONNECT_AFTER_SEC * 1000 >= GD_HEARTBEAT_INTERVAL_MS * 3);
  check('C3 stale > disconnect', GD_STALE_AFTER_SEC > GD_DISCONNECT_AFTER_SEC);

  // C-4 [UNIT] merge は「より悪い方」を採る（sweep 済みの stale を online で塗り潰さない）。
  check('C4 persisted stale wins', mergeGdConnectionState('stale', 'online') === 'stale');
  check('C4 derived worse wins', mergeGdConnectionState('online', 'disconnected') === 'disconnected');
  check('C4 both online', mergeGdConnectionState('online', 'online') === 'online');
  check('C4 null persisted falls back', mergeGdConnectionState(null, 'disconnected') === 'disconnected');

  // C-5 [UNIT] 未知値は online へ正規化（DDL 未適用で列が無い環境の degrade）。
  check('C5 undefined -> online', asGdConnectionState(undefined) === 'online');
  check('C5 unknown -> online', asGdConnectionState('bogus') === 'online');
  check('C5 stale kept', asGdConnectionState('stale') === 'stale');

  // C-6 [UNIT] ★ disconnect ≠ leave。切断していても「在席する人間参加者」の判定は変わらない
  //     （既存の満員判定・AI 補完人数・評価対象を接続状態で壊さない）。
  check('C6 stale member still counts as active human', isActiveHumanMember({ isAi: false, leftAt: null }) === true);
  check('C6 left member does not count', isActiveHumanMember({ isAi: false, leftAt: '2026-08-18T00:00:00Z' }) === false);
  check('C6 ai never counts', isActiveHumanMember({ isAi: true, leftAt: null }) === false);
}

// C-7 [STATIC] heartbeat は left_at を書き換えない（切断で退室させない）。
{
  const sql = stripSqlComments(read('supabase/career_gd_realtime_apply.sql'));
  const hb = sql.slice(sql.indexOf('FUNCTION public.career_gd_heartbeat'), sql.indexOf('career_gd_sweep_presence'));
  check('C7 heartbeat never sets left_at', !/SET[\s\S]*left_at\s*=/.test(hb));
  check('C7 heartbeat only touches live rows', hb.includes('left_at IS NULL'));

  const sweep = sql.slice(sql.indexOf('FUNCTION public.career_gd_sweep_presence'));
  check('C7 sweep never sets left_at', !/SET\s+left_at\s*=/.test(sweep));

  // ★ クライアントから participantId を受け取らない = 他人の presence を更新できない。
  //   （コメントでの言及ではなく、コード上に参照が無いことを確認する）
  const route = stripTsComments(read('app/api/career/gd/room/[roomId]/heartbeat/route.ts'));
  check('C7 heartbeat route does not accept participantId from client', !route.includes('participantId'));
  check('C7 heartbeat scopes update by session user id', route.includes('p_user_id: auth.userId'));
}

// ════════════════════════════════════════════════════════════════
// [D] Timer authority（clock drift / server enforcement）
// ════════════════════════════════════════════════════════════════
console.log('\n[D] Timer authority');
{
  const startedAt = '2026-08-18T12:00:00.000Z';
  const startMs = Date.parse(startedAt);
  const limit = 900; // 15 分

  // D-1 [UNIT] offset なしの基本計算（従来挙動の維持）。
  const base = computeGdRemainingSeconds({ startedAt, timeLimitSec: limit, localNowMs: startMs + 60_000 });
  check('D1 baseline remaining', base.remainingSeconds === 840);

  // D-2 [UNIT] ★ clock drift 補正の本体。
  //     端末時計が 5 分進んでいる / 遅れている 2 台でも、offset 補正後の残り時間は一致する。
  const trueNow = startMs + 60_000;
  const fastLocal = trueNow + 300_000; // 5 分進んだ端末
  const slowLocal = trueNow - 300_000; // 5 分遅れた端末
  const fast = computeGdRemainingSeconds({
    startedAt,
    timeLimitSec: limit,
    localNowMs: fastLocal,
    clockOffsetMs: trueNow - fastLocal, // serverNow - localNow
  });
  const slow = computeGdRemainingSeconds({
    startedAt,
    timeLimitSec: limit,
    localNowMs: slowLocal,
    clockOffsetMs: trueNow - slowLocal,
  });
  check('D2 skewed-fast client matches truth', fast.remainingSeconds === 840);
  check('D2 skewed-slow client matches truth', slow.remainingSeconds === 840);
  check('D2 both clients agree', fast.remainingSeconds === slow.remainingSeconds);

  // D-3 [UNIT] 補正しなければズレる（＝この QA が実際に何かを守っていることの反証テスト）。
  const uncorrected = computeGdRemainingSeconds({ startedAt, timeLimitSec: limit, localNowMs: fastLocal });
  check('D3 uncorrected client would disagree', uncorrected.remainingSeconds !== 840);

  // D-4 [UNIT] 期限切れ・未開始の境界。
  const expired = computeGdRemainingSeconds({ startedAt, timeLimitSec: limit, localNowMs: startMs + limit * 1000 });
  check('D4 expiry at exactly limit', expired.remainingSeconds === 0);
  const notStarted = computeGdRemainingSeconds({ startedAt: null, timeLimitSec: limit, localNowMs: startMs });
  check('D4 not started -> full limit', notStarted.remainingSeconds === limit && notStarted.hasStarted === false);
}

// D-5 [STATIC] server 側の期限強制が「DB now()」で行われる（クライアント時計に依存しない）。
{
  const sql = stripSqlComments(read('supabase/career_gd_realtime_apply.sql'));
  const fn = sql.slice(sql.indexOf('FUNCTION public.career_gd_finish_if_expired'));
  check('D5 expiry uses DB now()', fn.includes('<= now()'));
  check('D5 expiry is race-safe (status guard)', fn.includes("r.status = 'active'"));
  check('D5 expiry sets finished', fn.includes("status = 'finished'"));

  // D-6 [STATIC] 発言 / AI 発言が期限を越えて通らない。
  //     ★ import 行の存在では PASS にしない。**handler 内で実際に await 呼び出しがある**ことと、
  //       期限切れ時に投稿を拒否していることの両方を見る（import だけ残して呼び出しを消す
  //       退行を検出するため）。
  const msgBody = stripTsComments(handlerBody(read('app/api/career/gd/room/[roomId]/messages/route.ts'), 'POST'));
  check('D6 message POST calls expiry enforcement', /await finishRoomIfExpired\(/.test(msgBody));
  check('D6 message POST rejects after expiry', msgBody.includes('ROOM_TIME_EXPIRED'));
  const aiBody = stripTsComments(handlerBody(read('app/api/career/gd/room/[roomId]/ai-turn/route.ts'), 'POST'));
  check('D6 ai-turn calls expiry enforcement', /await finishRoomIfExpired\(/.test(aiBody));
  check('D6 ai-turn rejects after expiry', aiBody.includes('ROOM_TIME_EXPIRED'));
  const aiExpiryAt = aiBody.indexOf('finishRoomIfExpired');
  const aiCallAt = aiBody.indexOf('anthropic.messages.create');
  check('D6 expiry check precedes anthropic call', aiExpiryAt >= 0 && aiCallAt > aiExpiryAt);

  // D-7 [STATIC] host 不在でも終わる（cron が全体を回収する）。
  const cron = read('app/api/cron/gd-cleanup/route.ts');
  check('D7 cron finishes expired rooms', cron.includes('career_gd_finish_expired_all'));
  check('D7 cron sweeps presence', cron.includes('career_gd_sweep_presence_all'));
}

// ════════════════════════════════════════════════════════════════
// [E] Realtime fallback / sync mode
// ════════════════════════════════════════════════════════════════
console.log('\n[E] Realtime fallback / sync mode');
{
  // E-1 [UNIT] モード導出。
  check('E1 connected -> live', deriveGdSyncMode('connected', 0) === 'live');
  check('E1 disconnected -> degraded', deriveGdSyncMode('disconnected', 0) === 'degraded');
  check('E1 connecting -> degraded', deriveGdSyncMode('connecting', 0) === 'degraded');
  check('E1 idle -> degraded', deriveGdSyncMode('idle', 0) === 'degraded');
  check('E1 many failures -> offline', deriveGdSyncMode('connected', 3) === 'offline');

  // E-2 [UNIT] ★ Realtime が落ちても polling で継続できるので degraded は「異常」ではない。
  check('E2 degraded is not alarming', isGdSyncModeAlarming('degraded') === false);
  check('E2 live is not alarming', isGdSyncModeAlarming('live') === false);
  check('E2 offline is alarming', isGdSyncModeAlarming('offline') === true);

  // E-3 [UNIT] Realtime 主・polling 従。ただし polling は止めない（復帰検知のため）。
  check('E3 live polls slower', gdPollIntervalMs('live') === GD_POLL_INTERVAL_LIVE_MS);
  check('E3 degraded polls at legacy 3s', gdPollIntervalMs('degraded') === GD_POLL_INTERVAL_FALLBACK_MS);
  check('E3 offline still polls', gdPollIntervalMs('offline') > 0);
  check('E3 live interval is slower than fallback', GD_POLL_INTERVAL_LIVE_MS > GD_POLL_INTERVAL_FALLBACK_MS);
  check('E3 fallback keeps the existing 3s behaviour', GD_POLL_INTERVAL_FALLBACK_MS === 3000);
}

// E-4 [STATIC] Realtime を「正本」にしていない（実データは API 経由のまま）。
{
  const rt = read('lib/careerGd/realtimeRoom.ts');
  check('E4 realtime is a signal, not the source of truth', rt.includes('onSyncSignal'));
  const msgHook = read('hooks/useCareerGdMessages.ts');
  check('E4 messages still posted via server API', msgHook.includes('Realtime は正本にしない'));
  // dedupe: optimistic + realtime + poll が重なっても二重表示しない鍵が明示されている。
  check('E4 dedupe key documented', msgHook.includes('client_msg_id') && msgHook.includes('重複除去'));
}

// ════════════════════════════════════════════════════════════════
// [F] Data Spine 接続
// ════════════════════════════════════════════════════════════════
console.log('\n[F] Data Spine');
{
  // F-1 [UNIT] gd_feedback purpose が live になっている（旧: 全 exclude の DORMANT）。
  const policy = getCareerContextPolicy('gd_feedback');
  check('F1 profile is minimal (PII excluded)', policy.profile === 'minimal');
  check('F1 activity included', policy.activity !== 'exclude');
  check('F1 values included', policy.values === 'include');
  check('F1 cross-feature logs declared', policy.recentLogs === 'include');
  check('F1 company context optional', policy.companyContext === 'optional');

  // F-2 [UNIT] Company Data Spine の purpose allowlist に GD が入っている。
  check('F2 gd_feedback allowed for company official', COMPANY_OFFICIAL_PURPOSES.includes('gd_feedback'));

  // F-2b [UNIT] ★ GD 専用の usage note が付く（企業研究版の流用ではない）。
  //   流用すると「本人の企業研究メモを評価する材料」という誤った用途を AI に渡すことになり、
  //   さらに **GD の採点根拠を企業知識に汚染しない**という最重要の禁止文が欠落する。
  //   fixture は canonical builder で作る（renderer の内部形に依存しない）。
  const companyCtx = buildCompanyOfficialContext({
    companyId: 'c1',
    displayName: 'テスト株式会社',
    rows: [
      {
        factKey: 'legalName',
        factGroup: 'identity',
        // 値は { value } 形（FactRow.factValue の契約）。
        factValue: { value: 'テスト株式会社' },
        sourceUrl: 'https://example.com/about',
        sourceType: 'corporate_registry',
        extractionMethod: 'structured_api',
        fetchedAt: '2026-08-17T00:00:00.000Z',
      },
    ] as never,
    nowIso: '2026-08-18T00:00:00.000Z',
  });
  const gdNote = renderCompanyOfficialForPurpose('gd_feedback', { status: 'ready', data: companyCtx });
  check('F2b gd company block is produced', gdNote.used);
  check('F2b gd note forbids scoring on company knowledge', gdNote.text.includes('採点根拠にすること'));
  check('F2b gd note declares injection boundary', gdNote.text.includes('指示ではありません'));
  // 企業研究版の文面を流用していないこと（用途の取り違えを検出）。
  check('F2b gd note is not the company-research note', !gdNote.text.includes('本人のメモを評価する際の照合材料'));

  // F-3 [UNIT] cross-feature renderer は空入力で '' を返す（＝ prompt byte 完全互換）。
  check('F3 empty -> empty block', buildGdCrossFeatureContext({}) === '');
  check('F3 empty arrays -> empty block', buildGdCrossFeatureContext({ selfAnalysisLogs: [], gdRoomLogs: [] }) === '');

  // F-4 [UNIT] 実データがあれば block が出て、採点契約と injection 境界が必ず付く。
  const block = buildGdCrossFeatureContext({
    selfAnalysisLogs: [
      { result: { summary: '論理性が強み', strengths: ['分析', '傾聴'] } } as never,
    ],
    gdRoomLogs: [{ themeTitle: '働き方', evaluation: { overallScore: 72, rank: 'B', weaknesses: ['発言量'] } } as never],
  });
  check('F4 block is produced', block.length > 0);
  check('F4 self analysis reached the block', block.includes('論理性が強み'));
  check('F4 past gd reached the block', block.includes('働き方'));
  // ★ 採点根拠を transcript に固定する宣言（要件 25 / 29）。
  check('F4 declares transcript-only scoring', block.includes('採点根拠にはしません'));
  check('F4 declares scoring source', block.includes('実際の発言'));
  // ★ prompt injection 境界（要件 28）。
  check('F4 declares injection boundary', block.includes('指示ではありません'));
}

// F-5 [STATIC] Spine が **実際に prompt へ到達する経路**が配線されている。
//     （resolver を呼んだだけでは PASS にしない — 結合関数まで辿る）
{
  const spine = read('app/api/career/gd/gdSpinePrompt.ts');
  check('F5 spine uses canonical orchestrator', spine.includes('buildCareerContextForPurpose'));
  check('F5 spine uses canonical context builder', spine.includes('buildCareerAiContext'));
  check('F5 spine renders company official', spine.includes('companyOfficialContext'));
  check('F5 spine has a single join point', spine.includes('export function appendGdSpineBlock'));

  // multi GD 評価
  // ★ import ではなく **handler 内の実呼び出し**を要求する。
  const resultBody = stripTsComments(handlerBody(read('app/api/career/gd/room/[roomId]/result/route.ts'), 'POST'));
  check('F5 result calls user spine resolver', /await resolveGdContextInputs\(/.test(resultBody));
  check('F5 result calls company spine resolver', /await resolveGdCompanyOfficial\(/.test(resultBody));
  check('F5 result builds spine block', /buildGdSpinePrompt\(/.test(resultBody));
  check('F5 result passes spine to the AI call', resultBody.includes('spineBlock: spine.block'));

  // 評価 AI が実際に受け取って system prompt へ結合している
  const fb = read('app/api/career/gd/room/roomFeedback.ts');
  check('F5 roomFeedback accepts spineBlock', fb.includes('spineBlock?: string'));
  check('F5 roomFeedback appends it to system', fb.includes('appendGdSpineBlock(buildRoomFeedbackSystem()'));

  // solo 評価 / お題生成
  const solo = read('app/api/career/gd/feedback/route.ts');
  check('F5 solo feedback wires spine', solo.includes('appendGdSpineBlock(buildFeedbackSystem()'));
  const theme = read('app/api/career/gd/theme/route.ts');
  check('F5 theme wires spine', theme.includes('appendGdSpineBlock(buildThemeSystem()'));
}

// F-6 [STATIC] 決定論スコアリングが Spine で壊れていない（要件 29）。
{
  const fb = read('app/api/career/gd/room/roomFeedback.ts');
  check('F6 overall score still deterministic', fb.includes('export function computeOverallScore'));
  check('F6 rank still deterministic', fb.includes('export function toRank'));
  check('F6 comm grade still deterministic', fb.includes('export function computeCommunicationGrade'));
  check('F6 quote verification retained', fb.includes('export function verifyQuotes'));
  // 決定論関数の入力は axisScores のみ（spine が総合点へ流れ込む経路が無い）。
  check('F6 computeOverallScore takes only axis scores', /export function computeOverallScore\(axis: CareerGdAxisScores\)/.test(fb));
}

// ════════════════════════════════════════════════════════════════
// [G] Rate limit / security
// ════════════════════════════════════════════════════════════════
console.log('\n[G] Rate limit / security');
{
  // G-1 [UNIT] join-code 総当り系は fail-closed（store 障害で上限が消えない）。
  check('G1 invite join is fail-closed', CAREER_GD_RATE_LIMITS.inviteJoin.failClosed === true);
  // 同じ理由で lobby join も総当り対象。ただし公開ロビーは room 一覧が見えている前提なので
  // 秘匿値の総当りにはならず、可用性を優先して fail-open のままとする（意図的な差）。
  // G-2 [UNIT] 可用性優先でよいものは fail-open のまま（Redis 障害で GD 全停止にしない）。
  //     `as const satisfies` で narrow されるため、宣言していない rule では
  //     failClosed が型上存在しない。RateLimitRule へ広げてから読む。
  const asRule = (r: RateLimitRule): RateLimitRule => r;
  check('G2 message is fail-open', asRule(CAREER_GD_RATE_LIMITS.message).failClosed !== true);
  check('G2 heartbeat is fail-open', asRule(CAREER_GD_RATE_LIMITS.heartbeat).failClosed !== true);
  check('G2 ai-turn is fail-open', asRule(CAREER_GD_RATE_LIMITS.aiTurn).failClosed !== true);
  // G-3 [UNIT] AI 課金に直結する route に上限がある。
  check('G3 ai-turn limited', !!CAREER_GD_RATE_LIMITS.aiTurn);
  check('G3 result limited', !!CAREER_GD_RATE_LIMITS.result);
  check('G3 ai-turn stricter than message', CAREER_GD_RATE_LIMITS.aiTurn.windows[0].limit < CAREER_GD_RATE_LIMITS.message.windows[0].limit);
  // G-4 [UNIT] heartbeat 上限は正常クライアント（15 秒間隔 = 4/分）を弾かない。
  check('G4 heartbeat limit allows normal cadence', CAREER_GD_RATE_LIMITS.heartbeat.windows[0].limit >= (60_000 / GD_HEARTBEAT_INTERVAL_MS) * 3);
}

// G-5 [STATIC] 観測に PII / 秘密を出さない。
{
  const obs = read('app/api/career/gd/gdObservability.ts');
  check('G5 observability delegates to canonical capture', obs.includes('captureRouteException'));
  check('G5 observability documents forbidden fields', obs.includes('join_code_hash') && obs.includes('transcript'));
  // ログ行に埋め込めるのは route / code / status のみ。
  check('G5 log line has no free-form payload', /route=\$\{route\} code=\$\{code\} status=\$\{status \?\? '-'\}/.test(obs));

  const code = read('app/api/career/gd/room/roomCode.ts');
  check('G5 join code module stays server-only', code.includes("import 'server-only'"));

  // 主要 route が観測に接続されている。
  for (const rel of [
    'app/api/career/gd/room/[roomId]/route.ts',
    'app/api/career/gd/room/[roomId]/messages/route.ts',
    'app/api/career/gd/room/[roomId]/ai-turn/route.ts',
    'app/api/career/gd/room/[roomId]/result/route.ts',
    'app/api/career/gd/room/[roomId]/heartbeat/route.ts',
  ]) {
    check(`G5 observability wired: ${path.basename(path.dirname(rel))}`, read(rel).includes('reportGdFailure'));
  }
}

// ════════════════════════════════════════════════════════════════
// [H] 非破壊（既存 Online MVP architecture の温存）
// ════════════════════════════════════════════════════════════════
console.log('\n[H] Non-regression of the existing architecture');
{
  // H-1 API ゲートウェイ方式が維持されている（クライアントが room 表を直接書かない）。
  const roomGet = read('app/api/career/gd/room/[roomId]/route.ts');
  check('H1 room API still uses service role', roomGet.includes('getGdAdmin'));
  check('H1 room API still checks membership', roomGet.includes('NOT_A_MEMBER'));

  // H-2 host authorization が server 側に残っている。
  check('H2 start still host-only', read('app/api/career/gd/room/[roomId]/start/route.ts').includes('NOT_HOST'));
  check('H2 finish still host-only', read('app/api/career/gd/room/[roomId]/finish/route.ts').includes('NOT_HOST'));

  // H-3 join code は HMAC のまま・平文保存しない。
  const code = read('app/api/career/gd/room/roomCode.ts');
  check('H3 join code still HMAC', code.includes("createHmac('sha256'"));
  check('H3 pepper unset -> null (fail closed)', code.includes('return null'));

  // H-4 冪等・race 保護が残っている。
  check('H4 start race guard kept', read('app/api/career/gd/room/[roomId]/start/route.ts').includes(".eq('status', 'waiting')"));
  check('H4 finish race guard kept', read('app/api/career/gd/room/[roomId]/finish/route.ts').includes(".eq('status', 'active')"));
  check('H4 message idempotency kept', read('app/api/career/gd/room/roomMessages.ts').includes('client_msg_id') || read('app/api/career/gd/room/roomMessages.ts').includes('clientMsgId'));

  // H-5 音声 / WebRTC を勝手に入れていない（今回の非目標）。
  for (const rel of [
    'app/career/gd/room/[roomId]/page.tsx',
    'lib/careerGd/realtimeRoom.ts',
    'hooks/useCareerGdHeartbeat.ts',
  ]) {
    const src = stripTsComments(read(rel));
    check(`H5 no WebRTC in ${path.basename(rel)}`, !/RTCPeerConnection|getUserMedia|LiveKit|Twilio|Agora|MediaRecorder/i.test(src));
  }
}

console.log(`\nGD production readiness QA: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
