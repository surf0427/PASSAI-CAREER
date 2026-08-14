// PASSAI CAREER — consent purpose の **単一 typed registry**（Collective Intelligence Closure / `D-C5`）。
//
// 問題（Closure 監査で確認）:
//   consent scope の語彙は `lib/careerAggregate/policy.ts`（＝Layer 4）に定義されており、
//   `lib/careerConsent/*` がそこから import していた。つまり
//   **consent が Layer 4 に依存する**という層の逆転があった。
//   Layer 5 の consent（`company_knowledge_contribution`）まで Layer 4 の module 経由で
//   参照するのは、purpose 分離という本来の設計意図と噛み合わない。
//
// 本 module は語彙を **中立な位置**へ集約し、purpose 分離をコードで固定する。
//   ★ 既存の `CONSENT_SCOPES` は後方互換のため残す（本 module から再輸出しない。
//     依存の向きを反転させないため、既存 module 側は触らない）。
//
// Human 指示 §25 / §26:
//   - personal optimization / aggregate contribution / company knowledge sharing を
//     **同じ consent として扱わない**
//   - missing / unknown / invalid / outdated unsupported version は **NOT CONSENTED**
//
// pure / deterministic / never-throw。I/O・env 非依存。

import type { ConsentScope } from '@/types/careerAggregate';

// ── purpose family（同一視してはいけない 3 系統）─────────────────────
export type ConsentPurposeFamily =
  /** 本人へのサービス提供そのもの（Personal Optimization）。 */
  | 'personal_optimization'
  /** 匿名 aggregate への寄与（Layer 4）。 */
  | 'aggregate_contribution'
  /** 企業集合知への明示共有（Layer 5）。 */
  | 'company_knowledge_sharing';

export const CONSENT_PURPOSE_FAMILIES: readonly ConsentPurposeFamily[] = [
  'personal_optimization',
  'aggregate_contribution',
  'company_knowledge_sharing',
];

export type ConsentPurposeEntry = {
  scope: ConsentScope;
  family: ConsentPurposeFamily;
  /** 明示 opt-in が必要か（false = サービス提供に不可欠な処理）。 */
  requiresExplicitOptIn: boolean;
  /** 既定状態（**すべて deny**。true になる entry は存在しない）。 */
  defaultGranted: false;
  /** 撤回可能か。 */
  revocable: boolean;
  /** この scope が到達を許す層。 */
  target: 'personal_context' | 'aggregate' | 'shared_knowledge';
  /** サポートする policy version（ここに無い version は unsupported = deny）。 */
  supportedVersions: readonly number[];
  note: string;
};

// ── registry（唯一の source of truth）───────────────────────────────
//
// ★ `defaultGranted` は型レベルで `false` に固定してある。
//   「既定で同意済み」という entry を **書けない**（Human 指示 §26 の構造的保証）。
const ENTRIES: readonly ConsentPurposeEntry[] = [
  {
    scope: 'personal_service_processing',
    family: 'personal_optimization',
    requiresExplicitOptIn: false,
    defaultGranted: false,
    revocable: true,
    target: 'personal_context',
    supportedVersions: [1],
    note: '本人へのサービス提供（prompt 生成 / Personal Memory）。aggregate / sharing の同意ではない。',
  },
  {
    scope: 'internal_aggregated_analytics',
    family: 'aggregate_contribution',
    requiresExplicitOptIn: true,
    defaultGranted: false,
    revocable: true,
    target: 'aggregate',
    supportedVersions: [1],
    note: '社内向け privacy-safe aggregate。user-facing 表示や AI context には使えない。',
  },
  {
    scope: 'user_facing_aggregated_insight',
    family: 'aggregate_contribution',
    requiresExplicitOptIn: true,
    defaultGranted: false,
    revocable: true,
    target: 'aggregate',
    supportedVersions: [1],
    note: 'ユーザーへ表示する aggregate。より高い cohort 閾値が必要。',
  },
  {
    scope: 'ai_context_aggregated_insight',
    family: 'aggregate_contribution',
    requiresExplicitOptIn: true,
    defaultGranted: false,
    revocable: true,
    target: 'aggregate',
    supportedVersions: [1],
    note: 'AI prompt へ載せる aggregate。言い換えによる漏洩余地があるため最保守の閾値。',
  },
  {
    scope: 'externally_shared_insight',
    family: 'aggregate_contribution',
    requiresExplicitOptIn: true,
    defaultGranted: false,
    revocable: true,
    target: 'aggregate',
    supportedVersions: [1],
    note: '外部共有。現在いかなる consumer も持たない（実装なし・fail-closed）。',
  },
  {
    scope: 'company_knowledge_contribution',
    family: 'company_knowledge_sharing',
    requiresExplicitOptIn: true,
    defaultGranted: false,
    revocable: true,
    target: 'shared_knowledge',
    supportedVersions: [1],
    note:
      'Layer 5 への明示共有。**aggregate 系 scope とは別 purpose**であり、' +
      ' aggregate の同意があっても shared KB への寄与にはならない（purpose limitation）。',
  },
];

export const CONSENT_PURPOSE_REGISTRY: readonly ConsentPurposeEntry[] = ENTRIES;

const BY_SCOPE: ReadonlyMap<string, ConsentPurposeEntry> = new Map(
  ENTRIES.map((e) => [e.scope, e]),
);

/** scope の registry entry（未知なら null）。 */
export function consentPurposeEntry(scope: string): ConsentPurposeEntry | null {
  return BY_SCOPE.get(scope) ?? null;
}

/** scope が属する purpose family（未知なら null）。 */
export function consentPurposeFamily(scope: string): ConsentPurposeFamily | null {
  return BY_SCOPE.get(scope)?.family ?? null;
}

/**
 * 2 つの scope が **同じ consent として扱えるか**。
 *
 * ★ 常に「同じ scope のときだけ true」。family が同じでも別 scope なら false。
 *   （aggregate 系の 1 つに同意しても他の aggregate scope の同意にはならない）
 */
export function isSameConsentPurpose(a: string, b: string): boolean {
  return a === b && BY_SCOPE.has(a);
}

/** family 単位の scope 一覧（決定論順）。 */
export function scopesForFamily(family: ConsentPurposeFamily): ConsentScope[] {
  return ENTRIES.filter((e) => e.family === family)
    .map((e) => e.scope)
    .sort();
}

// ── consent 判定（default deny）─────────────────────────────────────
export type ConsentEvaluationInput = {
  scope: string;
  /** ledger から導出した現在の状態。null / undefined は「記録なし」。 */
  state: 'granted' | 'revoked' | 'never_granted' | null | undefined;
  /** 同意時の policy version。null / undefined は不明。 */
  grantedVersion: number | null | undefined;
};

export type ConsentEvaluation =
  | { consented: true; scope: ConsentScope; family: ConsentPurposeFamily; version: number }
  | {
      consented: false;
      reason:
        | 'unknown_scope'
        | 'no_record'
        | 'revoked'
        | 'invalid_version'
        | 'unsupported_version';
    };

/**
 * consent 判定（**default deny**）。
 *
 * 以下はすべて `NOT CONSENTED`（Human 指示 §26）:
 *   - 未知 scope（registry に無い）
 *   - 記録なし / null / undefined
 *   - revoked
 *   - version が数値でない / 非整数 / 0 以下
 *   - registry の supportedVersions に無い version（outdated / 未来 version 両方）
 */
export function evaluateConsent(input: ConsentEvaluationInput): ConsentEvaluation {
  const entry = BY_SCOPE.get(input?.scope ?? '');
  if (!entry) return { consented: false, reason: 'unknown_scope' };
  const state = input.state;
  if (state === 'revoked') return { consented: false, reason: 'revoked' };
  if (state !== 'granted') return { consented: false, reason: 'no_record' };
  const v = input.grantedVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    return { consented: false, reason: 'invalid_version' };
  }
  if (!entry.supportedVersions.includes(v)) {
    return { consented: false, reason: 'unsupported_version' };
  }
  return { consented: true, scope: entry.scope, family: entry.family, version: v };
}

/** 判定結果の boolean 版（呼び出し側の短絡用）。 */
export function isConsented(input: ConsentEvaluationInput): boolean {
  return evaluateConsent(input).consented;
}
