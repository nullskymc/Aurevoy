import './load-env.js';
import { buildServer } from './server.js';
import { config } from './config.js';
import './tools/builtins.js'; // 副作用导入：注册内置工具（文件/网络）

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`Aurevoy Agent 引擎已启动: http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
