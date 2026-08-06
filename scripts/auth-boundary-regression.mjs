// 本地 API 鉴权边界回归：验证 bootstrap Origin、Bearer token 和 CORS 预检。
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'aurevoy-auth-boundary-token';
const tempRoot = await mkdtemp(join(tmpdir(), 'aurevoy-auth-'));
const workspaceDir = join(tempRoot, 'workspace');
await mkdir(workspaceDir, { recursive: true });

process.env.AUREVOY_API_TOKEN = TOKEN;
process.env.AUREVOY_HOST = '127.0.0.1';
process.env.AUREVOY_TEST_BOOTSTRAP = '1';
process.env.AUREVOY_PORT = '0';
process.env.AUREVOY_DB_PATH = join(tempRoot, 'aurevoy.sqlite');
process.env.AUREVOY_WORKSPACE_DIR = workspaceDir;
process.env.AUREVOY_LLM_PROVIDER = 'openai';
process.env.AUREVOY_LLM_API_KEY = 'test-key';
process.env.AUREVOY_LLM_MODEL = 'auth-fixture-model';
process.env.AUREVOY_MCP_SERVERS_JSON = '';
process.env.AUREVOY_EMBEDDING_PROVIDER = 'off';
process.env.AUREVOY_SKILLS_USER_DIR = join(tempRoot, '.aurevoy', 'skills');
process.env.AUREVOY_SKILLS_BUILTIN_DIR = join(tempRoot, 'skills', 'builtin');

const { initializeUnifiedToolFramework } = await import('../apps/agent/dist/tool/index.js');
initializeUnifiedToolFramework();
const { buildServer } = await import('../apps/agent/dist/server.js');

const app = await buildServer();
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
if (!address || typeof address === 'string') throw new Error('无法取得鉴权回归服务地址');
const baseUrl = `http://127.0.0.1:${address.port}`;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  let data = null;
  try {
    data = await response.json();
  } catch {
    // 预检响应通常没有 JSON body。
  }
  return { response, data };
}

try {
  console.log('API 鉴权与 Origin 边界回归\n');

  const unauthorized = await request('/api/health');
  assert(unauthorized.response.status === 401, '缺失 Bearer token 应返回 401');

  const bootstrapMissingOrigin = await request('/api/auth/bootstrap');
  assert(bootstrapMissingOrigin.response.status === 403, '缺失 Origin 不得 bootstrap 会话');

  const bootstrapDenied = await request('/api/auth/bootstrap', {
    headers: { Origin: 'http://evil.example' },
  });
  assert(bootstrapDenied.response.status === 403, '不在白名单的 Origin 不得 bootstrap 会话');

  const bootstrap = await request('/api/auth/bootstrap', {
    headers: { Origin: 'http://tauri.localhost' },
  });
  assert(bootstrap.response.status === 200 && bootstrap.data?.token === TOKEN, '允许的 Origin 应取得当前启动 token');
  assert(bootstrap.response.headers.get('access-control-allow-origin') === 'http://tauri.localhost', 'bootstrap 应返回精确 ACAO');

  const preflight = await request('/api/health', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://tauri.localhost',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  });
  assert(preflight.response.status < 400, '允许 Origin 的 CORS 预检不应被 token hook 拒绝');

  const authorized = await request('/api/health', {
    headers: {
      Origin: 'http://tauri.localhost',
      Authorization: `Bearer ${TOKEN}`,
    },
  });
  assert(authorized.response.status === 200 && authorized.data?.status === 'ok', '正确 Bearer token 应访问 API');

  const wrong = await request('/api/health', {
    headers: { Authorization: 'Bearer wrong-token' },
  });
  assert(wrong.response.status === 401, '错误 Bearer token 应返回 401');
} finally {
  await app.close();
}

console.log(`\n通过: ${passed}, 失败: ${failed}`);
console.log(`结果: ${failed > 0 ? '❌ 部分失败' : '✅ 全部通过'}`);
process.exit(failed > 0 ? 1 : 0);
