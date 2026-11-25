import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newGame, takeTurn } from './game.mjs';

test('本地谜题的无关理由得分低，满足条件才能公开谜底', async () => {
  const config = { mode: 'local', winScore: 72 };
  const game = await newGame(config);
  const miss = await takeTurn(config, game, '石头');
  assert.equal(miss.won, false);
  assert.equal(miss.reason, undefined);
  assert.equal(miss.lines.length, 2);
  const hit = await takeTurn(config, game, game.reason);
  assert.equal(hit.won, true);
  assert.equal(hit.reason, game.reason);
  assert.notEqual((await newGame(config, game.reason)).reason, game.reason);
});

test('对话服务生成线索，向量服务决定得分与通关', async context => {
  const reason = '公主今晚要主持幽灵舞会。只有她记得开场舞的舞步。';
  const endpoints = [];
  const chatReply = body => Response.json({ choices: [{ message: { content: JSON.stringify(body) } }] });
  const config = {
    mode: 'api', similarityFloor: 0.2, winScore: 72,
    chat: { baseUrl: 'https://chat.example/v1', apiKey: 'a', model: 'MiniMax-M3.1-Flash' },
    embedding: { baseUrl: 'https://vectors.example/v1', apiKey: 'b', model: 'vectors' },
  };
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    const payload = JSON.parse(options.body);
    endpoints.push(url);
    if (url.endsWith('/embeddings')) {
      assert.equal(options.headers.Authorization, 'Bearer b');
      const vectors = { 石头: [0, 1], 舞会: [0.6, 0.8], 鬼魂晚宴: [0.6, 0.8], 亡魂舞宴: [0.98, 0.2] };
      if (Array.isArray(payload.input)) {
        assert.equal(payload.input.includes('明天派对'), false);
        const data = payload.input.map((text, index) => ({ index, embedding: vectors[text] ?? [1, 0] }));
        return Response.json({ data: data.reverse() });
      }
      const vector = vectors[payload.input] ?? [1, 0];
      return Response.json({ data: [{ embedding: vector }] });
    }
    assert.equal(options.headers.Authorization, 'Bearer a');
    assert.equal(payload.reasoning_effort, 'low');
    assert.ok(payload.max_tokens > 500);
    const input = JSON.parse(payload.messages[1].content);
    if (!input.guess) return chatReply({ reason, keywords: [
      { keyword: '幽灵舞会', candidates: ['明天派对', '鬼魂晚宴', '亡魂舞宴'], template: '今晚要办一场{word}' },
      { keyword: '开场舞', candidates: ['开幕舞蹈', '首支舞'], template: '大家都等着跳{word}' },
      { keyword: '舞步', candidates: ['脚步动作', '跳舞步法'], template: '只有她记得那套{word}' },
      { keyword: '主持', candidates: ['主办', '掌管'], template: '她要亲自{word}这场聚会' },
    ] });
    if (input.guess === reason) return chatReply({ acknowledge: '既然她还记得舞步，我就不耽误了', release: '公主，快回去领舞吧' });
    assert.equal(JSON.stringify(input).includes(reason), false);
    if (input.guess === '舞会') return new Response(null, { status: 503 });
    assert.equal(input.requiredWord, '亡魂舞宴');
    return chatReply({ rebuttal: '我又不是石匠', hint: '明天要办一场亡魂舞宴' });
  });

  const game = await newGame(config);
  const miss = await takeTurn(config, game, '石头');
  assert.deepEqual(miss, { turn: 1, score: 0, won: false, lines: ['我又不是石匠。', '今晚要办一场亡魂舞宴。'] });
  await assert.rejects(takeTurn(config, game, '舞会'), /HTTP 503/);
  const hit = await takeTurn(config, game, reason);
  assert.equal(hit.score, 100);
  assert.equal(hit.reason, reason);
  assert.deepEqual(hit.lines, ['既然她还记得舞步，我就不耽误了。', '公主，快回去领舞吧。']);
  assert.equal(endpoints.filter(url => url === 'https://vectors.example/v1/embeddings').length, 4);
  assert.equal(endpoints.filter(url => url === 'https://chat.example/v1/chat/completions').length, 4);
});

test('反问过滤、四条线索轮换及提示意象与临时表情区分', async context => {
  const requests = [];
  const reviews = [];
  const hints = ['广场在办厨艺比赛。', '桌上摆着奶酪和烤模。', '入围甜点的顶上有一层焦色。', '只有公主能做焦糖。'];
  const guesses = ['我要拿金币交换公主', '我请你吃面包', '她要回家睡觉', '我可以送你一瓶酒', '让她回去修石塔'];
  const config = {
    mode: 'api', similarityFloor: 0.2, winScore: 72,
    chat: { baseUrl: 'https://chat.example/v1', apiKey: 'a', model: 'Qwen3.8-Flash' },
    embedding: { baseUrl: 'https://vectors.example/v1', apiKey: 'b', model: 'vectors' },
  };
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/embeddings')) return Response.json({ data: [{ embedding: [0, 1] }] });
    const { messages } = JSON.parse(options.body);
    const input = JSON.parse(messages[1].content);
    if (input.guesses) {
      reviews.push(input);
      return Response.json({ choices: [{ message: { content: '{"keyword":null}' } }] });
    }
    requests.push(input);
    const reply = {
      [guesses[0]]: input.revision ? '金币只会磕我的牙。' : '金币？',
      [guesses[1]]: '面包？面包可塞不住我耳朵里的饿狼。',
      [guesses[2]]: '回家睡觉？',
      [guesses[3]]: '我喝酒之前可从来不用换人。',
      [guesses[4]]: '石塔里缺人手也轮不到她。',
    }[input.guess];
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      rebuttal: reply, hint: `哼，${input.clue}`, emojis: [
        { emoji: '🍰', cue: '厨艺比赛', kind: 'image' }, { emoji: '🍰', cue: '甜点', kind: 'image' },
        { emoji: '🧀', cue: '奶酪', kind: 'image' }, { emoji: '🍬', cue: '焦糖', kind: 'image' },
        { emoji: '😤', cue: '哼', kind: 'reaction' }, { emoji: '🪙', cue: '金币', kind: 'image' },
        { emoji: '🐦‍⬛', cue: '乌鸦', kind: 'image' },
        { emoji: '错误内容', cue: input.clue },
      ],
    }) } }] });
  });

  const hintWords = ['厨艺比赛', '奶酪', '甜点', '焦糖'];
  const game = { reason: '公主必须参加厨艺比赛，用奶酪做甜点并加上焦糖。', vector: [1, 0],
    clues: hints.map((hint, index) => ({ keyword: hintWords[index], word: hintWords[index], hint })), history: [] };
  const expected = ['金币只会磕我的牙。', '面包可塞不住我耳朵里的饿狼。', '你还没说她离开后能办成什么，我没理由松爪。',
    '我喝酒之前可从来不用换人。', '石塔里缺人手也轮不到她。'];
  const clueIcons = ['🍰', '🧀', '🍰', '🍬'];
  for (const [index, guess] of guesses.entries()) {
    const result = await takeTurn(config, game, guess);
    const clueIndex = index % hints.length;
    assert.deepEqual(result.lines, [expected[index], `哼，${hints[clueIndex]}`]);
    assert.deepEqual(result.hintEmojis, [clueIcons[clueIndex]]);
    assert.deepEqual(result.emojis, [clueIcons[clueIndex], '😤', ...(index === 0 ? ['🪙'] : [])]);
    game.history.push({ guess, score: result.score, rebuttal: result.lines[0], hint: result.lines[1] });
  }
  assert.deepEqual(requests.map(({ guess, revision }) => [guess, Boolean(revision)]), [
    [guesses[0], false], [guesses[0], true], [guesses[1], false], [guesses[2], false], [guesses[2], true],
    [guesses[3], false], [guesses[4], false],
  ]);
  assert.equal(requests.at(-1).requiredWord, hintWords[0]);
  assert.deepEqual(requests.at(-1).previousHints, hints.map(hint => `哼，${hint}`));
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].guesses[0], guesses[4]);
  assert.equal(reviews[0].shownHints.length, 4);
});

test('玩家猜出一半时从另一部分提词，并复用近义词排序', async context => {
  const reason = '公主必须去丰收巡游，乘坐巨型南瓜车。只有她能在车队最前头领路，否则后面的车会撞进护城河。';
  const guess = '公主必须乘坐巨型南瓜车参加丰收巡游。';
  const clues = [
    { keyword: '丰收巡游', word: '庆收游行', hint: '广场正筹备庆收游行。', lastShown: 1 },
    { keyword: '巨型南瓜车', word: '巨瓜花车', hint: '她的车是一辆巨瓜花车。' },
    { keyword: '南瓜', word: '橙瓜', hint: '看看那颗橙瓜。' },
    { keyword: '乘坐', word: '搭乘', hint: '她得亲自搭乘它。' },
  ];
  const config = {
    mode: 'api', similarityFloor: 0.2, winScore: 72,
    chat: { baseUrl: 'https://chat.example/v1', apiKey: 'a', model: 'Qwen3.8-Flash' },
    embedding: { baseUrl: 'https://vectors.example/v1', apiKey: 'b', model: 'vectors' },
  };
  const game = { reason, clues, vector: [1, 0], history: [{ guess: '她要参加庆典。', score: 32, rebuttal: '那还不够。', hint: clues[0].hint }] };
  const requests = [];
  const reply = content => Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    const payload = JSON.parse(options.body);
    if (url.endsWith('/embeddings')) {
      if (!Array.isArray(payload.input)) return Response.json({ data: [{ embedding: [0.6, 0.8] }] });
      assert.deepEqual(payload.input, ['领路', '陪同', '引路']);
      const vectors = { 领路: [1, 0], 陪同: [0, 1], 引路: [1, 0] };
      return Response.json({ data: payload.input.map(text => ({ embedding: vectors[text] })) });
    }
    const input = JSON.parse(payload.messages[1].content);
    requests.push(input);
    if (input.guesses) {
      assert.equal(input.reason, reason);
      assert.equal(input.guesses[0], guess);
      assert.deepEqual(input.shownHints, [clues[0].hint]);
      return reply({ keyword: '领路', candidates: ['陪同', '引路'], template: '没她在前面{word}，车队就会跑偏' });
    }
    assert.equal(JSON.stringify(input).includes(reason), false);
    assert.equal(input.requiredWord, '引路');
    return reply({ rebuttal: '坐进瓜里这事还说不服我。', hint: '哼，她可要在车队前面引路。' });
  });
  const turn = await takeTurn(config, game, guess);
  assert.equal(turn.score, 50);
  assert.equal(turn.won, false);
  assert.equal(turn.lines[1], '哼，她可要在车队前面引路。');
  assert.equal(requests.length, 2);
  assert.equal(game.clues.at(-1).keyword, '领路');
  assert.equal(game.lastClueReview, 2);
});
