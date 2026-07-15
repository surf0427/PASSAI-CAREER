// career generation job — storage error 型（server-only 非依存）。
//
// repository.ts は 'server-only' を持つため QA(tsx)から import できない。
// error 型は runAttempt / service / QA からも参照するので、'server-only' を持たない
// 本ファイルへ分離する（repository.ts は本ファイルを re-export する）。

export type GenerationJobStorageReason = 'UNDEFINED_TABLE' | 'DB_ERROR';

export class GenerationJobStorageError extends Error {
  readonly reason: GenerationJobStorageReason;
  constructor(reason: GenerationJobStorageReason, message: string) {
    super(message);
    this.name = 'GenerationJobStorageError';
    this.reason = reason;
  }
}
