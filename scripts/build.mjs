#!/usr/bin/env node
/**
 * 构建脚本：一次性产出 CJS 与 ESM 两份产物，并写入各自的作用域声明文件。
 *
 * 之所以不用打包器：
 * - 源码本身就是 ESM 友好的纯 TS，两遍 tsc 足够；
 * - 少一层构建依赖，供应链风险与安装体积都更低；
 * - 产物保留原始目录结构，调试时能直接对上源码行。
 */

import { rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = resolve(root, 'node_modules', 'typescript', 'bin', 'tsc');

function run(args) {
  execFileSync(process.execPath, [tsc, ...args], { cwd: root, stdio: 'inherit' });
}

/** 为每个 outDir 写入作用域 package.json，让 Node 正确判定模块格式。 */
function writeScopedManifest(outDir, type) {
  const dir = resolve(root, outDir);
  if (!existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`, 'utf8');
}

rmSync(resolve(root, 'dist'), { recursive: true, force: true });

console.log('▶ 构建 CommonJS 产物 ...');
run(['-p', 'tsconfig.cjs.json']);
writeScopedManifest('dist/cjs', 'commonjs');

console.log('▶ 构建 ESM 产物 ...');
run(['-p', 'tsconfig.esm.json']);
writeScopedManifest('dist/esm', 'module');

console.log('✅ 构建完成: dist/cjs  dist/esm');
