import { buildServer } from './server.js';
import { config } from './config.js';

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
