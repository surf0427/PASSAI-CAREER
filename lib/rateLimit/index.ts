// PASSAI — 汎用 rate limit ユーティリティ（STEP-GD-20-K）。
//
// - key（user_id 等）は hash 化してから store に渡す（生値を store/ログに残さない）。
// - namespace で機能別に分離。複数 window（短期・中期）を同時チェックし、どれか超過で 429。
// - 429 response は安定した JSON（`error: 'RATE_LIMITED'`）＋ Retry-After / X-RateLimit-* header。
// - `CAREER_GD_RATE_LIMIT_DISABLED=1|true` で無効化（**local/test/CI 用**。本番では設定しない）。
//   既定は「有効」なので、本番で silent no-op にはならない。
//
// server-only。将来 ES/面接/プレゼンでも再利用できるよう汎用寄りにしている。

import 'server-only';
import { createHash } from 'node:crypto';
import { getRateLimitStore } from './store';

export type RateLimitWindow = { limit: number; windowSeconds: number };

export type RateLimitRule = {
  namespace: string;
  windows: readonly RateLimitWindow[];
  /**
   * STEP-GD-31: store 障害時の挙動。
   *
   * 既定（false）は **fail-open**（可用性優先）。store が落ちても機能が止まらない。
   * true にすると **fail-closed**（安全性優先）で 429 を返す。
   *
   * ★ 使い分けの基準:
   *   fail-closed … 「上限が消えると security が壊れる」もの。GD では合言葉 join が該当する
   *                 （6 桁 = 10^6 空間の総当りを、上限消失中に許すわけにいかない）。
   *   fail-open  … 「上限が消えても最悪うるさいだけ」のもの（発言・heartbeat・status polling）。
   *                ここを fail-closed にすると、Redis 障害が即 GD 全停止になり本末転倒。
   */
  failClosed?: boolean;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // unix seconds（このウインドウがリセットされる時刻）
  retryAfterSeconds: number;
};

// key の実値を store/ログに残さないため SHA-256 の先頭 20 桁に短縮して使う。
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 20);
}

export function isRateLimitDisabled(): boolean {
  const v = process.env.CAREER_GD_RATE_LIMIT_DISABLED;
  return v === '1' || v === 'true';
}

// 単一 window の固定ウインドウカウンタ。nowMs はテスト用に注入可能。
export async function checkRateLimit(params: {
  key: string;
  limit: number;
  windowSeconds: number;
  namespace: string;
  nowMs?: number;
  /** store 障害時に拒否する（既定 false = 通す）。 */
  failClosed?: boolean;
}): Promise<RateLimitResult> {
  const nowMs = params.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const bucket = Math.floor(nowSec / params.windowSeconds);
  const storeKey = `${params.namespace}:${hashKey(params.key)}:${bucket}`;
  const resetAt = (bucket + 1) * params.windowSeconds;

  let count: number;
  try {
    count = await getRateLimitStore().incr(storeKey, params.windowSeconds, nowMs);
  } catch {
    // store 障害時の挙動は rule 側の宣言に従う（namespace のみログ・key は出さない）。
    if (params.failClosed) {
      console.warn(`rate limit store error: namespace=${params.namespace} (request DENIED / fail-closed)`);
      return { allowed: false, limit: params.limit, remaining: 0, resetAt, retryAfterSeconds: params.windowSeconds };
    }
    console.warn(`rate limit store error: namespace=${params.namespace} (request allowed)`);
    return { allowed: true, limit: params.limit, remaining: params.limit, resetAt, retryAfterSeconds: 0 };
  }

  const allowed = count <= params.limit;
  const remaining = Math.max(0, params.limit - count);
  const retryAfterSeconds = allowed ? 0 : Math.max(1, resetAt - nowSec);
  return { allowed, limit: params.limit, remaining, resetAt, retryAfterSeconds };
}

// 複数 window を全てチェック。どれか超過で allowed=false（最初に超過した window を返す）。
// 無効化時は store に触れず allowed を返す。
export async function checkRateLimits(params: {
  key: string;
  rule: RateLimitRule;
  nowMs?: number;
}): Promise<{ allowed: boolean; result: RateLimitResult }> {
  const { windows, namespace } = params.rule;
  if (isRateLimitDisabled()) {
    const w = windows[0];
    return {
      allowed: true,
      result: { allowed: true, limit: w?.limit ?? 0, remaining: w?.limit ?? 0, resetAt: 0, retryAfterSeconds: 0 },
    };
  }

  let blocked: RateLimitResult | null = null;
  let tightest: RateLimitResult | null = null;
  for (const w of windows) {
    const r = await checkRateLimit({
      key: params.key,
      limit: w.limit,
      windowSeconds: w.windowSeconds,
      namespace,
      nowMs: params.nowMs,
      failClosed: params.rule.failClosed === true,
    });
    if (!r.allowed && !blocked) blocked = r; // 最初に引っかかった window を採用
    if (!tightest || r.remaining < tightest.remaining) tightest = r;
  }
  if (blocked) return { allowed: false, result: blocked };
  return { allowed: true, result: tightest ?? { allowed: true, limit: 0, remaining: 0, resetAt: 0, retryAfterSeconds: 0 } };
}

// 429 レスポンス（secret/PII/user_id/room_id を含めない安定 JSON）。
const RATE_LIMITED_MESSAGE = '短時間に操作が集中しています。少し待ってからもう一度お試しください。';

export function rateLimitedResponse(result: RateLimitResult): Response {
  return Response.json(
    { error: 'RATE_LIMITED', message: RATE_LIMITED_MESSAGE, detail: RATE_LIMITED_MESSAGE, retryAfterSeconds: result.retryAfterSeconds },
    {
      status: 429,
      headers: {
        'Retry-After': String(result.retryAfterSeconds),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(result.resetAt),
      },
    },
  );
}

// route 用ショートカット: key（user_id）と rule を受け、超過なら 429 Response、許可なら null。
export async function enforceRateLimit(key: string, rule: RateLimitRule): Promise<Response | null> {
  const { allowed, result } = await checkRateLimits({ key, rule });
  if (allowed) return null;
  // key の実値は出さない。namespace / limit / retryAfter のみ。
  console.warn(`GD rate limited: namespace=${rule.namespace} limit=${result.limit} retryAfterSec=${result.retryAfterSeconds}`);
  return rateLimitedResponse(result);
}

// ── GD ロビー/合言葉の rate limit ルール（正本） ────────────────
export const CAREER_GD_RATE_LIMITS = {
  // 公開ロビー create: 3/分・10/時（同一 host 再create=reused でも連打負荷があるため対象）。
  lobbyCreate: {
    namespace: 'career_gd_lobby_create',
    windows: [{ limit: 3, windowSeconds: 60 }, { limit: 10, windowSeconds: 3600 }],
  },
  // 公開ロビー join: 10/分・30/時（冪等でも連打負荷を避ける）。
  lobbyJoin: {
    namespace: 'career_gd_lobby_join',
    windows: [{ limit: 10, windowSeconds: 60 }, { limit: 30, windowSeconds: 3600 }],
  },
  // 合言葉 create: 5/分・20/時。
  inviteCreate: {
    namespace: 'career_gd_invite_create',
    windows: [{ limit: 5, windowSeconds: 60 }, { limit: 20, windowSeconds: 3600 }],
  },
  // 合言葉 join: 10/分・40/時。
  //   ★ fail-closed。6 桁コード（10^6）への総当りを、store 障害中に無制限で許さない。
  //     Upstash 障害時は join だけが一時的に 429 になる（create / 発言 / 進行は継続できる）。
  inviteJoin: {
    namespace: 'career_gd_invite_join',
    windows: [{ limit: 10, windowSeconds: 60 }, { limit: 40, windowSeconds: 3600 }],
    failClosed: true,
  },
  // ランダムマッチ enter: 10/分・30/時（連打・二重投入を防ぐ）。
  matchEnter: {
    namespace: 'career_gd_match_enter',
    windows: [{ limit: 10, windowSeconds: 60 }, { limit: 30, windowSeconds: 3600 }],
  },
  // ランダムマッチ status: 60/分・600/時（5 秒 polling 前提で create/join より緩め）。
  matchStatus: {
    namespace: 'career_gd_match_status',
    windows: [{ limit: 60, windowSeconds: 60 }, { limit: 600, windowSeconds: 3600 }],
  },
  // ランダムマッチ cancel: 10/分・30/時。
  matchCancel: {
    namespace: 'career_gd_match_cancel',
    windows: [{ limit: 10, windowSeconds: 60 }, { limit: 30, windowSeconds: 3600 }],
  },
  // ── STEP-GD-31 追加分 ───────────────────────────────────────
  // 発言: 30/分・600/時。GD の実利用（1〜2 秒に 1 回打つことはない）より十分緩く、
  //   スクリプトによる spam は止まる。fail-open（Redis 障害で GD が止まらない）。
  message: {
    namespace: 'career_gd_message',
    windows: [{ limit: 30, windowSeconds: 60 }, { limit: 600, windowSeconds: 3600 }],
  },
  // AI 発言: 20/分・200/時。**Anthropic 課金に直結**するため発言より厳しくする。
  aiTurn: {
    namespace: 'career_gd_ai_turn',
    windows: [{ limit: 20, windowSeconds: 60 }, { limit: 200, windowSeconds: 3600 }],
  },
  // 評価生成: 6/分・40/時。1 room 1 回が正常系（冪等なので再試行はある）。AI 課金に直結。
  result: {
    namespace: 'career_gd_result',
    windows: [{ limit: 6, windowSeconds: 60 }, { limit: 40, windowSeconds: 3600 }],
  },
  // heartbeat: 既定 15 秒間隔 = 4/分。上限 20/分は「複数タブ・再接続直後の集中」を許容しつつ
  //   暴走クライアントを止める水準。fail-open（presence が理由で GD を止めない）。
  heartbeat: {
    namespace: 'career_gd_heartbeat',
    windows: [{ limit: 20, windowSeconds: 60 }, { limit: 600, windowSeconds: 3600 }],
  },
} as const satisfies Record<string, RateLimitRule>;

// ── Career プレゼン AI route の rate limit ルール（正本）────────────
//
// STEP-CAREER-PRESENTATION-HARDENING-P0: /api/career/presentation/{theme,evaluate,qa} は
// Anthropic 課金に直結する公開 endpoint。プレゼンは **guest 利用を正式に許可**した機能
// （localStorage canonical / mirror は member のみ）なので、GD のように 401 で閉じず、
// 「member = user_id キー」「guest = IP キー」の **2 系統**で上限を分ける。
//
// 値の根拠（通常利用を邪魔せず automated abuse を止める水準）:
//   theme    … お題は納得いくまで作り直す（実利用で数回）。member 8/分・40/時。
//   evaluate … 1 プレゼン 1 回が正常系（失敗時の再試行あり）。**最も高価**なので最も厳しい。
//   qa       … kickoff + 回答 4 回 = 1 セッション最大 5 call。連続練習を見込んで緩め。
//
// guest 側は member の約 6 割に絞る。ただし NAT（学校・オフィス）で IP が共有される
// 可能性があるため、体験版が完走できない水準までは下げない（evaluate 3/分・12/時 = 
// 1 IP から 1 時間に 12 回の本評価が可能）。
//
// failClosed の使い分け（GD の思想に合わせる）:
//   member … fail-open。Upstash 障害でログイン済みユーザーの機能を止めない。
//   guest  … **fail-closed**。濫用面はまさに未認証経路であり、store 障害中に
//            匿名から無制限の AI 課金を許すわけにいかない。
export const CAREER_PRESENTATION_RATE_LIMITS = {
  themeMember: {
    namespace: 'career_presentation_theme_member',
    windows: [{ limit: 8, windowSeconds: 60 }, { limit: 40, windowSeconds: 3600 }],
  },
  themeGuest: {
    namespace: 'career_presentation_theme_guest',
    windows: [{ limit: 5, windowSeconds: 60 }, { limit: 20, windowSeconds: 3600 }],
    failClosed: true,
  },
  evaluateMember: {
    namespace: 'career_presentation_evaluate_member',
    windows: [{ limit: 5, windowSeconds: 60 }, { limit: 30, windowSeconds: 3600 }],
  },
  evaluateGuest: {
    namespace: 'career_presentation_evaluate_guest',
    windows: [{ limit: 3, windowSeconds: 60 }, { limit: 12, windowSeconds: 3600 }],
    failClosed: true,
  },
  qaMember: {
    namespace: 'career_presentation_qa_member',
    windows: [{ limit: 15, windowSeconds: 60 }, { limit: 80, windowSeconds: 3600 }],
  },
  qaGuest: {
    namespace: 'career_presentation_qa_guest',
    windows: [{ limit: 10, windowSeconds: 60 }, { limit: 40, windowSeconds: 3600 }],
    failClosed: true,
  },
} as const satisfies Record<string, RateLimitRule>;

// ── Career 面接 AI route の rate limit ルール（正本）──────────────────
//
// STEP-CAREER-INTERVIEW-HARDENING-P0-1: /api/career/interview/{start,turn,complete} は
// Anthropic 課金に直結する公開 endpoint でありながら guard を持っていなかった
// （Production Readiness Audit P0-1）。プレゼンと **同じ 2 系統設計**を横展開する:
//   member … user_id キー（通常上限・fail-open）
//   guest  … IP キー（厳しめ・fail-closed）
// ★ 401 では閉じない。面接は guest 利用を正式に許可した機能（localStorage canonical）。
//
// 値の根拠（正常な 1 面接 = start 1 回 + turn 最大 4 回 + complete 1 回）:
//   start    … 面接開始。モードを選び直して開始し直す程度は許す。member 6/分・30/時。
//   turn     … 最頻。5 問を早口で進めても 1 分に 4 回程度。member 20/分は 5 倍の余裕。
//   complete … **最も高価**（max_tokens 4000）。1 面接 1 回が正常系（失敗時の再試行あり）。
//
// guest は member の 6 割程度。NAT（大学・オフィス）で IP が共有されうるため、
// 体験が完走できない水準までは下げない（guest でも 1 時間に 12 面接ぶんの complete が可能）。
export const CAREER_INTERVIEW_RATE_LIMITS = {
  startMember: {
    namespace: 'career_interview_start_member',
    windows: [{ limit: 6, windowSeconds: 60 }, { limit: 30, windowSeconds: 3600 }],
  },
  startGuest: {
    namespace: 'career_interview_start_guest',
    windows: [{ limit: 4, windowSeconds: 60 }, { limit: 15, windowSeconds: 3600 }],
    failClosed: true,
  },
  turnMember: {
    namespace: 'career_interview_turn_member',
    windows: [{ limit: 20, windowSeconds: 60 }, { limit: 150, windowSeconds: 3600 }],
  },
  turnGuest: {
    namespace: 'career_interview_turn_guest',
    windows: [{ limit: 12, windowSeconds: 60 }, { limit: 75, windowSeconds: 3600 }],
    failClosed: true,
  },
  completeMember: {
    namespace: 'career_interview_complete_member',
    windows: [{ limit: 5, windowSeconds: 60 }, { limit: 30, windowSeconds: 3600 }],
  },
  completeGuest: {
    namespace: 'career_interview_complete_guest',
    windows: [{ limit: 3, windowSeconds: 60 }, { limit: 12, windowSeconds: 3600 }],
    failClosed: true,
  },
} as const satisfies Record<string, RateLimitRule>;
