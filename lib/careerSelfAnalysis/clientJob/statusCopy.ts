// 自己分析まとめ生成 — 待機・失敗時のユーザー向け表示コピー（Issue #19）。
//
// pure module（'use client' なし・React/DOM 非依存）。GenerationView から
// 画面に出す { title, detail } を決めるだけで、生成・保存・遷移には一切関与しない。
//
// UI（run/page.tsx）と QA の両方がここを参照する。page.tsx から分離してあるのは、
// 表示契約を「React コンポーネントを起動せずに」検証できるようにするため。
//
// 設計上の約束（QA が検証する）:
//   - state だけでなく errorCode / canRetry / canRecheck も見て文言を決める。
//   - **canRetry=false のときに「もう一度試す」旨を書かない**。retry ボタンは canRetry でしか
//     描画されないため、書くと「案内はあるがボタンが無い」矛盾になる。
//     その場合は代わりに、常に押せる主ボタン「自己分析を生成する」へ誘導する。
//   - polling 上限到達を接続障害と断定しない（原因の誤帰属を避ける）。
//   - 内部 errorCode・schema/parse 等の開発用語をそのまま画面に出さない。
//   - 進行形（「〜しています」）は、処理が実際に進行中だと確実に言える状態にだけ使う。
//     reconnecting は自動確認が停止している場合が多く、確実に継続していると言えないため、
//     「確認できていません」＋手動導線という言い方にする（架空の進行を作らない）。
//   - 具体的な制限時間（分数）は出さない。定数が変わっても陳腐化しないようにする。
//   - retry ボタンの実際の動作は controller.retry() → submit()、すなわち
//     **新しい生成の開始**である。部分的なやり直し（保存だけ再実行など）と
//     読める書き方をしない。

import type { GenerationView } from './types';

export interface GenerationStatusCopy {
  title: string;
  detail: string;
}

export function genStatusCopy(view: GenerationView): GenerationStatusCopy {
  const recheckHint = view.canRecheck
    ? '表示が変わらない場合は「処理状況を再確認」を押してください。'
    : 'ページを再読み込みすると最新の状態を確認できます。';

  switch (view.state) {
    case 'submitting':
      return {
        title: '生成を開始しています',
        detail: '入力内容を確認し、自己分析の作成を開始しています。',
      };

    case 'running':
      return {
        title: '自己分析を作成しています',
        detail: '生成処理が進行中です。このままお待ちください。ページを再読み込みしても復元できます。',
      };

    case 'reconnecting':
      // active polling 上限に達したケースだけは原因が分かっているので、専用の言い方をする。
      // 「接続が不安定」ではなく「時間がかかっている」と伝える（誤帰属を避ける）。
      if (view.errorCode === 'ACTIVE_POLL_LIMIT_REACHED') {
        return {
          title: '生成に通常より時間がかかっています',
          detail:
            '自動確認を停止しました。生成処理が続いている可能性があるため、「処理状況を再確認」を押してください。',
        };
      }
      return {
        title: '処理状況を確認できていません',
        detail: `生成処理は続いている可能性があります。${recheckHint}`,
      };

    case 'failed':
      return genFailedCopy(view);

    default:
      // idle / completed はパネル自体を出さない（呼び出し側で除外済み）。
      return { title: '', detail: '' };
  }
}

// 失敗時の文言。errorCode ごとに「ユーザーが取れる行動」だけを案内する。
function genFailedCopy(view: GenerationView): GenerationStatusCopy {
  // 生成そのものは成功し、保存だけ失敗した場合。
  //   ★ ただし retry() は submit() を呼ぶため、実際には **作成からやり直す**。
  //     「保存だけをやり直せる」と読める書き方をしてはいけない（QA が検証する）。
  if (view.errorCode === 'SAVE_FAILED') {
    return {
      title: '自己分析を保存できませんでした',
      detail: view.canRetry
        ? '自己分析の保存に失敗しました。入力内容は保持されています。「もう一度試す」を押すと、自己分析の作成と保存を再実行します。'
        : '自己分析の保存に失敗しました。入力内容は保持されています。時間を置いてから、もう一度「自己分析を生成する」をお試しください。',
    };
  }

  // ログイン状態を一時的に確認できない。入力は保持されている。
  if (view.errorCode === 'AUTH_TEMPORARILY_UNAVAILABLE') {
    return {
      title: 'ログイン状態を確認できませんでした',
      detail: view.canRetry
        ? '通信状態を確認してから「もう一度試す」を押してください。入力内容は保持されています。'
        : 'しばらく待ってから、もう一度「自己分析を生成する」をお試しください。',
    };
  }

  // 入力が生成条件を満たさない。ユーザー自身が直せる唯一のケース。
  if (view.errorCode === 'INVALID_INPUT') {
    return {
      title: '入力内容を確認してください',
      detail:
        'この内容では自己分析を作成できませんでした。回答を見直してから、もう一度「自己分析を生成する」を押してください。',
    };
  }

  // 上限到達。retry を促さず、時間を置く案内にする。
  if (view.errorCode === 'RETRY_LIMIT_REACHED') {
    return {
      title: '再試行の回数が上限に達しました',
      detail: '時間を置いてから、もう一度「自己分析を生成する」をお試しください。入力内容は保持されています。',
    };
  }

  // 結果を受け取れなかった（内部的には parse / schema 検証の失敗）。
  // 開発用語は出さず、ユーザーから見た事実だけを伝える。
  if (view.errorCode === 'PARSE_FAILED' || view.errorCode === 'SCHEMA_VALIDATION_FAILED') {
    return {
      title: '生成結果を正しく受け取れませんでした',
      detail: 'お手数ですが、もう一度「自己分析を生成する」からやり直してください。入力内容は保持されています。',
    };
  }

  // UNKNOWN / サーバ由来の未知コード。canRetry で案内先を変える。
  return {
    title: '生成を完了できませんでした',
    detail: view.canRetry
      ? '生成を完了できませんでした。入力内容は保持されています。もう一度お試しください。'
      : '時間を置いてから、もう一度「自己分析を生成する」をお試しください。入力内容は保持されています。',
  };
}
