# 自己分析まとめ生成 — 耐障害ジョブ化 デプロイゲート（members pilot）

STEP-CAREER-GENJOB-01 / 02。`career_generation_jobs` + 202/after background + status endpoint。

**pilot flag `CAREER_SELF_ANALYSIS_JOB_PILOT_ENABLED` を ON にする前に、以下をすべて満たすこと。**
コード実装と fake/in-memory QA は完了済み。fake provider QA は下記 DB/環境ゲートの代替にしてはならない。

## A. DB integration gate（実 Postgres / Supabase CLI / 隔離 test DB）

`supabase/career_generation_jobs_apply.sql` を空 DB へ適用して検証する。

1. migration を空 DB へ適用できる
2. migration を再適用しても冪等（エラーなし）
3. 同一 natural key で claim を並行実行 → `CLAIMED_NEW` は 1 件だけ
4. 競合側が `ALREADY_RUNNING` になる
5. unique violation が外へ漏れない（例外→500 にならない）
6. stale reclaim で attempt_token が変わる
7. 旧 attempt_token の complete が 0 行（fenced）
8. 旧 attempt_token の fail が 0 行（fenced）
9. 新 attempt_token の complete が 1 行
10. authenticated owner の SELECT 成功
11. authenticated 他 owner の SELECT 失敗（RLS）
12. authenticated の INSERT/UPDATE/DELETE 失敗（GRANT/RLS）
13. anon の SELECT/WRITE 失敗
14. authenticated による claim function 実行失敗（EXECUTE 未付与）
15. service_role による claim function 実行成功
16. SECURITY DEFINER function の search_path 安全性（`public, pg_temp` 固定）
17. MAX_ATTEMPTS(=3) 到達時の terminal transition（stale running → failed `RETRY_LIMIT_REACHED`）

## B. Runtime / platform gate

18. Vercel Function の実際の Max Duration が 300s 運用であること（Pro 前提）
19. **Fluid Compute の有効状態**を Dashboard で確認（`after()` の response 後継続保証の前提）
20. Vercel Preview 上で 202 返却後に background が完走し、job が completed で保存されること
21. Preview 上で client 切断後も後から status endpoint で completed を回収できること

## C. 既知の残リスク（要監視）

- `after()` は durable queue ではない。Function 強制終了時は job が running のまま残り、
  lease(360s) 失効後の reclaim で回復する（completed へ自動昇格しない設計）。
- claim function の competition/fencing は静的 SQL 契約 QA のみ担保。実挙動は上記 A で確認する。
- 匿名ユーザーは job を持たない（localStorage-only）。durable 復旧は member 限定。

## 参照

- migration: `supabase/career_generation_jobs_apply.sql`
- data 層: `lib/careerGenerationJob/*`（constants / types / idempotency / repository / errors / flag.server）
- 生成: `lib/careerSelfAnalysis/summaryPrompt.ts` / `summaryProvider.ts` / `summaryJobAttempt.ts` / `summaryJobService.ts` / `summaryJobStatus.ts`
- route: `app/api/career/self-analysis/route.ts`（POST）/ `.../job/route.ts`（GET status）
- QA: `npm run qa:careerGenerationJob`（sql-contract / core / step2）
