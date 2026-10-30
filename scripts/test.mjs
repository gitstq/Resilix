#!/usr/bin/env node
/**
 * 测试脚本。
 *
 * 使用 Node 内置 `node:test` 运行器 + tsc 编译产物，因此测试本身不需要
 * vitest/jest 之类的额外依赖 —— 安装一颗依赖(typescript)就能跑全量测试。
 */

import { execFileSync } from 'node:child_process';
import { rmSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = resolve(root, 'node_modules', 'typescript', 'bin', 'tsc');

rmSync(resolve(root, '.tmp-test'), { recursive: true, force: true });
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.test.json'], { cwd: root, stdio: 'inherit' });

const testDir = resolve(root, '.tmp-test', 'tests');
const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => resolve(testDir, f));

if (files.length === 0) {
  console.error('❌ 未找到任何测试用例');
  process.exit(1);
}

const args = ['--test'];
if (process.argv.includes('--watch')) args.push('--watch');
execFileSync(process.execPath, [...args, ...files], { cwd: root, stdio: 'inherit' });
