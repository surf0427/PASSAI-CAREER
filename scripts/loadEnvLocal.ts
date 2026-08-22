/*
 * scripts/loadEnvLocal.ts
 *
 * dev/operator script 用の .env.local ローダー（**副作用 import 専用**）。
 *
 * ★ なぜ独立 module なのか（重要）:
 *   ESM の import は巻き上げられ、宣言順に評価される。`lib/ai.ts` のように
 *   **module 評価時に `process.env` を読む**依存（Anthropic クライアントの生成）があるため、
 *   script 本体の main() で .env.local を読んでも「もう遅い」。
 *   本 module を **最初の import** に置くことで、後続の import が評価される前に env を埋める。
 *   （これを怠ると API キー未設定のクライアントが作られ、LLM 抽出が黙って全滅する。）
 *
 * 値は一切ログへ出さない。既に設定済みの env は上書きしない。
 */

import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf-8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
