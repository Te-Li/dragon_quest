import { createGameServer, loadConfig } from './server.mjs';

try {
  const config = await loadConfig();
  const server = createGameServer(config);
  server.on('error', error => {
    console.error(`启动失败（${error.code ?? error.message}）。如果端口被占用，请在 model.config.json 中换一个 port。`);
    process.exitCode = 1;
  });
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`勇者逗恶龙 · http://127.0.0.1:${config.port} · ${config.mode === 'api' ? '模型模式' : '本地试玩'}`);
  });
} catch (error) {
  console.error(`配置错误：${error.message}`);
  process.exitCode = 1;
}
