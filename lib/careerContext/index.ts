// PASSAI CAREER Context Layer — 共通 formatter の入口（P2-A）。
//
// 純粋関数のみ（I/O / env / secret なし）。career prompt 向けのテキスト整形・活動圧縮を集約する。
// Memory / CareerProfile 永続化 / Context Orchestrator（getCareerContext）は含まない（P2-B 以降）。

export * from './text';
export * from './activity';
