import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 一時的なデバッグ用スクリプト（.tmp_ 接頭辞）は lint 対象外（リポジトリ管理対象でない）。
    ".tmp_*",
    // Playwright E2E は独自の TS 解決で実行するため app の lint 対象外（STEP-GD-20-H）。
    "tests/**",
    "playwright.config.ts",
  ]),
]);

export default eslintConfig;
