/**
 * 在任何读取 process.env 的模块之前，以副作用方式加载项目根目录的 .env。
 *
 * Agent 进程的工作目录是 apps/agent，而约定把 .env 放在 monorepo 根目录，
 * 因此这里按当前文件位置显式定位根目录，而不是依赖 cwd。
 *
 * 注意：本模块必须在 index.ts 中**最先**被 import，
 * 以保证 config.ts 读取环境变量时 .env 已生效。
 */
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// src/load-env.ts 与编译后的 dist/load-env.js 都位于各自基目录下一层，
// 因此 ../../../ 均指向 monorepo 根目录。
const here = dirname(fileURLToPath(import.meta.url));
const rootEnvPath = resolve(here, '../../../.env');

loadEnv({ path: rootEnvPath });
