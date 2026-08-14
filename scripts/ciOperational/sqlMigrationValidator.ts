/*
 * scripts/ciOperational/sqlMigrationValidator.ts
 *
 * PASSAI CAREER — pending migration の **静的実行検証**（Operational Dry-Run / `D-O1`）。
 *
 * ★ 本 harness は **QA 専用**。`app/` の call graph から到達しない場所に置く
 *   （QA `OD-13` が到達性ゼロを固定する）。
 *
 * ── なぜ静的検証なのか（正直に記録する）────────────────────────────
 * 実 DB での apply 検証（Option 1）を試みたが、本環境には
 *   psql / pg_ctl / postgres / docker / Supabase CLI / pg client library
 * が **いずれも存在しない**（監査で確認）。
 * production DB へは絶対に接続しないため、Option 2（parse / 依存 / 順序 /
 * オブジェクト参照 / 冪等性の静的検証）を実施する。
 *
 * 静的検証で **担保できること**:
 *   - statement 分割と種別判定
 *   - transaction 境界
 *   - RLS 有効化と GRANT の順序
 *   - 参照オブジェクトが同一 package 内 or 適用済み DDL に存在すること
 *   - policy / RPC の owner 束縛（auth.uid()）
 *   - 冪等性（IF NOT EXISTS / DROP ... IF EXISTS）
 *
 * 静的検証で **担保できないこと**（誇張しない）:
 *   - 実際の SQL 文法エラー（Postgres parser を通していない）
 *   - 実行時の権限・型エラー
 *   - RLS policy の実効性（実際に別 user で読めないこと）
 *   → これらは実 DB が使える環境で改めて検証する必要がある（`OPERATIONAL_VALIDATION.md` に明記）。
 *
 * pure / deterministic / never-throw。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type SqlStatement = {
  index: number;
  /** コメントを除いた statement 本文。 */
  text: string;
  kind:
    | 'begin'
    | 'commit'
    | 'create_table'
    | 'create_index'
    | 'create_policy'
    | 'drop_policy'
    | 'create_function'
    | 'create_view'
    | 'alter_table_enable_rls'
    | 'alter_view'
    | 'grant'
    | 'revoke'
    | 'comment'
    | 'other';
  /** 対象オブジェクト名（判定できたもの）。 */
  target: string | null;
};

/** `--` 行コメントと `/* *\/` ブロックコメントを除去する。 */
export function stripSqlComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return noBlock
    .split('\n')
    .map((l) => {
      // 文字列リテラル内の `--` は稀なので、行頭〜最初の `--` までを残す簡易処理。
      const i = l.indexOf('--');
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join('\n');
}

/**
 * SQL を statement へ分割する（`$$ ... $$` 本体を 1 statement として扱う）。
 * ★ 完全な parser ではない。dollar-quoted body を保護したうえで `;` 分割する。
 */
export function splitStatements(sqlRaw: string): SqlStatement[] {
  const sql = stripSqlComments(sqlRaw);
  const out: SqlStatement[] = [];
  let buf = '';
  let inDollar = false;
  let i = 0;
  const flush = () => {
    const text = buf.trim();
    buf = '';
    if (text === '') return;
    out.push({ index: out.length, text, kind: classify(text), target: extractTarget(text) });
  };
  while (i < sql.length) {
    if (!inDollar && sql.startsWith('$$', i)) { inDollar = true; buf += '$$'; i += 2; continue; }
    if (inDollar && sql.startsWith('$$', i)) { inDollar = false; buf += '$$'; i += 2; continue; }
    const ch = sql[i];
    if (ch === ';' && !inDollar) { flush(); i += 1; continue; }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

function classify(text: string): SqlStatement['kind'] {
  const t = text.trim().toUpperCase();
  if (/^BEGIN\b/.test(t)) return 'begin';
  if (/^COMMIT\b/.test(t)) return 'commit';
  if (/^CREATE\s+TABLE\b/.test(t)) return 'create_table';
  if (/^CREATE\s+(UNIQUE\s+)?INDEX\b/.test(t)) return 'create_index';
  if (/^CREATE\s+POLICY\b/.test(t)) return 'create_policy';
  if (/^DROP\s+POLICY\b/.test(t)) return 'drop_policy';
  if (/^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/.test(t)) return 'create_function';
  if (/^CREATE\s+(OR\s+REPLACE\s+)?VIEW\b/.test(t)) return 'create_view';
  if (/^ALTER\s+TABLE\b[\s\S]*ENABLE\s+ROW\s+LEVEL\s+SECURITY/.test(t)) return 'alter_table_enable_rls';
  if (/^ALTER\s+VIEW\b/.test(t)) return 'alter_view';
  if (/^GRANT\b/.test(t)) return 'grant';
  if (/^REVOKE\b/.test(t)) return 'revoke';
  if (/^COMMENT\s+ON\b/.test(t)) return 'comment';
  return 'other';
}

function extractTarget(text: string): string | null {
  const patterns: RegExp[] = [
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_."]+)/i,
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-z0-9_]+\s+ON\s+([a-z0-9_."]+)/i,
    /CREATE\s+POLICY\s+"[^"]+"\s+ON\s+([a-z0-9_."]+)/i,
    /DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"[^"]+"\s+ON\s+([a-z0-9_."]+)/i,
    /ALTER\s+TABLE\s+([a-z0-9_."]+)/i,
    /ALTER\s+VIEW\s+([a-z0-9_."]+)/i,
    /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([a-z0-9_."]+)/i,
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z0-9_]+)/i,
    /GRANT\s+[\s\S]+?\s+ON\s+(?:FUNCTION\s+)?([a-z0-9_."]+)/i,
    /REVOKE\s+[\s\S]+?\s+ON\s+(?:FUNCTION\s+)?([a-z0-9_."]+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].replace(/"/g, '').replace(/\(.*$/, '').trim();
  }
  return null;
}

// ── package 全体の読み込み ───────────────────────────────────────────
export type MigrationFile = {
  name: string;
  path: string;
  raw: string;
  statements: SqlStatement[];
};

export function loadMigrationPackage(root: string, dir = 'supabase/migrations_pending'): MigrationFile[] {
  const full = join(root, dir);
  return readdirSync(full)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const path = join(full, name);
      const raw = readFileSync(path, 'utf8');
      return { name, path, raw, statements: splitStatements(raw) };
    });
}

/** 既に適用済みの DDL が作る table 名（依存解決に使う）。 */
export function existingTables(root: string): Set<string> {
  const out = new Set<string>();
  const dir = join(root, 'supabase');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const src = stripSqlComments(readFileSync(join(dir, f), 'utf8'));
    for (const m of src.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)/gi)) {
      out.add(m[1].toLowerCase());
    }
  }
  return out;
}

// ── 検証 ────────────────────────────────────────────────────────────
export type ValidationIssue = { file: string; code: string; detail: string };

/** M1: transaction 境界（BEGIN で始まり COMMIT で終わる）。 */
export function checkTransactionBoundaries(files: readonly MigrationFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const f of files) {
    const kinds = f.statements.map((s) => s.kind);
    if (kinds[0] !== 'begin') issues.push({ file: f.name, code: 'M1_NO_BEGIN', detail: 'BEGIN で始まっていない' });
    if (kinds[kinds.length - 1] !== 'commit') {
      issues.push({ file: f.name, code: 'M1_NO_COMMIT', detail: 'COMMIT で終わっていない' });
    }
    if (kinds.filter((k) => k === 'begin').length !== 1 || kinds.filter((k) => k === 'commit').length !== 1) {
      issues.push({ file: f.name, code: 'M1_NESTED_TX', detail: 'BEGIN/COMMIT が 1 組でない' });
    }
  }
  return issues;
}

/**
 * M2: table を作る file では、その table への GRANT が
 * **ENABLE ROW LEVEL SECURITY より後**であること。
 */
export function checkRlsBeforeGrant(files: readonly MigrationFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const f of files) {
    const created = new Set<string>();
    const rlsEnabled = new Map<string, number>();
    for (const s of f.statements) {
      if (s.kind === 'create_table' && s.target) created.add(s.target.toLowerCase());
      if (s.kind === 'alter_table_enable_rls' && s.target) rlsEnabled.set(s.target.toLowerCase(), s.index);
      if (s.kind === 'grant' && s.target) {
        const t = s.target.toLowerCase();
        if (!created.has(t)) continue; // この file で作った table のみ対象
        const at = rlsEnabled.get(t);
        if (at === undefined) {
          issues.push({ file: f.name, code: 'M2_GRANT_WITHOUT_RLS', detail: `${t} に RLS 未設定で GRANT` });
        } else if (at > s.index) {
          issues.push({ file: f.name, code: 'M2_GRANT_BEFORE_RLS', detail: `${t} の GRANT が RLS 有効化より前` });
        }
      }
    }
    // この file で作った table すべてに RLS が有効化されていること。
    for (const t of created) {
      if (!rlsEnabled.has(t)) {
        issues.push({ file: f.name, code: 'M2_TABLE_WITHOUT_RLS', detail: `${t} に RLS 有効化が無い` });
      }
    }
  }
  return issues;
}

/** M10: 途中で失敗しても partial exposure が起きない（GRANT が transaction 内）。 */
export function checkNoPartialExposure(files: readonly MigrationFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const f of files) {
    const beginAt = f.statements.findIndex((s) => s.kind === 'begin');
    const commitAt = f.statements.findIndex((s) => s.kind === 'commit');
    for (const s of f.statements) {
      if (s.kind !== 'grant') continue;
      if (beginAt < 0 || commitAt < 0 || s.index < beginAt || s.index > commitAt) {
        issues.push({ file: f.name, code: 'M10_GRANT_OUTSIDE_TX', detail: 'GRANT が transaction 外' });
      }
    }
  }
  return issues;
}

/** 参照するオブジェクトが同 package 内 or 適用済み DDL に存在する（依存順序）。 */
export function checkObjectReferences(
  files: readonly MigrationFile[],
  applied: ReadonlySet<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const known = new Set<string>([...applied]);
  for (const f of files) {
    // 先に、この file が作る table を known へ入れる（同一 file 内の前方参照を許す）。
    for (const s of f.statements) {
      if (s.kind === 'create_table' && s.target) known.add(s.target.toLowerCase());
      if (s.kind === 'create_view' && s.target) known.add(s.target.toLowerCase());
    }
    for (const s of f.statements) {
      if (!['create_policy', 'drop_policy', 'alter_table_enable_rls', 'create_index', 'grant'].includes(s.kind)) continue;
      const t = s.target?.toLowerCase();
      if (!t) continue;
      // 関数への GRANT/REVOKE は table 判定から除外。
      if (/^career_(ck_|consent_)?[a-z_]*\(/.test(t)) continue;
      if (s.kind === 'grant' && /\(/.test(s.text) && /ON\s+FUNCTION/i.test(s.text)) continue;
      if (!known.has(t) && !applied.has(t)) {
        issues.push({ file: f.name, code: 'DEP_UNKNOWN_OBJECT', detail: `未知のオブジェクト参照: ${t}` });
      }
    }
  }
  return issues;
}

/** 冪等性: table/index は IF NOT EXISTS、policy は DROP IF EXISTS → CREATE。 */
export function checkIdempotency(files: readonly MigrationFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const f of files) {
    const dropped = new Set<string>();
    for (const s of f.statements) {
      if (s.kind === 'create_table' && !/IF\s+NOT\s+EXISTS/i.test(s.text)) {
        issues.push({ file: f.name, code: 'IDEM_TABLE', detail: `${s.target}: IF NOT EXISTS が無い` });
      }
      if (s.kind === 'create_index' && !/IF\s+NOT\s+EXISTS/i.test(s.text)) {
        issues.push({ file: f.name, code: 'IDEM_INDEX', detail: `${s.target}: IF NOT EXISTS が無い` });
      }
      if (s.kind === 'drop_policy') {
        const m = s.text.match(/DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i);
        if (m) dropped.add(m[1]);
        if (!/IF\s+EXISTS/i.test(s.text)) {
          issues.push({ file: f.name, code: 'IDEM_DROP_POLICY', detail: `${m?.[1]}: IF EXISTS が無い` });
        }
      }
      if (s.kind === 'create_policy') {
        const m = s.text.match(/CREATE\s+POLICY\s+"([^"]+)"/i);
        if (m && !dropped.has(m[1])) {
          issues.push({ file: f.name, code: 'IDEM_POLICY', detail: `${m[1]}: 先行する DROP POLICY IF EXISTS が無い` });
        }
      }
      if (s.kind === 'create_function' && !/OR\s+REPLACE/i.test(s.text)) {
        issues.push({ file: f.name, code: 'IDEM_FUNCTION', detail: `${s.target}: OR REPLACE が無い` });
      }
    }
  }
  return issues;
}

/** M5: RPC が caller-selected UUID を受け取らない（引数に uuid 型が無い）。 */
export function checkNoCallerSelectedUuid(files: readonly MigrationFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const f of files) {
    for (const s of f.statements) {
      if (s.kind !== 'create_function') continue;
      const sig = s.text.slice(0, s.text.indexOf(')') + 1);
      if (/\buuid\b/i.test(sig)) {
        issues.push({ file: f.name, code: 'M5_UUID_ARG', detail: `${s.target}: 引数に uuid 型がある` });
      }
      if (!/auth\.uid\(\)/.test(s.text)) {
        issues.push({ file: f.name, code: 'M5_NO_AUTH_UID', detail: `${s.target}: auth.uid() を使っていない` });
      }
      if (!/SECURITY\s+DEFINER/i.test(s.text)) continue;
      const revoked = f.statements.some(
        (r) => r.kind === 'revoke' && r.text.includes(s.target ?? '') && /anon/i.test(r.text),
      );
      if (!revoked) {
        issues.push({ file: f.name, code: 'M5_NO_REVOKE_ANON', detail: `${s.target}: anon から REVOKE していない` });
      }
    }
  }
  return issues;
}

/** M3/M4: member 向け policy が owner scoped か（auth.uid() を含むか）。 */
export function checkOwnerScopedPolicies(files: readonly MigrationFile[]): {
  ownerScoped: string[];
  broad: { file: string; policy: string; detail: string }[];
} {
  const ownerScoped: string[] = [];
  const broad: { file: string; policy: string; detail: string }[] = [];
  for (const f of files) {
    for (const s of f.statements) {
      if (s.kind !== 'create_policy') continue;
      const name = s.text.match(/CREATE\s+POLICY\s+"([^"]+)"/i)?.[1] ?? '(unnamed)';
      if (/auth\.uid\(\)/.test(s.text)) ownerScoped.push(name);
      else broad.push({ file: f.name, policy: name, detail: s.text.replace(/\s+/g, ' ').slice(0, 160) });
    }
  }
  return { ownerScoped, broad };
}

/** anon への GRANT が 1 つも無いこと。 */
export function checkNoAnonGrant(files: readonly MigrationFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const f of files) {
    for (const s of f.statements) {
      if (s.kind === 'grant' && /\bTO\s+[^;]*\banon\b/i.test(s.text)) {
        issues.push({ file: f.name, code: 'ANON_GRANT', detail: s.text.slice(0, 120) });
      }
    }
  }
  return issues;
}

/** M7: published view が禁止 column を SELECT していない。 */
export function checkPublishedViewColumns(
  files: readonly MigrationFile[],
  banned: readonly string[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const f of files) {
    for (const s of f.statements) {
      if (s.kind !== 'create_view') continue;
      for (const b of banned) {
        if (new RegExp(`\\b${b}\\b`).test(s.text)) {
          issues.push({ file: f.name, code: 'M7_VIEW_LEAK', detail: `${s.target}: ${b} を含む` });
        }
      }
      if (!files.some((g) => g.statements.some(
        (v) => v.kind === 'alter_view' && v.target === s.target && /security_invoker\s*=\s*on/i.test(v.text),
      ))) {
        issues.push({ file: f.name, code: 'M7_NO_SECURITY_INVOKER', detail: `${s.target}: security_invoker=on が無い` });
      }
    }
  }
  return issues;
}
