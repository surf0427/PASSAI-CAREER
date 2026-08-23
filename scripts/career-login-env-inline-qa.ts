/*
 * scripts/career-login-env-inline-qa.ts
 *
 * PASSAI — ログイン公開 env の "build inline 実効性" と "no-env の誤分類" を守る guard。
 *
 * 背景（2026-08-14 production login incident）:
 *   production（当時の deployment URL passai-career.vercel.app。本番 canonical は現在
 *   https://passaicareer.jp）で「ログインコードを送る」が
 *   「ストレージに接続できません。少し時間をおいて再度お試しください。」で失敗していた。
 *   真因は storage/DB/OTP/email ではなく **Vercel Production build に NEXT_PUBLIC_SUPABASE_URL /
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY が無かったこと**。Next.js は client bundle へ公開 env を
 *   build 時に inline するため、build 環境に無ければ browser では永久に undefined になり、
 *   getSupabaseEnv() -> null -> getBrowserSupabaseClient() -> null -> { kind: 'no-env' } となる。
 *
 *   配信物における決定的な signature（本 QA の検出原理）:
 *     - env が build 時に **有る**  -> 値が literal 置換され、`process.env.X` 参照は **消える**
 *     - env が build 時に **無い**  -> 置換されず `process.env.X` 参照が client chunk に **残る**
 *   （ローカル実測で確認済み: 設定済みの SUPABASE 系は残存 0 / 未設定の CAREER 系は残存あり）
 *
 * 本 QA の 3 つの check:
 *   [1] no-env taxonomy guard（static）
 *       設定不備である no-env を「ストレージに接続できません…再度お試しください」という
 *       transient failure 文言で出していないこと。incident 当時の code では FAIL する。
 *   [2] production preflight（build 環境で実効）
 *       VERCEL_ENV=production / NODE_ENV=production の build 環境では、公開 env が
 *       必須。欠けていれば fail closed（壊れたログインを出荷させない）。
 *   [3] build artifact inline 検証（.next がある時のみ）
 *       build 時に存在した公開 env が、client chunk で確実に literal 置換されていること。
 *
 * ★ secret hygiene: env の実値は一切表示しない（present/absent と件数のみ）。
 *   実 Supabase へ接続しない。OTP を送らない。ユーザーを作らない。
 *
 * 使い方: npx tsx scripts/career-login-env-inline-qa.ts
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
let failures = 0;

const check = (ok: boolean, name: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) failures++;
};
const info = (msg: string) => console.log(`  INFO  ${msg}`);

/** 公開（client inline 対象）env と、それを必要とするログイン導線。 */
const PUBLIC_LOGIN_ENV = [
  { key: 'NEXT_PUBLIC_SUPABASE_URL', surface: '受験版 /login' },
  { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', surface: '受験版 /login' },
  { key: 'NEXT_PUBLIC_CAREER_SUPABASE_URL', surface: '就活版 /career/login' },
  { key: 'NEXT_PUBLIC_CAREER_SUPABASE_ANON_KEY', surface: '就活版 /career/login' },
] as const;

/* ------------------------------------------------------------------ *
 * [1] no-env taxonomy guard（static）
 * ------------------------------------------------------------------ */
console.log('[1] no-env を transient failure として表示していないこと（誤分類 guard）');

/** incident 当時、設定不備がこの文言で出ていた。時間経過では解消しないので retry 案内は誤り。 */
const TRANSIENT_STORAGE_PHRASE = 'ストレージに接続できません';

// CAREER 側の OTP フォーム本体は login / register 共有の CareerEmailOtpForm に集約済み
// （page.tsx は mode を渡すだけ）。no-env 文言の実体はそちらにある。
const LOGIN_PAGES = [
  'app/login/page.tsx',
  'app/career/components/CareerEmailOtpForm.tsx',
];

for (const rel of LOGIN_PAGES) {
  const src = readFileSync(join(ROOT, rel), 'utf8');

  // no-env 分岐だけを切り出し、その中に transient 文言が無いことを見る。
  // （他 branch の "ストレージ…" 文言まで巻き込んで誤検知しないため）
  const noEnvBlocks = [...src.matchAll(/result\.kind === ['"]no-env['"]\s*\)\s*\{([\s\S]*?)\n    \}/g)].map(
    (m) => m[1],
  );

  check(noEnvBlocks.length >= 2, `${rel}: no-env 分岐を send/verify の 2 箇所で検出`);
  for (const [i, rawBlock] of noEnvBlocks.entries()) {
    // 行コメントを除去してから判定する（説明コメント中の語で誤検知しないため。
    // 見たいのは「UI へ出す文言」であってコメントではない）。
    const block = rawBlock.replace(/^\s*\/\/.*$/gm, '');
    check(
      !block.includes(TRANSIENT_STORAGE_PHRASE),
      `${rel}: no-env 分岐[${i}] が「${TRANSIENT_STORAGE_PHRASE}」を使わない`,
    );
    check(
      !/再度お試しください/.test(block),
      `${rel}: no-env 分岐[${i}] が retry を促さない（設定不備は時間で解消しない）`,
    );
  }

  // 内部例外 / env 名 / URL / key を UI へ出していないこと（secret hygiene）。
  for (const { key } of PUBLIC_LOGIN_ENV) {
    check(!src.includes(key), `${rel}: env 名 ${key} を UI 文言へ露出しない`);
  }
}

/* ------------------------------------------------------------------ *
 * [2] production preflight（build 環境でのみ実効・fail closed）
 * ------------------------------------------------------------------ */
console.log('[2] production build 環境の公開 env preflight（値は非表示）');

const isProductionBuildEnv =
  process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';

/**
 * build 時に env が「有った」かの判定。
 * `next build` は `.env.local` も読み込むため、process.env だけでは
 * ローカル build の入力を再現できない（本 QA は build とは別プロセス）。
 * ★ key の有無だけを取り出し、値は保持も表示もしない。
 */
function localEnvKeysPresent(): Set<string> {
  const out = new Set<string>();
  const p = join(ROOT, '.env.local');
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && m[2].trim() !== '') out.add(m[1]);
  }
  return out;
}

const dotEnvKeys = localEnvKeysPresent();

const presence = PUBLIC_LOGIN_ENV.map(({ key, surface }) => {
  const raw = process.env[key];
  const present = (typeof raw === 'string' && raw.trim() !== '') || dotEnvKeys.has(key);
  return { key, surface, present };
});

if (isProductionBuildEnv) {
  for (const { key, surface, present } of presence) {
    check(present, `production build: ${key} が設定されている（${surface} の前提）`);
  }
} else {
  info(
    `非 production 実行のため preflight は assert しない（VERCEL_ENV=${
      process.env.VERCEL_ENV ?? '(unset)'
    } NODE_ENV=${process.env.NODE_ENV ?? '(unset)'}）`,
  );
  for (const { key, present } of presence) {
    info(`  ${key}: present=${present}`);
  }
}

/* ------------------------------------------------------------------ *
 * [3] build artifact inline 検証（.next がある時のみ）
 * ------------------------------------------------------------------ */
console.log('[3] client bundle の inline 実効性（.next/static/chunks を検査）');

const CHUNK_DIR = join(ROOT, '.next/static/chunks');

function collectJs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) collectJs(p, acc);
    else if (entry.endsWith('.js')) acc.push(p);
  }
  return acc;
}

if (!existsSync(CHUNK_DIR)) {
  info('.next/static/chunks が無いため skip（`npm run build` 後に再実行すると検査される）');
} else {
  const files = collectJs(CHUNK_DIR);
  info(`client chunks: ${files.length}`);
  const sources = files.map((f) => readFileSync(f, 'utf8'));

  for (const { key, surface, present } of presence) {
    // 未置換の `process.env.KEY` 参照が残る = build 時にその env が無かった証跡。
    const unreplaced = sources.filter((s) => s.includes(`env.${key}`)).length;

    if (present) {
      check(
        unreplaced === 0,
        `${key}: build 時に設定済み → 未置換 process.env 参照が残らない（残存 ${unreplaced}）`,
      );
    } else {
      info(
        `${key}: この build 環境では未設定（未置換参照 ${unreplaced} chunk）→ ${surface} は browser で no-env になる`,
      );
    }
  }
}

console.log('');
console.log(
  failures === 0
    ? 'career-login-env-inline-qa: ALL PASS'
    : `career-login-env-inline-qa: ${failures} FAIL`,
);
process.exit(failures === 0 ? 0 : 1);
