// PASSAI CAREER — Personal Memory canary config（P16-G / server-only env 読取）。
//
// 責務: server-only env（NEXT_PUBLIC_ を付けない）から canary allowlist を読み、pure parser（canaryGate.ts）で
//   CanaryConfig を組む。**client bundle へ入れない**（server-only）。値をログ・戻り値へ生で露出しない。
//
// env（いずれも server-only。NEXT_PUBLIC_ 禁止＝client bundle 非混入）:
//   - CAREER_PERSONAL_MEMORY_CANARY_USER_IDS: comma-separated authenticated user UUID。
//   - CAREER_PERSONAL_MEMORY_CANARY_SECTIONS: comma-separated section（base/self_analysis/es/interview のみ）。
//   未設定 / 空 / 不正は canaryGate の parser が default deny 側へ倒す。

import 'server-only';

import { buildCanaryConfig, type CanaryConfig } from './canaryGate';

export const CAREER_CANARY_USER_IDS_ENV = 'CAREER_PERSONAL_MEMORY_CANARY_USER_IDS';
export const CAREER_CANARY_SECTIONS_ENV = 'CAREER_PERSONAL_MEMORY_CANARY_SECTIONS';

// server-only env から CanaryConfig を組む（生値は返さない・log しない）。
export function loadCanaryConfigFromEnv(): CanaryConfig {
  return buildCanaryConfig(
    process.env[CAREER_CANARY_USER_IDS_ENV],
    process.env[CAREER_CANARY_SECTIONS_ENV],
  );
}
