// 读取项目根目录的 .env。必须在其它模块之前 import——
// steam/covers/store 都会在 import 时读环境变量。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(ROOT, '.env');

try {
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue; // 真实环境变量优先
    const value = rawValue.replace(/^(['"])(.*)\1$/, '$2');
    process.env[key] = value;
  }
} catch {
  /* 没有 .env 就用默认值 */
}

export const ENV_FILE = envPath;
