/**
 * career generation job — server-authoritative idempotency（STEP-CAREER-GENJOB-01）。
 *
 * 正式な idempotency key は **サーバー側でのみ** 算出する。HTTP body から渡された key は
 * DB key として信用しない（client hash は連打防止 fingerprint 用途に限る）。
 *
 * key の材料（要件どおり）:
 *   authenticated user ID / feature / operation /
 *   normalized profile・activity・values・conversation revision /
 *   prompt revision / model revision / output schema revision
 *
 * 保存するのは hash revision のみ。raw input（profile/activity/values/conversation 本文）は
 * DB にも key にも平文で残さない。canonicalize は key 順非依存にして、
 * 連打・reload・複数タブでの key ゆれを防ぐ。
 *
 * server 実行前提（node:crypto）。client bundle からは import しない
 *   （client 側 fingerprint は WebCrypto の別ユーティリティを使う）。
 */

import { createHash } from 'node:crypto';

import type { CareerSelfAnalysisTurn } from '@/types/careerSelfAnalysis';
import type { GenerationJobIdentity } from './types';

/** key 順非依存の canonical JSON。オブジェクトはキー昇順・配列は順序保持。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    // undefined は JSON.stringify で欠落するため null に寄せて安定化。
    return value === undefined ? null : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => canonicalize(v));
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = canonicalize(obj[key]);
  }
  return out;
}

/** SHA-256 hex（server）。lowercase / 64 桁。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 任意入力の正規化 revision（canonical JSON → SHA-256）。raw は返さない。 */
export function computeRevision(value: unknown): string {
  return sha256Hex(stableStringify(value ?? null));
}

/**
 * 深掘り対話を revision 用に正規化する（role/content のみ・順序保持・壊れた要素は除去）。
 * route.ts の normalizeConversation と同じ意味の正規化を revision 側でも行い、
 * 表示ゆれ（余分なキー等）で key が変わらないようにする。
 */
export function normalizeConversationForRevision(
  value: unknown,
): CareerSelfAnalysisTurn[] {
  if (!Array.isArray(value)) return [];
  const out: CareerSelfAnalysisTurn[] = [];
  for (const t of value) {
    if (!t || typeof t !== 'object') continue;
    const role = (t as { role?: unknown }).role;
    const raw = (t as { content?: unknown }).content;
    const content = typeof raw === 'string' ? raw.trim() : '';
    if ((role === 'question' || role === 'answer') && content) {
      out.push({ role, content });
    }
  }
  return out;
}

export interface SelfAnalysisIdempotencyInput {
  userId: string;
  feature: string;
  operation: string;
  profile: unknown;
  activity: unknown;
  values: unknown;
  conversation: unknown;
  promptRevision: string;
  outputSchemaRevision: string;
  model: string;
}

/**
 * 自己分析まとめ生成の server-authoritative identity を作る。
 * 返すのは hash revision のみ（raw input は保持しない）。
 */
export function buildSelfAnalysisIdentity(
  input: SelfAnalysisIdempotencyInput,
): GenerationJobIdentity {
  const profileRev = computeRevision(input.profile ?? null);
  const activityRev = computeRevision(input.activity ?? null);
  const valuesRev = computeRevision(input.values ?? null);
  const conversationRev = computeRevision(
    normalizeConversationForRevision(input.conversation),
  );

  // 保存用の統合 input revision（raw は含まない）。
  const inputRevision = sha256Hex(
    stableStringify({ profileRev, activityRev, valuesRev, conversationRev }),
  );

  // 正式 idempotency key（user 所有 + 全 revision を反映）。
  const idempotencyKey = sha256Hex(
    stableStringify([
      'career-generation-job/v1',
      input.userId,
      input.feature,
      input.operation,
      profileRev,
      activityRev,
      valuesRev,
      conversationRev,
      input.promptRevision,
      input.model,
      input.outputSchemaRevision,
    ]),
  );

  return {
    idempotencyKey,
    inputRevision,
    promptRevision: input.promptRevision,
    outputSchemaRevision: input.outputSchemaRevision,
    model: input.model,
  };
}
