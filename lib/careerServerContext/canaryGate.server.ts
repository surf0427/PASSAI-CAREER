// PASSAI CAREER — Server Context canary gate の env 読取（Canary activation / server-only）。
//
// env（すべて server-only。NEXT_PUBLIC_ 禁止＝canary user ID を browser へ出さない）:
//   - CAREER_SERVER_CONTEXT_PURPOSES        : comma 区切りの purpose。未設定 = 空 = OFF。
//   - CAREER_SERVER_CONTEXT_CANARY_USER_IDS : comma 区切りの authenticated user UUID。
//                                             未設定 / 空 / 不正 → **誰も許可しない**（default deny）。
//
// ★ default OFF。コードに default true / development 自動 ON を入れない（activation は operator 制御）。
// ★ 値は log しない・戻り値へ生 env を含めない。

import 'server-only';

import {
  buildServerContextCanaryConfig,
  type ServerContextCanaryConfig,
} from './canaryGate';
import { parseServerContextPurposes } from './baseContextPolicy';

export const CAREER_SERVER_CONTEXT_PURPOSES_ENV = 'CAREER_SERVER_CONTEXT_PURPOSES';
export const CAREER_SERVER_CONTEXT_CANARY_USER_IDS_ENV =
  'CAREER_SERVER_CONTEXT_CANARY_USER_IDS';

/** server env から canary config を組む（default deny）。 */
export function loadServerContextCanaryConfigFromEnv(): ServerContextCanaryConfig {
  return buildServerContextCanaryConfig(
    parseServerContextPurposes(process.env[CAREER_SERVER_CONTEXT_PURPOSES_ENV]),
    process.env[CAREER_SERVER_CONTEXT_CANARY_USER_IDS_ENV],
  );
}
