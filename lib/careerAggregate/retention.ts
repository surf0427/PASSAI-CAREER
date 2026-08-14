// PASSAI CAREER — Layer 4 retention policy（Collective Intelligence Closure / `D-C3`）。
//
// Human 指示 §12:
//   「明確な retention policy が無い場合、Claude が勝手に法的期間を決めない。
//     代わりに configurable / default fail-closed / no indefinite silent retention /
//     policy version required を architecture へ入れる。」
//
// ★ したがって本 module は **期間を確定しない**。確定するのは *構造* だけ:
//   - 期間は必ず外部 config から来る（コードに法的既定値を持たない）
//   - 未設定 / 不正 / policy version 欠落 は `NOT_CONFIGURED` = **serve しない**
//   - 「無期限保持」を表現できない（`Infinity` / 0 / 負値はすべて invalid）
//   - policy version 必須（どの policy で保持しているか追跡できない状態を作らない）
//
// ★ fail-closed の向き:
//   retention が決まっていないときは「消す」のではなく **serve しない**。
//   （未決状態で自動削除すると復元不能な破壊になるため。削除は Human decision 後。）
//
// pure / deterministic / never-throw。I/O・env 非依存（config は呼び出し側が注入）。

/** retention 設定の確定状態。 */
export type RetentionPolicyStatus = 'NOT_CONFIGURED' | 'CONFIGURED';

export type AggregateRetentionConfig = {
  /** artifact を保持してよい日数（正の有限整数のみ有効）。 */
  retentionDays: number | null;
  /** どの policy version の下で保持しているか（空文字は無効）。 */
  policyVersion: string | null;
  /** 法務承認済みか（未承認でも構造は動くが、activation gate 側で要求する）。 */
  legalApproved: boolean;
};

export const EMPTY_RETENTION_CONFIG: AggregateRetentionConfig = {
  retentionDays: null,
  policyVersion: null,
  legalApproved: false,
};

export type RetentionPolicyEvaluation =
  | {
      status: 'CONFIGURED';
      retentionDays: number;
      policyVersion: string;
      legalApproved: boolean;
    }
  | {
      status: 'NOT_CONFIGURED';
      /** 何が欠けているか（監査用・値は含めない）。 */
      missing: readonly ('retention_days' | 'policy_version')[];
    };

/** 上限日数の sanity bound。これを超える値は「無期限の言い換え」とみなして拒否する。 */
export const RETENTION_MAX_DAYS = 3650; // 10 年。法的期間ではなく **無期限検出のための上限**。

function isValidDays(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isFinite(v) &&
    Number.isInteger(v) &&
    v > 0 &&
    v <= RETENTION_MAX_DAYS
  );
}

function isValidVersion(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * retention config を評価する（fail-closed）。
 *
 * 未設定 / 不正 / policy version 欠落 は `NOT_CONFIGURED`。
 * `Infinity` / 0 / 負値 / 非整数 / 上限超過はすべて invalid（無期限保持を表現できない）。
 */
export function evaluateRetentionPolicy(
  config: AggregateRetentionConfig | null | undefined,
): RetentionPolicyEvaluation {
  const missing: ('retention_days' | 'policy_version')[] = [];
  if (!config || !isValidDays(config.retentionDays)) missing.push('retention_days');
  if (!config || !isValidVersion(config.policyVersion)) missing.push('policy_version');
  if (missing.length > 0) return { status: 'NOT_CONFIGURED', missing };
  return {
    status: 'CONFIGURED',
    retentionDays: config!.retentionDays as number,
    policyVersion: (config!.policyVersion as string).trim(),
    legalApproved: config!.legalApproved === true,
  };
}

export type RetentionDisposition =
  /** 保持期間内。serve してよい（他 gate は別途）。 */
  | { disposition: 'retained'; ageDays: number; policyVersion: string }
  /** 保持期間を超過。serve しない（削除は運用 job の責務・本 module は判定のみ）。 */
  | { disposition: 'expired'; ageDays: number; policyVersion: string }
  /** retention 未確定。**serve しない**（fail-closed）。自動削除もしない。 */
  | { disposition: 'not_configured'; missing: readonly string[] };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * artifact 1 件の retention 判定（pure・時刻は注入）。
 *
 * ★ `nowMs` は呼び出し側が渡す（Date.now を内部で読まない＝決定論）。
 * ★ generatedAt が不正なら `not_configured` 相当ではなく **expired 扱い**にはしない。
 *   由来時刻が分からないものを「まだ新しい」とも「古い」とも断定しないため、
 *   `not_configured`（＝serve しない）へ倒す。
 */
export function evaluateArtifactRetention(input: {
  generatedAt: string | number | null | undefined;
  nowMs: number;
  config: AggregateRetentionConfig | null | undefined;
}): RetentionDisposition {
  const policy = evaluateRetentionPolicy(input.config);
  if (policy.status === 'NOT_CONFIGURED') {
    return { disposition: 'not_configured', missing: policy.missing };
  }
  let generatedMs: number | null = null;
  if (typeof input.generatedAt === 'number' && Number.isFinite(input.generatedAt)) {
    generatedMs = input.generatedAt;
  } else if (typeof input.generatedAt === 'string') {
    const t = Date.parse(input.generatedAt);
    generatedMs = Number.isNaN(t) ? null : t;
  }
  if (generatedMs === null || !Number.isFinite(input.nowMs)) {
    // 由来時刻が不明 ⇒ 年齢を判定できない ⇒ serve しない（安全側）。
    return { disposition: 'not_configured', missing: ['generated_at'] };
  }
  const ageDays = Math.floor((input.nowMs - generatedMs) / MS_PER_DAY);
  // 未来日時（clock skew / 改竄）は 0 日扱いにせず expired へ倒さない。負の年齢は 0 とみなす。
  const age = ageDays < 0 ? 0 : ageDays;
  return age > policy.retentionDays
    ? { disposition: 'expired', ageDays: age, policyVersion: policy.policyVersion }
    : { disposition: 'retained', ageDays: age, policyVersion: policy.policyVersion };
}

/** 「serve してよい retention 状態か」（`retained` のみ true）。 */
export function isRetentionServable(d: RetentionDisposition): boolean {
  return d.disposition === 'retained';
}
