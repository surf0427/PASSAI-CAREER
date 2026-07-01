// PASSAI 就活版 — ソロGD（1人 + AI）練習の実行エントリ（STEP-GD-18）。
// 実体は既存の設定→進行フロー（/career/gd/setup → /career/gd/session）。
// ここは run→result→view の導線を揃えるための正規URLとして、設定画面へ委譲する。
// マルチGD（ルーム）は /career/gd/room 側で別管理（混ぜない）。

import { redirect } from 'next/navigation';

export default function CareerGdRunPage() {
  redirect('/career/gd/setup');
}
