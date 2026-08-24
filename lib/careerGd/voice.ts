/**
 * PASSAI 就活版 — GD 完全音声型の共有プリミティブ（STEP-GD-VOICE）。
 *
 * 本ファイルは **client / server 双方から import される純関数と定数だけ** を持つ。
 * `server-only` を付けない代わりに、secret を読まない・process.env を読まない
 * （env 依存は lib/careerGd/voice.server.ts と client 側の hook が持つ）。
 *
 * 置き場所の理由:
 *   録音 mime の選択・クリップ長の上限・persona ごとの声・文字起こしの採否は
 *   「UI」でも「route」でもなく **仕様** である。両側に同じ判断が二重実装されると
 *   「録音はできたが server が弾く」「AI ごとに声が変わらない」といった、
 *   切り分け不能な不整合になる。判断は必ずここ 1 箇所に置く。
 */

// ── 録音クリップの制約 ────────────────────────────────────────────────
//
// GD は「1 発言 = 1 クリップ」で回す（押して話す → 離して確定）。長時間の
// 連続録音を 1 ファイルにしないことで、STT のレイテンシと失敗時の損失を小さく保つ。

/** 1 クリップの最大長。これを超えたら client が自動で確定させる（言い切れない事故を防ぐ）。 */
export const GD_VOICE_MAX_CLIP_SEC = 90;

/**
 * 1 クリップの最小長。これ未満は誤タップ扱いで **送信しない**
 * （STT へ投げないので課金も発生しない）。
 */
export const GD_VOICE_MIN_CLIP_MS = 700;

/**
 * 送信可能な最大バイト数。Whisper の 25MB 上限より十分小さく取る
 * （90 秒の opus/aac は数百 KB。ここへ到達するのは異常系だけ）。
 */
export const GD_VOICE_MAX_CLIP_BYTES = 8 * 1024 * 1024;

/** 文字起こしの最大文字数。既存の発言上限（600 文字）と揃える。 */
export const GD_VOICE_MAX_TRANSCRIPT_CHARS = 600;

// ── 録音フォーマットの選択 ───────────────────────────────────────────

/**
 * MediaRecorder に渡す mimeType の優先順。
 *
 * ★ Safari（macOS / iOS）は webm を **録音できない**。audio/mp4 しか出せないため、
 *   webm 決め打ちにすると Safari で MediaRecorder の生成に失敗して無音のまま詰まる。
 *   逆に Chrome/Firefox は mp4 録音に対応しないので、両方を優先順で試すのが唯一の正解。
 *   末尾の '' は「ブラウザ既定に任せる」= isTypeSupported が全滅した環境の最後の砦。
 */
export const GD_VOICE_RECORDER_MIME_CANDIDATES: readonly string[] = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/aac',
  'audio/ogg;codecs=opus',
];

/**
 * 実行環境が録音できる mimeType を選ぶ。
 *
 * @param isSupported ブラウザの `MediaRecorder.isTypeSupported`（テストでは差し替える）
 * @returns 使う mimeType。空文字列は「指定せずブラウザ既定に任せる」を意味する。
 */
export function pickGdRecorderMimeType(isSupported: (mime: string) => boolean): string {
  for (const mime of GD_VOICE_RECORDER_MIME_CANDIDATES) {
    try {
      if (isSupported(mime)) return mime;
    } catch {
      // isTypeSupported が throw する実装があるため握りつぶして次候補へ。
    }
  }
  return '';
}

/**
 * server が受理する音声 mime（コンテナ）。
 * MediaRecorder の出力は `audio/webm;codecs=opus` のように codec 付きで来るため、
 * 判定は必ず `baseAudioMime()` で `;` 以降を落としてから行う。
 */
export const GD_VOICE_ALLOWED_MIME: readonly string[] = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/x-m4a',
  'audio/m4a',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
];

/** `audio/webm;codecs=opus` → `audio/webm`。空入力は空文字列。 */
export function baseAudioMime(raw: string | null | undefined): string {
  return (raw ?? '').split(';')[0].trim().toLowerCase();
}

/** server 側の受理判定（route と client の事前チェックで同じ関数を使う）。 */
export function isAllowedGdAudioMime(raw: string | null | undefined): boolean {
  const base = baseAudioMime(raw);
  return base !== '' && GD_VOICE_ALLOWED_MIME.includes(base);
}

// ── 文字起こしの採否 ─────────────────────────────────────────────────

/**
 * Whisper が無音・雑音に対して返しがちな定型出力。これらは「発言なし」として捨てる。
 *
 * ★ これを捨てないと、マイクを押しただけで「ご視聴ありがとうございました」等が
 *   議論ログに入り、評価 API がそれを発言として採点してしまう。
 */
const GD_VOICE_NOISE_TRANSCRIPTS: readonly string[] = [
  'ご視聴ありがとうございました',
  'ご視聴ありがとうございました。',
  'ありがとうございました',
  'ありがとうございました。',
  'おやすみなさい',
  'おやすみなさい。',
  'チャンネル登録お願いします',
  'エンディング',
  'thank you for watching',
  'thanks for watching',
  'you',
  '.',
  '。',
];

/**
 * 文字起こしを発言として採用してよいか。
 *
 * 採用しない条件:
 *   - trim 後が空
 *   - 記号・句読点だけ
 *   - Whisper の無音時定型出力（上記リスト・大小文字と前後空白を無視して一致）
 */
export function isUsableGdTranscript(raw: string | null | undefined): boolean {
  const text = (raw ?? '').trim();
  if (!text) return false;
  // 記号・空白・句読点のみ（日本語の句読点と記号類を含む）は無効。
  if (!/[\p{L}\p{N}]/u.test(text)) return false;
  const normalized = text.toLowerCase().replace(/\s+/g, '');
  return !GD_VOICE_NOISE_TRANSCRIPTS.some(
    (noise) => noise.toLowerCase().replace(/\s+/g, '') === normalized,
  );
}

/** 発言として保存する形へ整える（trim + 上限切り詰め）。 */
export function normalizeGdTranscript(raw: string | null | undefined): string {
  return (raw ?? '').trim().slice(0, GD_VOICE_MAX_TRANSCRIPT_CHARS);
}

// ── AI の声（persona 別）────────────────────────────────────────────

export type GdTtsDelivery = {
  /** OpenAI TTS の voice 名。 */
  voice: string;
  /** 読み上げ速度（[0.25, 4.0]）。GD は聞き取りやすさ優先でやや遅め〜等速。 */
  speed: number;
  /** ステアリング対応モデル（gpt-4o 系）にだけ送られる話し方指示。 */
  instructions: string;
};

/**
 * GD の話者 key → 声。
 *
 * key は `app/api/career/gd/room/aiMembers.ts` の `persona_key`（10 タイプ）に
 * 進行アナウンス用の `moderator` を足したもの。
 *
 * ★ 声を persona ごとに分ける理由は演出ではない。**全員が同じ声だと、音声だけで
 *   進行する GD では「今の発言は誰か」が判別できなくなる**（テキスト GD では
 *   名前ラベルが担っていた役割を、音声では声色が担う）。
 */
export const GD_TTS_DELIVERY_BY_PERSONA: Readonly<Record<string, GdTtsDelivery>> = {
  leader: {
    voice: 'sage',
    speed: 1,
    instructions: '議論を進行するリーダー役。落ち着いて明瞭に、要点を区切って話す。',
  },
  logical: {
    voice: 'echo',
    speed: 1,
    instructions: '論理的で淡々とした口調。根拠を示す部分をわずかに強調する。',
  },
  idea: {
    voice: 'nova',
    speed: 1.05,
    instructions: '明るく前向きに、思いついたことを弾むように話す。',
  },
  cautious: {
    voice: 'ballad',
    speed: 0.95,
    instructions: '慎重で丁寧な口調。リスクに触れる部分はややゆっくり話す。',
  },
  cooperative: {
    voice: 'coral',
    speed: 1,
    instructions: '柔らかく協調的な口調。相手の発言を受けとめる温度感で話す。',
  },
  data: {
    voice: 'onyx',
    speed: 0.98,
    instructions: '落ち着いた低めの声。数字や事例は聞き取りやすくはっきり読む。',
  },
  critical: {
    voice: 'ash',
    speed: 1,
    instructions: '鋭く率直な口調。ただし攻撃的・侮辱的にはしない。',
  },
  quiet: {
    voice: 'alloy',
    speed: 0.95,
    instructions: '控えめで静かな口調。声量は小さめだが語尾まで明瞭に。',
  },
  runaway: {
    voice: 'verse',
    speed: 1.12,
    instructions: '勢いよく早口ぎみ。ただし聞き取れなくなるほどは崩さない。',
  },
  indecisive: {
    voice: 'fable',
    speed: 0.95,
    instructions: '迷いのある口調。語尾をやや弱めるが、聞き取れる明瞭さは保つ。',
  },
  moderator: {
    voice: 'shimmer',
    speed: 1,
    instructions: 'GD の進行アナウンス。事務的で明瞭、感情を込めすぎず短く伝える。',
  },
};

/** 未知 key（旧 room・想定外 persona）に使う既定の声。 */
export const GD_TTS_DEFAULT_DELIVERY: GdTtsDelivery = {
  voice: 'alloy',
  speed: 1,
  instructions: 'グループディスカッションの参加者として、落ち着いて明瞭に話す。',
};

/** 話者 key → 声。未知なら既定。 */
export function gdTtsDeliveryFor(personaKey: string | null | undefined): GdTtsDelivery {
  const key = (personaKey ?? '').trim();
  return GD_TTS_DELIVERY_BY_PERSONA[key] ?? GD_TTS_DEFAULT_DELIVERY;
}

/**
 * participantId から persona key を復元する。
 *
 * マルチ GD の AI participant_id は `gdai-<roomId>-<persona_key>` という決定的な形
 * （aiMembers.ts）。member 行の persona を取れない場面（TTS の再生キューだけを
 * 持っている等）でも声を安定させるための補助。復元できなければ null。
 */
export function gdPersonaKeyFromParticipantId(participantId: string | null | undefined): string | null {
  const id = (participantId ?? '').trim();
  if (!id.startsWith('gdai-')) return null;
  const key = id.slice(id.lastIndexOf('-') + 1);
  return key && GD_TTS_DELIVERY_BY_PERSONA[key] ? key : null;
}

// ── ソロ GD の AI 話者 → 声 ──────────────────────────────────────────

/**
 * ソロ GD の AI 参加者には persona_key が無い（`gdRoles.ts` 由来の style だけを持つ）。
 * 参加者一覧内の**並び順**で声を決定的に割り当てることで、同じセッション中は
 * 同じ AI が常に同じ声で話す（再読込しても変わらない）。
 */
export const GD_SOLO_VOICE_ROTATION: readonly string[] = [
  'echo',
  'nova',
  'ballad',
  'coral',
  'onyx',
  'ash',
  'verse',
  'fable',
];

/** ソロ GD 用: AI の並び順 index → 声。 */
export function gdSoloTtsDeliveryFor(aiIndex: number): GdTtsDelivery {
  const safe = Number.isFinite(aiIndex) && aiIndex >= 0 ? Math.floor(aiIndex) : 0;
  const voice = GD_SOLO_VOICE_ROTATION[safe % GD_SOLO_VOICE_ROTATION.length];
  return { ...GD_TTS_DEFAULT_DELIVERY, voice };
}

// ── WebRTC mesh の ICE 設定 ─────────────────────────────────────────

export type GdIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

/**
 * TURN を持たない場合の既定 STUN。
 *
 * ★ STUN だけでは **対称 NAT（一部のモバイル回線・企業 NW）配下のユーザーで
 *   P2P が張れない**。その場合 mesh は「相手の声が聞こえない」状態になる。
 *   本番で取りこぼしを無くすには **server 発行の TURN** を使う
 *   （GET /api/career/gd/voice/ice ＝ CLOUDFLARE_TURN_KEY_ID / _API_TOKEN）。
 *   ★ NEXT_PUBLIC_CAREER_GD_ICE_SERVERS へ TURN credential を入れてはいけない。
 *     build 時に client bundle へ inline され、誰でも取り出せる中継になる。
 *   到達不能は UI 側で必ず可視化する（無言で音が来ないのが最悪の失敗）。
 */
export const GD_DEFAULT_ICE_SERVERS: readonly GdIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * env の JSON 文字列 → ICE サーバ配列。
 * 壊れた JSON / 想定外の形は **既定 STUN に倒す**（例外で GD を止めない）。
 */
export function parseGdIceServers(raw: string | null | undefined): GdIceServer[] {
  const text = (raw ?? '').trim();
  if (!text) return [...GD_DEFAULT_ICE_SERVERS];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [...GD_DEFAULT_ICE_SERVERS];
  }
  if (!Array.isArray(parsed)) return [...GD_DEFAULT_ICE_SERVERS];
  const out: GdIceServer[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const urls =
      typeof e.urls === 'string'
        ? e.urls
        : Array.isArray(e.urls) && e.urls.every((u) => typeof u === 'string')
          ? (e.urls as string[])
          : null;
    if (!urls) continue;
    const server: GdIceServer = { urls };
    if (typeof e.username === 'string') server.username = e.username;
    if (typeof e.credential === 'string') server.credential = e.credential;
    out.push(server);
  }
  return out.length > 0 ? out : [...GD_DEFAULT_ICE_SERVERS];
}

// ── mesh の接続方向（glare 回避）───────────────────────────────────
//
// 全結合 mesh では 2 者が同時に offer を出すと衝突する（glare）。
// 「participantId が辞書順で小さい側だけが offer を出す」という決定的な規則にすれば、
// 追加の合意プロトコルなしに衝突が起きない。

/** 自分が相手に対して offer を出す側か（true = offer 側 / false = answer 側）。 */
export function shouldInitiateGdPeer(selfParticipantId: string, peerParticipantId: string): boolean {
  return selfParticipantId < peerParticipantId;
}
