// PASSAI 就活版 — CareerEsResult の canonical shape（純関数・I/O ゼロ）。
//
// 背景（AI call 単位監査の指摘 P2-3）:
//   `career_es_logs.result` は DDL 上 `jsonb NOT NULL DEFAULT '{}'::jsonb` であり、
//   mirror 書き込みも `result: log.result ?? {}` を許す。つまり **`{}` は正常に保存されうる値**。
//   ところが read boundary（`rowToCareerEsLog` / `normalizeEsLog`）は形状を検証せず
//   `as CareerEsResult` で cast していたため、必須 string field が undefined のまま
//   renderer / prompt builder まで到達していた。
//
// 本 module の責務:
//   read boundary で「欠損 field を既存の空表現（'' / []）へ埋める」だけ。
//   ★ データを捏造しない（値がある field は原文のまま素通し）。
//   ★ DB 行は書き換えない（read-time normalization のみ）。
//   ★ competing normalizer を作らない: `esStorage.emptyEsResult()` は本 module へ委譲する。

import type { CareerEsResult } from '@/types/careerEs';

/** 必須 string field（欠損時は '' で埋める）。 */
const STRING_FIELDS = ['gakuchika', 'selfPr', 'motivation', 'headline'] as const;
/** 必須 string[] field（欠損時は [] で埋める）。 */
const LIST_FIELDS = ['appealPoints', 'interviewQuestions', 'improvements'] as const;

/** 空の CareerEsResult 土台（canonical。esStorage.emptyEsResult がこれを使う）。 */
export function emptyCareerEsResult(): CareerEsResult {
  return {
    gakuchika: '',
    selfPr: '',
    motivation: '',
    headline: '',
    appealPoints: [],
    interviewQuestions: [],
    improvements: [],
  };
}

/**
 * 任意の unknown を CareerEsResult の canonical shape へ正規化する（never-throw）。
 *
 * - object でない / null → 空 result。
 * - 既存の値は **型が合っているものだけ**そのまま残す（値の加工・生成はしない）。
 * - 型が合わない / 欠損 → 空表現（'' / []）。
 * - 未知の追加 field（answer 等の optional）は保持する（後方互換）。
 */
export function normalizeCareerEsResult(raw: unknown): CareerEsResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyCareerEsResult();
  const r = raw as Record<string, unknown>;
  // 未知 / optional field（answer 等）を落とさないため、まず原本を展開する。
  const out = { ...r } as Record<string, unknown>;
  for (const key of STRING_FIELDS) {
    out[key] = typeof r[key] === 'string' ? r[key] : '';
  }
  for (const key of LIST_FIELDS) {
    out[key] = Array.isArray(r[key]) ? r[key] : [];
  }
  return out as unknown as CareerEsResult;
}
