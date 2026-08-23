// PASSAI 就活版 — 就活相談AI（司令塔）の入力欄プリフィル層。
//
// 役割: ホームなどからの深リンク（?starter=xxx）を相談入力欄の初期値へ解決する。
//   - 追加 API 呼び出し・DB・localStorage には触れない純粋な定数。
//   - AI プロンプト（トークン）には一切影響しない。入力欄の初期文言のみ。
//
// ★ 履歴: かつてここには「今の状況から相談できます」カードの相談例チップを組み立てる
//   buildConsultationStarters / DEFAULT_CONSULTATION_STARTERS / ConsultationDataFlags があったが、
//   相談画面を ChatGPT 型（Sidebar = 履歴 / Main = 会話 + composer）へ再構成した際に
//   当該カードごと廃止したため削除した（唯一の参照元だった）。深リンクの解決だけが残る。

// ホームの深リンク（?starter=xxx）→ 入力欄へプリフィルする文言のマッピング。
export const CONSULTATION_STARTER_QUERY: Record<string, string> = {
  priority: 'まず就活の現在地を整理して、何から始めるか優先順位を決めたい',
  axis: '就活軸と志望業界・志望企業がズレていないか見てほしい',
  matching: 'マッチング結果をもとに、受ける企業の優先順位を決めたい',
};
