type Props = {
  onBack: () => void;
};

// 就活版 活動整理の保存完了画面。
// 受験版 components/activity/ActivitySubmitSuccess.tsx をそのまま踏襲。
// 受験版は「AI壁打ち・活動まとめ（/analyze）」へ進むが、就活版では自己分析ハブ
// （/career/self-analysis）へ接続する。あわせてホーム（/career/home）への戻り導線も残す。
export default function ActivitySubmitSuccess({ onBack }: Props) {
  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
        <p className="text-green-800 text-lg font-medium">保存しました</p>
        <p className="text-green-600 mt-2 text-sm">活動データを保存しました</p>
        <div className="mt-5 flex flex-col sm:flex-row gap-3 justify-center">
          <a
            href="/career/self-analysis"
            className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6 py-2 rounded-lg text-sm transition-colors"
          >
            AI壁打ち・活動まとめへ進む →
          </a>
          <a
            href="/career/home"
            className="text-sm text-gray-600 border border-gray-300 rounded-lg px-4 py-2 hover:bg-gray-50 transition-colors"
          >
            ホームへ戻る
          </a>
          <button
            type="button"
            onClick={onBack}
            className="text-sm text-green-700 border border-green-300 rounded-lg px-4 py-2 hover:bg-green-50 transition-colors"
          >
            もう一度入力する
          </button>
        </div>
      </div>
    </div>
  );
}
