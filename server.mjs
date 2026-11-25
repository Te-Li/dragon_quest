import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { newGame, takeTurn } from './game.mjs';

const staticFiles = {
  '/': ['index.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/app.js': ['app.js', 'text/javascript'],
  '/scene.js': ['scene.js', 'text/javascript'],
  '/dragon-effects.js': ['dragon-effects.js', 'text/javascript'],
};

function modelSetupError(config) {
  for (const name of ['chat', 'embedding']) {
    const service = config[name];
    if (['baseUrl', 'apiKey', 'model'].some(key => typeof service?.[key] !== 'string' || !service[key].trim() || /YOUR[_-]/i.test(service[key]))) {
      return '请在 model.config.json 中填写对话与 Embedding 的 API 地址、密钥和模型名，然后重启服务。';
    }
    const url = URL.parse(service.baseUrl);
    if (!url || !['https:', 'http:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
      return `${name}.baseUrl 必须是服务商的 HTTP(S) API 根地址。修改后请重启服务。`;
    }
  }
}

export async function loadConfig() {
  const defaults = { mode: 'api', debug: false, port: 4173, similarityFloor: 0.2, winScore: 72 };
  const contents = await readFile(new URL('./model.config.json', import.meta.url), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '{}';
    throw error;
  });
  const config = { ...defaults, ...JSON.parse(contents.replace(/^\uFEFF/u, '')) };
  if (!['local', 'api'].includes(config.mode)) throw new Error('mode 必须是 local 或 api');
  if (typeof config.debug !== 'boolean') throw new Error('debug 必须是 true 或 false');
  if (config.frontendOrigin) {
    const frontend = URL.parse(config.frontendOrigin);
    if (frontend?.protocol !== 'https:' || frontend.origin !== config.frontendOrigin) {
      throw new Error('frontendOrigin 必须是前端的 HTTPS 来源，只包含协议、域名和端口');
    }
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('port 必须介于 1 和 65535');
  if (!(config.similarityFloor >= 0 && config.similarityFloor < 1) || !Number.isFinite(config.similarityFloor)) {
    throw new Error('similarityFloor 必须大于等于 0 且小于 1');
  }
  if (!Number.isInteger(config.winScore) || config.winScore < 1 || config.winScore > 100) throw new Error('winScore 必须介于 1 和 100');
  return config;
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) continue;
    chunks.push(chunk);
  }
  if (size > 8192) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

export function createGameServer(config) {
  const sessions = new Map();
  const setupError = config.mode === 'api' && modelSetupError(config);
  const debug = config.debug === true && !config.frontendOrigin;
  return createServer(async (request, response) => {
    const path = request.url;
    try {
      if (request.method === 'GET' && Object.hasOwn(staticFiles, path)) {
        const [file, mime] = staticFiles[path];
        const contents = await readFile(new URL(`./public/${file}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        return response.end(contents);
      }
      const debugRequest = debug && path === '/api/debug/reason';
      if (!debugRequest && !['/api/game', '/api/guess'].includes(path)) {
        return json(response, 404, { error: '找不到这个页面。' });
      }
      const host = request.headers.host;
      const origin = request.headers.origin;
      const fromFrontend = Boolean(config.frontendOrigin && origin === config.frontendOrigin);
      const fromLocal = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(host ?? '') && (!origin || origin === `http://${host}`);
      if (config.frontendOrigin) response.setHeader('Vary', 'Origin');
      if (!fromFrontend && !fromLocal) return json(response, 403, { error: '此来源不能访问试玩接口。' });
      if (fromFrontend) response.setHeader('Access-Control-Allow-Origin', config.frontendOrigin);
      if (request.method === 'OPTIONS' && fromFrontend && request.headers['access-control-request-method'] === 'POST') {
        response.writeHead(204, {
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
        });
        return response.end();
      }
      if (request.method !== 'POST') {
        return json(response, 405, { error: '此接口需要 POST 请求。' });
      }
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
        return json(response, 415, { error: '请求必须使用 JSON。' });
      }
      const input = await body(request);
      if (!input || typeof input !== 'object' || Array.isArray(input)) return json(response, 400, { error: '请求格式有误。' });

      if (path === '/api/game') {
        if (setupError) return json(response, 503, { error: setupError });
        for (const [id, session] of sessions) {
          if (!session.busy && Date.now() - session.activity > 2 * 60 * 60 * 1000) sessions.delete(id);
        }
        const previous = sessions.get(input.previousId);
        if (previous?.busy) return json(response, 409, { error: '恶龙还在回答上一句话。' });
        if (previous) previous.busy = true;
        try {
          const game = await newGame(config, previous?.reason);
          const id = randomUUID();
          sessions.delete(input.previousId);
          sessions.set(id, { ...game, activity: Date.now() });
          return json(response, 201, { id, mode: config.mode, winScore: config.winScore, debug });
        } finally {
          if (previous) previous.busy = false;
        }
      }

      const game = sessions.get(input.id);
      if (!game) return json(response, 404, { error: '这局已经结束或过期，请开启新一局。' });
      if (debugRequest) return json(response, 200, { reason: game.reason });
      if (game.won || game.busy) return json(response, 409, { error: game.won ? '你已经救出公主了。' : '恶龙还在回答上一句话。' });
      const guess = typeof input.guess === 'string' ? input.guess.trim() : '';
      if (!guess || guess.length > 200) return json(response, 400, { error: '请输入 1 到 200 字的理由。' });
      game.busy = true;
      try {
        const result = await takeTurn(config, game, guess);
        game.history.push({ guess, score: result.score, rebuttal: result.lines[0], hint: result.lines[1] });
        game.won = result.won;
        game.activity = Date.now();
        return json(response, 200, result);
      } finally {
        game.busy = false;
      }
    } catch (error) {
      console.error(error.message);
      return json(response, 502, { error: '恶龙暂时没能回应。请重试，或检查终端中的模型接口信息。' });
    }
  });
}
