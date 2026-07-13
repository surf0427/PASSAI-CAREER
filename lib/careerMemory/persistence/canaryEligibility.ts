// PASSAI CAREER — Personal Memory canary eligibility core（P16-G / DI・pure logic）。
//
// 責務: 「server 検証済み authenticated user」＋「requested section」＋「server-only config」から
//   eligible boolean を導く。**server client / next/headers / env を直接 import しない**（DI 経由）ので、
//   offline QA で fake deps を注入して検証できる。route.ts が実 deps を配線する。
//
// ★ 境界:
//   - user 検証は deps.verifyUser（server 側 getUser 等）に委譲。client 申告 userId は受け取らない・信用しない。
//   - section は既存 schema の section discriminator を source of truth に validate（route/画面名から推測しない）。
//   - never-throw: 例外は eligible=false へ潰す。戻り値は eligible のみ（userId/allowlist/token/理由を含めない）。
//   - service role を使わない（deps 実装側でも禁止）。

import {
  CAREER_PERSONAL_MEMORY_SECTION_KEYS,
  type CareerPersonalMemorySectionKey,
} from './schema';
import { evaluateCanaryGate, type CanaryConfig } from './canaryGate';

// server 側 user 検証の最小結果（token/cookie から確定した authenticated member のみ userId を持つ）。
export type CanaryVerifyResult =
  | { kind: 'member'; userId: string }
  | { kind: 'unauth' } // guest / anonymous / token 不正 / auth error
  | { kind: 'no-config' }; // server Supabase env 未設定（write 不可扱い）

export type EligibilityDeps = {
  // access token（任意）から authenticated member を server 側で確定する（never-throw 実装）。
  verifyUser: (accessToken: string | undefined) => Promise<CanaryVerifyResult>;
  // server-only env から allowlist config を読む。
  loadConfig: () => CanaryConfig;
};

export type EligibilityInput = {
  // client から届く section（信用せず schema で validate する）。
  section: unknown;
  // client の access token（任意。無ければ cookie session を deps 実装が使う想定）。
  accessToken?: string | undefined;
};

function isKnownSection(v: unknown): v is CareerPersonalMemorySectionKey {
  return typeof v === 'string' && (CAREER_PERSONAL_MEMORY_SECTION_KEYS as readonly string[]).includes(v);
}

// eligible を判定する（never-throw）。deny 理由は返さない（eligible boolean のみ）。
export async function evaluateEligibility(
  deps: EligibilityDeps,
  input: EligibilityInput,
): Promise<{ eligible: boolean }> {
  try {
    // 1) section validation（unknown/wildcard/all は即 deny）。
    if (!isKnownSection(input.section)) return { eligible: false };

    // 2) server 側 user 検証（member 以外は deny）。
    const verified = await deps.verifyUser(input.accessToken);
    if (verified.kind !== 'member') return { eligible: false };

    // 3) server-only config を読み、pure gate で判定。
    const config = deps.loadConfig();
    const eligible = evaluateCanaryGate(verified.userId, input.section, config);
    return { eligible };
  } catch {
    return { eligible: false }; // fail-closed
  }
}
