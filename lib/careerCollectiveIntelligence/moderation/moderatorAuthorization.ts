// PASSAI CAREER — moderator 認可の contract（Policy Freeze / `D-P3`）。
//
// Human 指示 §10 / §11:
//   - provider-neutral な moderation contract（submit → pre-screen → human review → publish）
//   - 一般 member が moderation action を実行できないこと
//   - ❌ client の boolean `isAdmin`
//   - ❌ request body の `moderatorId`
//   - 既存 admin/auth architecture があれば再利用。**無い場合は fail-closed interface** を作り、
//     production provider adapter を Human provisioning 項目として残す。
//
// ★ 監査結果: 本 repo に admin / moderator の認可基盤は **存在しない**
//   （`isAdmin` / role table / admin route いずれも無し）。
//   したがって本 module は **interface + fail-closed gate** までを提供し、
//   実 provider（role table / allowlist / 外部 IdP）は provisioning 項目とする。
//
// ★ fail-closed の徹底:
//   `resolveModerator` port が渡されない / 解決に失敗した場合は **常に拒否**。
//   「adapter が無いから素通し」にはならない。
//
// pure / deterministic / never-throw。I/O は injected port のみ。

// ── moderator identity ──────────────────────────────────────────────
/**
 * moderator の識別。
 *
 * ★ `authUserId` は **server auth 由来のみ**（`auth.uid()`）。
 *   client 申告値を入れる field は型に存在しない。
 */
export type ModeratorIdentity = {
  authUserId: string;
  /** 付与されている moderation 権限。 */
  capabilities: readonly ModeratorCapability[];
};

export type ModeratorCapability =
  | 'review' // pending を審査できる
  | 'approve' // approve できる
  | 'reject' // reject できる
  | 'publish' // 公開できる
  | 'unpublish' // 公開を止められる
  | 'legal_hold'; // legal hold を発動できる

export const MODERATOR_CAPABILITIES: readonly ModeratorCapability[] = [
  'review',
  'approve',
  'reject',
  'publish',
  'unpublish',
  'legal_hold',
];

/**
 * moderator 解決 port（**production 実装は現在存在しない**）。
 *
 * 実装は以下のいずれかになる想定（H-L6 / H-L8 の provisioning 項目）:
 *   - Supabase の role table（`auth.uid()` → capabilities）
 *   - env allowlist（少人数運用の初期形）
 *   - 外部 IdP のグループ
 *
 * ★ どの実装でも **`auth.uid()` から解決する**こと。引数に client 由来の値を取らない。
 */
export type ResolveModeratorPort = (authUserId: string) => Promise<ModeratorIdentity | null>;

// ── 認可判定 ─────────────────────────────────────────────────────────
export type ModerationAction =
  | 'review'
  | 'approve'
  | 'reject'
  | 'publish'
  | 'unpublish'
  | 'legal_hold';

export type ModeratorAuthzDecision =
  | { authorized: true; capabilities: readonly ModeratorCapability[] }
  | {
      authorized: false;
      reason:
        | 'not_authenticated'
        | 'no_moderator_provider' // adapter 未設定（★ 素通ししない）
        | 'not_a_moderator'
        | 'capability_missing'
        | 'provider_error';
    };

/**
 * moderation action の認可（**fail-closed**）。
 *
 * ★ 「adapter が無い＝誰でもできる」には **絶対にしない**。
 *   adapter が無ければ `no_moderator_provider` で拒否する。
 */
export async function authorizeModeratorAction(input: {
  /** server auth 由来の UUID（未認証なら null）。 */
  authUserId: string | null | undefined;
  action: ModerationAction;
  /** 未設定なら **拒否**（素通ししない）。 */
  resolveModerator?: ResolveModeratorPort | null;
}): Promise<ModeratorAuthzDecision> {
  try {
    if (typeof input?.authUserId !== 'string' || input.authUserId.trim() === '') {
      return { authorized: false, reason: 'not_authenticated' };
    }
    if (typeof input.resolveModerator !== 'function') {
      // ★ provider 未設定は「拒否」。ここを素通しにすると全 member が moderator になる。
      return { authorized: false, reason: 'no_moderator_provider' };
    }
    let identity: ModeratorIdentity | null = null;
    try {
      identity = await input.resolveModerator(input.authUserId);
    } catch {
      return { authorized: false, reason: 'provider_error' };
    }
    if (!identity || typeof identity !== 'object') {
      return { authorized: false, reason: 'not_a_moderator' };
    }
    // identity の authUserId は解決結果と一致していること（port の実装ミス検出）。
    if (identity.authUserId !== input.authUserId) {
      return { authorized: false, reason: 'provider_error' };
    }
    const caps = Array.isArray(identity.capabilities) ? identity.capabilities : [];
    if (caps.length === 0) return { authorized: false, reason: 'not_a_moderator' };
    if (!caps.includes(input.action as ModeratorCapability)) {
      return { authorized: false, reason: 'capability_missing' };
    }
    return { authorized: true, capabilities: caps };
  } catch {
    return { authorized: false, reason: 'provider_error' };
  }
}

/**
 * ★ client 由来の値を moderator 判定に使っていないことを検査する helper。
 *
 * `isAdmin` / `moderatorId` / `role` 等を request body から受け取る実装が現れたら
 * QA が検出できるようにする（`PF-7` が静的にも固定する）。
 */
export const FORBIDDEN_MODERATOR_INPUT_FIELDS: readonly string[] = [
  'isAdmin',
  'is_admin',
  'admin',
  'moderatorId',
  'moderator_id',
  'role',
  'capabilities',
];

/** request body 相当の object が禁止 field を含むか（含めば拒否すべき）。 */
export function containsForbiddenModeratorInput(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  return Object.keys(body as Record<string, unknown>).some((k) =>
    FORBIDDEN_MODERATOR_INPUT_FIELDS.includes(k),
  );
}

/**
 * moderator provider が設定されているか（preflight が参照）。
 * ★ module が存在するだけでは true にしない（Human 指示 §29 の accidental enable 否定）。
 */
export function isModeratorProviderConfigured(port: ResolveModeratorPort | null | undefined): boolean {
  return typeof port === 'function';
}
