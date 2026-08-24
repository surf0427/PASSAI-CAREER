// PASSAI 就活版 — GD「Forest Circle」の座席配置（純関数・DOM 非依存）。
//
// 固定座標を人数分ベタ書きせず、participantCount から角度を決める。
//   - index 0（＝自分）を必ず手前中央に置く。
//   - 以降は円周上を等間隔に配置する（3〜8 人、それ以上でも破綻しない）。
//   - 実座標（%）は CSS 側の半径変数（--gdf-rx / --gdf-ry / --gdf-cy）で決めるため、
//     ここでは正規化した cos / sin と奥行きだけを返す（＝レスポンシブは CSS だけで完結する）。

export type GdSeat = {
  /** 水平方向（-1 = 左端, +1 = 右端）。 */
  x: number;
  /** 奥行き方向（-1 = 最奥, +1 = 最前）。 */
  y: number;
  /** 0 = 最奥 / 1 = 最前。scale と z-index に使う。 */
  depth: number;
  /** 遠近感のためのスケール（奥ほど小さい）。 */
  scale: number;
  /** 手前ほど大きい重なり順。 */
  zIndex: number;
};

/** 人数が増えたときに Avatar 全体を縮めて重なりを抑える係数。 */
export function seatSizeFactor(count: number): number {
  if (count <= 5) return 1;
  const shrunk = 1 - (count - 5) * 0.055;
  return Math.max(0.62, Number(shrunk.toFixed(3)));
}

/**
 * count 人ぶんの座席を返す。index 0 が手前中央（自分の席）。
 * 真上から見た真円ではなく「正面〜やや俯瞰」で見るため、CSS 側で縦半径を横半径より小さくする。
 */
export function computeGdSeats(count: number): GdSeat[] {
  const n = Math.max(1, Math.floor(count));
  const seats: GdSeat[] = [];
  for (let i = 0; i < n; i++) {
    // π/2（＝手前中央）を起点に反時計回りへ等分する。
    const angle = Math.PI / 2 + (2 * Math.PI * i) / n;
    const x = round(Math.cos(angle));
    const y = round(Math.sin(angle));
    const depth = round((y + 1) / 2);
    seats.push({
      x,
      y,
      depth,
      scale: round(0.78 + 0.22 * depth),
      zIndex: 10 + Math.round(depth * 20),
    });
  }
  return seats;
}

function round(v: number): number {
  // 浮動小数の揺れで SSR / CSR の style 文字列が変わらないように丸める（hydration mismatch 防止）。
  return Number(v.toFixed(4)) + 0; // -0 を 0 に正規化する
}
