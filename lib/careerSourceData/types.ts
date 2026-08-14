// PASSAI CAREER — Layer 1 Source Data server read の型・定数（NEXT-2 / Data Spine）。
//
// 純粋な型・定数のみ（I/O / env / Supabase 非依存）。server reader と QA が共有する。

import type { CareerProfile } from '@/types/careerProfile';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';
import type { CareerEsLog } from '@/types/careerEs';
import type { CareerInterviewResult } from '@/types/careerInterview';
import type { CareerMatchingLog } from '@/types/careerMatching';
import type { CareerCompanyResearchLog } from '@/types/careerCompanyResearch';
import type { CareerPresentationResult } from '@/types/careerPresentation';
import type { CareerConsultationThread } from '@/types/careerConsultation';
import type { CareerGdRoomLog } from '@/types/careerGd';

// server 側で読める Layer 1 Source の種別（＝Personal Memory section の由来 Source）。
export type CareerSourceKind =
  | 'profile'
  | 'activity'
  | 'values'
  | 'self_analysis'
  | 'es'
  | 'interview'
  // Batch 2: cross-feature bridge 退役のために追加した kind。
  | 'matching'
  | 'company_research'
  | 'presentation'
  | 'consultation'
  // Closure Batch（`D-S10`）: **server-authoritative** source（authority class 2）。
  // 他 kind と違い client canonical の mirror ではなく、**server が著者**である。
  | 'gd_room';

export const CAREER_SOURCE_KINDS = [
  'profile',
  'activity',
  'values',
  'self_analysis',
  'es',
  'interview',
  'matching',
  'company_research',
  'presentation',
  'consultation',
  'gd_room',
] as const satisfies readonly CareerSourceKind[];

// ── Source authority class（`D-S10`）────────────────────────────────
//
// Class 1 — Device-canonical + mirrored:
//   canonical は端末の localStorage。Supabase は mirror。したがって server が読んだ内容が
//   要求端末の canonical と一致する保証が無く、**Source-Sync claim による負の安全ゲート**が要る。
//
// Class 2 — Server-authoritative:
//   **server（route）が著者**であり、client 側の copy は表示用 cache にすぎない。
//   この場合 client canonical という概念が無いため Source-Sync を適用する意味が無く、
//   適用すると「client の cache が古い＝server の正しいデータを使えない」という
//   **逆向きの誤り**になる。authority は `authenticated owner + owner-scoped RLS + server state`。
//
// ★ Class 2 でも canary gate（purpose opt-in AND canary user）は **同じように必要**。
//   免除されるのは Source-Sync verification だけで、authorization は免除されない。
export type CareerSourceAuthorityClass = 'device_canonical_mirrored' | 'server_authoritative';

export const CAREER_SOURCE_AUTHORITY: Readonly<
  Record<CareerSourceKind, CareerSourceAuthorityClass>
> = {
  profile: 'device_canonical_mirrored',
  activity: 'device_canonical_mirrored',
  values: 'device_canonical_mirrored',
  self_analysis: 'device_canonical_mirrored',
  es: 'device_canonical_mirrored',
  interview: 'device_canonical_mirrored',
  matching: 'device_canonical_mirrored',
  company_research: 'device_canonical_mirrored',
  presentation: 'device_canonical_mirrored',
  consultation: 'device_canonical_mirrored',
  // career_gd_room_results は app/api/career/gd/room/[roomId]/result/route.ts が
  // (room_id, user_id) で upsert する **server 著作**データ。client は履歴表示用に持つだけ。
  gd_room: 'server_authoritative',
};

/** Source-Sync（client claim）による検証が必要な kind か（Class 1 のみ true）。 */
export function requiresSourceSync(kind: CareerSourceKind): boolean {
  return CAREER_SOURCE_AUTHORITY[kind] === 'device_canonical_mirrored';
}

// ★ **意図的に server-readable にしていない** kind と理由（Closure Batch で再確認済み）:
//   - `gd`（ソロ GD / localStorage key `careerGdResults`）: Supabase table も mirror module も
//     **存在しない**（`supabase/*.sql` の career_* 全 table・`lib/supabase/career*.ts` 全 module を
//     走査して確認）。server から読む authoritative representation が無い。
//     → **structural bridge**（`D-S11`。architecture debt として STATE に明記）。

// table 名（DDL・client mirror と一致させる）。
export const CAREER_SOURCE_TABLES: Readonly<Record<CareerSourceKind, string>> = {
  profile: 'career_profiles',
  activity: 'career_activities',
  values: 'career_values',
  self_analysis: 'career_self_analysis_results',
  es: 'career_es_logs',
  interview: 'career_interview_results',
  matching: 'career_matching_results',
  company_research: 'career_company_research_logs',
  presentation: 'career_presentation_results',
  consultation: 'career_consultation_threads',
  gd_room: 'career_gd_room_results',
};

// 履歴系 Source の 1 request あたり read 上限。
//   ★ 上限に達した Source は `truncated` として扱い、その Source から導いた revision を
//     **freshness の権威にしない**（sourceCount が実体と一致しない可能性があるため）。
//     「読めた範囲で fresh と断定する」ことはしない（fail-open で Memory 不使用へ倒す）。
export const CAREER_SOURCE_LOG_MAX_ROWS = 200;

// 1 request の Source read 全体のソフト上限（超過は打ち切って error 扱い＝fail-open）。
export const CAREER_SOURCE_READ_SOFT_TIMEOUT_MS = 1500;

// 読み出した Layer 1 Source（domain 型のまま。PII 除去は Layer 2 projection の責務）。
export type CareerSourceBundle = {
  profile: CareerProfile | null;
  activity: CareerActivity | null;
  values: CareerValues | null;
  selfAnalysisLogs: CareerSelfAnalysisLog[];
  esLogs: CareerEsLog[];
  interviewResults: CareerInterviewResult[];
  // Batch 2。
  matchingLogs: CareerMatchingLog[];
  companyResearchLogs: CareerCompanyResearchLog[];
  presentationResults: CareerPresentationResult[];
  consultationThreads: CareerConsultationThread[];
  // Closure Batch: server-authoritative（Class 2）。owner-scoped RLS で自分の行だけが返る。
  gdRoomLogs: CareerGdRoomLog[];
};

export const EMPTY_CAREER_SOURCE_BUNDLE: CareerSourceBundle = {
  profile: null,
  activity: null,
  values: null,
  selfAnalysisLogs: [],
  esLogs: [],
  interviewResults: [],
  matchingLogs: [],
  companyResearchLogs: [],
  presentationResults: [],
  consultationThreads: [],
  gdRoomLogs: [],
};

// 1 Source の read 結果状態。
//   ok        : 読めた（行が無い場合も ok。空 = 「Source が空」という確定情報）。
//   truncated : 上限まで読めたが全件ではない可能性がある（revision を権威にしない）。
//   error     : table missing / network / RLS 拒否等。revision を権威にしない。
//   skipped   : 要求されなかった。
export type CareerSourceReadStatus = 'ok' | 'truncated' | 'error' | 'skipped';

// 観測用の安全 metadata のみ（本文 / UUID / env / raw error を含めない）。
export type CareerSourceReadMeta = {
  // 認証・env・gate の総合結果。
  //   unauthorized: 認証は通ったが **呼び出し側の gate（canary allowlist 等）が許可しなかった**。
  //     この場合 table read は 1 回も行わない（I/O ゼロ）。
  outcome: 'skipped' | 'unauthenticated' | 'unauthorized' | 'ok' | 'error';
  // Source 別の read 状態。
  statuses: Readonly<Record<CareerSourceKind, CareerSourceReadStatus>>;
  // 全体の所要時間（観測用。DI 可能な now から算出）。
  durationMs: number | null;
  // soft timeout（CAREER_SOURCE_READ_SOFT_TIMEOUT_MS）で打ち切ったか。
  //   ★ 観測専用。判断は outcome/statuses のみで行う（timeout は outcome:'error' に写像する）。
  //   optional にして既存 consumer / QA の形を壊さない。
  softTimeout?: boolean;
};

export type CareerSourceReadOutcome = {
  bundle: CareerSourceBundle;
  meta: CareerSourceReadMeta;
};

/** 「その Source から導いた revision を freshness の権威にしてよいか」。ok のみ true。 */
export function isSourceRevisionAuthoritative(status: CareerSourceReadStatus): boolean {
  return status === 'ok';
}

export function emptySourceStatuses(): Record<CareerSourceKind, CareerSourceReadStatus> {
  return {
    profile: 'skipped',
    activity: 'skipped',
    values: 'skipped',
    self_analysis: 'skipped',
    es: 'skipped',
    interview: 'skipped',
    matching: 'skipped',
    company_research: 'skipped',
    presentation: 'skipped',
    consultation: 'skipped',
    gd_room: 'skipped',
  };
}
