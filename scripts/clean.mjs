#!/usr/bin/env node
/** 清理构建产物与临时测试目录。 */

import { rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const target of ['dist', '.tmp-test']) {
  rmSync(resolve(root, target), { recursive: true, force: true });
}
console.log('🧹 已清理 dist 与 .tmp-test');
