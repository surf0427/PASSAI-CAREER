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
  // ── STEP-GD-VOICE 追加分（完全音声型）─────────────────────────
  // 文字起こし: 40/分・800/時。
  //   GD は「押して話す → 離して確定」で 1 発言 1 クリップなので、実利用の上限は
  //   発言 rate（30/分）とほぼ同じ。少し上に取るのは、取り消し・言い直しで
  //   録音だけして送る回数が発言数をわずかに上回るため。
  //   ★ OpenAI Whisper 課金に直結する。fail-open（Redis 障害で GD を無音にしない）。
  stt: {
    namespace: 'career_gd_stt',
    windows: [{ limit: 40, windowSeconds: 60 }, { limit: 800, windowSeconds: 3600 }],
  },
  // 読み上げ: 60/分・1200/時。
  //   AI 発言・進行アナウンスの読み上げ。client はキャッシュせず 1 発言 1 回叩くため、
  //   AI 発言 rate（20/分）＋進行アナウンス＋再生し直しを見込んで発言系より緩める。
  tts: {
    namespace: 'career_gd_tts',
    windows: [{ limit: 60, windowSeconds: 60 }, { limit: 1200, windowSeconds: 3600 }],
  },
} as const satisfies Record<string, RateLimitRule>;

// ── Career プレゼン AI route の rate limit ルール（正本）────────────
//
// STEP-CAREER-PRESENTATION-HARDENING-P0: /api/career/presentation/{theme,evaluate,qa} は
// Anthropic 課金に直結する endpoint。AI 本実行の可否は後段の有料ゲート
// （lib/careerBilling/aiAccess.ts）が決めるため、本 rule は「誰からの request か」で
// burst 上限を分けるだけにする:「member = user_id キー」「guest = IP キー」の 2 系統。
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
// ★ 本 rule は burst 防御のみ。契約の確認は後段の有料ゲートが行う。
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

// ── Career ES AI route の rate limit ルール（正本）────────────────────
//
// STEP-CAREER-ES-HARDENING-P0: /api/career/es/{materials,deep,organize} と
// /api/career/es-review は Anthropic 課金に直結する公開 endpoint でありながら
// guard を持っていなかった（ES Production Readiness Audit P0）。
// プレゼン / 面接と **同じ 2 系統設計**を横展開する:
//   member … user_id キー（通常上限・fail-open）
//   guest  … IP キー（厳しめ・fail-closed）
// ★ 本 rule は burst 防御のみ。契約の確認は後段の有料ゲートが行う。
//
// 値の根拠（正常な ES 1 本の call 回数。設問種別で最大となるガクチカ = 深掘り上限 7 問）:
//   materials … 材料選択フェーズで 1 回（「探す」を押したとき）。再検索しても数回。
//                候補は id + label のみで max_tokens 900 と軽い。member 8/分・40/時。
//   deep      … **最頻**。seed 1 回 + followup 最大 6 回 = 1 ES あたり最大 7 回で、
//                回答を書いてすぐ次の質問へ進むため短時間に連続する。
//                review と同じ上限をコピーすると正常な深掘りが途中で 429 になる。
//                member 20/分（1 ES を 1 分で駆け抜けても 3 倍近い余裕）・120/時。
//   organize  … 深掘りの締めに 1 回（失敗時の再試行あり）。member 6/分・40/時。
//   review    … **最も高価**（max_tokens 3000）。1 本目の添削 + 「もう一度添削」+
//                改善版（v+1）の添削という UX ループがあるため evaluate 系より少し緩める。
//                member 6/分・40/時。
//
// guest は member の 6 割程度。NAT（大学・オフィス）で IP が共有されうるため、
// ES 1 本を書き切る体験が完走できない水準までは下げない
// （guest でも 1 時間に 8 本ぶんの深掘り + 15 回の添削が可能）。
export const CAREER_ES_RATE_LIMITS = {
  materialsMember: {
    namespace: 'career_es_materials_member',
    windows: [{ limit: 8, windowSeconds: 60 }, { limit: 40, windowSeconds: 3600 }],
  },
  materialsGuest: {
    namespace: 'career_es_materials_guest',
    windows: [{ limit: 5, windowSeconds: 60 }, { limit: 20, windowSeconds: 3600 }],
    failClosed: true,
  },
  deepMember: {
    namespace: 'career_es_deep_member',
    windows: [{ limit: 20, windowSeconds: 60 }, { limit: 120, windowSeconds: 3600 }],
  },
  deepGuest: {
    namespace: 'career_es_deep_guest',
    windows: [{ limit: 12, windowSeconds: 60 }, { limit: 60, windowSeconds: 3600 }],
    failClosed: true,
  },
  organizeMember: {
    namespace: 'career_es_organize_member',
    windows: [{ limit: 6, windowSeconds: 60 }, { limit: 40, windowSeconds: 3600 }],
  },
  organizeGuest: {
    namespace: 'career_es_organize_guest',
    windows: [{ limit: 4, windowSeconds: 60 }, { limit: 16, windowSeconds: 3600 }],
    failClosed: true,
  },
  reviewMember: {
    namespace: 'career_es_review_member',
    windows: [{ limit: 6, windowSeconds: 60 }, { limit: 40, windowSeconds: 3600 }],
  },
  reviewGuest: {
    namespace: 'career_es_review_guest',
    windows: [{ limit: 4, windowSeconds: 60 }, { limit: 15, windowSeconds: 3600 }],
    failClosed: true,
  },
} as const satisfies Record<string, RateLimitRule>;

// ── CAREER 課金導線の rate limit ルール（正本） ────────────────
//
// 対象は Stripe API を叩く 2 route（checkout / portal）。いずれも member 認証済みの
// userId を key にする。目的は「連打で Stripe に大量の Session を作らせない」こと。
//
// ★ どちらも failClosed。store 障害中に Stripe への session 作成を無制限に許すと、
//   外部課金 API へのコスト・レート影響がこちら側の都合で青天井になるため、
//   安全側（一時的に 429）に倒す。課金は「今すぐ通らないと壊れる」機能ではない。
export const CAREER_BILLING_RATE_LIMITS = {
  // Checkout Session 作成: 5/分・20/時。
  checkout: {
    namespace: 'career_billing_checkout',
    windows: [{ limit: 5, windowSeconds: 60 }, { limit: 20, windowSeconds: 3600 }],
    failClosed: true,
  },
  // Billing Portal Session 作成: 5/分・20/時。
  portal: {
    namespace: 'career_billing_portal',
    windows: [{ limit: 5, windowSeconds: 60 }, { limit: 20, windowSeconds: 3600 }],
    failClosed: true,
  },
} as const satisfies Record<string, RateLimitRule>;

// ── Career 残りの AI route の rate limit ルール（正本）──────────────
//
// STEP-CAREER-AI-HARDENING-P0: ES / 面接 / プレゼンは requestGuard で塞いだが、
// 以下 9 route は **identity も rate limit も持たないまま Anthropic を呼んでいた**
// （Production Readiness Audit P0）。同じ 2 系統（member = user_id / guest = IP）で塞ぐ。
//
// ★ プレゼン / 面接 / ES と同じ思想に揃える:
//     member … fail-open。Upstash 障害でログイン済みユーザーの機能を止めない。
//     guest  … **fail-closed**。濫用面はまさに未認証経路であり、store 障害中に
//              匿名から無制限の AI 課金を許すわけにいかない。
//
// 値の根拠（正常利用を 1 度も止めず automated abuse だけを止める水準）:
//   companyResearch  … 企業研究メモの添削。1 社あたり数回の書き直しが正常系。max_tokens 3000。
//   companyExtract   … 画像/PDF の Vision OCR。**1 call あたり最も高価**（最大 30 ページ・
//                      VISION_MAX_TOKENS 4096）。資料を数枚まとめて上げる導線があるので
//                      分あたりは確保しつつ、時間あたりを強く絞る。
//   consultation     … 就活相談 AI のチャット。会話なので最も頻度が高い。
//   matching         … 企業マッチング。現在 flag OFF（404）だが、ON になった瞬間に
//                      無防備にならないよう先に上限を置く。1 call で AI 2 回。
//   selfAnalysis     … 自己分析の本生成。maxDuration 300 の最重量。1 回/セッションが正常系。
//   selfAnalysisQ    … 深掘り質問の 1 問ずつ生成。対話なので頻度が高い。
//   gdTheme          … ソロ GD のお題生成。納得いくまで引き直す想定で少し緩め。
//   gdTurn           … ソロ GD の AI 発言。**発言ごと**に呼ばれるため最も本数が出る。
//                      マルチ GD 側の career_gd_ai_turn（20/分・200/時）と同水準に揃える。
//   gdFeedback       … ソロ GD の評価生成。1 セッション 1 回が正常系。AI 2 回・高価。
export const CAREER_AI_RATE_LIMITS = {
  companyResearchMember: {
    namespace: 'career_company_research_member',
    windows: [{ limit: 8, windowSeconds: 60 }, { limit: 40, windowSeconds: 3600 }],
  },
  companyResearchGuest: {
    namespace: 'career_company_research_guest',
    windows: [{ limit: 5, windowSeconds: 60 }, { limit: 20, windowSeconds: 3600 }],
    failClosed: true,
  },
  companyExtractMember: {
    namespace: 'career_company_extract_member',
    windows: [{ limit: 6, windowSeconds: 60 }, { limit: 30, windowSeconds: 3600 }],
  },
  companyExtractGuest: {
    namespace: 'career_company_extract_guest',
    windows: [{ limit: 4, windowSeconds: 60 }, { limit: 12, windowSeconds: 3600 }],
    failClosed: true,
  },
  // プレゼン発表資料（ファイル）のアップロード / 削除。
  //   AI は呼ばないが 10MB の multipart を受けるため、帯域・storage の濫用を止める必要がある。
  //   正常系は 1 セッション 1 回（差し替え・削除を数回）なので member 6/分・30/時で十分。
  //   guest は有料ゲートで先に落ちるが、guard の 2 系統契約に合わせて rule は持つ（fail-closed）。
  presentationMaterialMember: {
    namespace: 'career_presentation_material_member',
    windows: [{ limit: 6, windowSeconds: 60 }, { limit: 30, windowSeconds: 3600 }],
  },
  presentationMaterialGuest: {
    namespace: 'career_presentation_material_guest',
    windows: [{ limit: 3, windowSeconds: 60 }, { limit: 10, windowSeconds: 3600 }],
    failClosed: true,
  },
  consultationMember: {
    namespace: 'career_consultation_member',
    windows: [{ limit: 20, windowSeconds: 60 }, { limit: 120, windowSeconds: 3600 }],
  },
  consultationGuest: {
    namespace: 'career_consultation_guest',
    windows: [{ limit: 12, windowSeconds: 60 }, { limit: 60, windowSeconds: 3600 }],
    failClosed: true,
  },
  matchingMember: {
    namespace: 'career_matching_member',
    windows: [{ limit: 6, windowSeconds: 60 }, { limit: 40, windowSeconds: 3600 }],
  },
  matchingGuest: {
    namespace: 'career_matching_guest',
    windows: [{ limit: 4, windowSeconds: 60 }, { limit: 15, windowSeconds: 3600 }],
    failClosed: true,
  },
  selfAnalysisMember: {
    namespace: 'career_self_analysis_member',
    windows: [{ limit: 6, windowSeconds: 60 }, { limit: 40, windowSeconds: 3600 }],
  },
  selfAnalysisGuest: {
    namespace: 'career_self_analysis_guest',
    windows: [{ limit: 4, windowSeconds: 60 }, { limit: 15, windowSeconds: 3600 }],
    failClosed: true,
  },
  selfAnalysisQuestionMember: {
    namespace: 'career_self_analysis_question_member',
    windows: [{ limit: 20, windowSeconds: 60 }, { limit: 120, windowSeconds: 3600 }],
  },
  selfAnalysisQuestionGuest: {
    namespace: 'career_self_analysis_question_guest',
    windows: [{ limit: 12, windowSeconds: 60 }, { limit: 60, windowSeconds: 3600 }],
    failClosed: true,
  },
  gdThemeMember: {
    namespace: 'career_gd_theme_member',
    windows: [{ limit: 8, windowSeconds: 60 }, { limit: 40, windowSeconds: 3600 }],
  },
  gdThemeGuest: {
    namespace: 'career_gd_theme_guest',
    windows: [{ limit: 5, windowSeconds: 60 }, { limit: 20, windowSeconds: 3600 }],
    failClosed: true,
  },
  gdTurnMember: {
    namespace: 'career_gd_turn_member',
    windows: [{ limit: 20, windowSeconds: 60 }, { limit: 200, windowSeconds: 3600 }],
  },
  gdTurnGuest: {
    namespace: 'career_gd_turn_guest',
    windows: [{ limit: 12, windowSeconds: 60 }, { limit: 120, windowSeconds: 3600 }],
    failClosed: true,
  },
  gdFeedbackMember: {
    namespace: 'career_gd_feedback_member',
    windows: [{ limit: 6, windowSeconds: 60 }, { limit: 40, windowSeconds: 3600 }],
  },
  gdFeedbackGuest: {
    namespace: 'career_gd_feedback_guest',
    windows: [{ limit: 4, windowSeconds: 60 }, { limit: 15, windowSeconds: 3600 }],
    failClosed: true,
  },
} as const satisfies Record<string, RateLimitRule>;
