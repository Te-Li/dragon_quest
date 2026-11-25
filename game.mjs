import { randomInt } from 'node:crypto';
import { clueReviewPrompt, keywordGroupCount, puzzlePrompt, rebuttalPrompt, releasePrompt } from './prompts.mjs';

const scenarios = [
  {
    reason: '公主明天要参加王国的巴斯克蛋糕制作大赛。她答应会用亲手烤的蛋糕为这次比赛夺冠。',
    concepts: [
      /巴斯克|焦面|焦顶|焦黑/gu,
      /蛋糕|糕点|甜点|烘焙|烤糕|芝士|乳酪/gu,
      /大赛|比赛|竞赛|参赛|夺冠|冠军|评委|锦标|赛事|比拼/gu,
    ],
    hints: ['王国明天要办一场甜点比赛。', '参赛的人在准备奶油奶酪和烤模。', '公主得亲手烤出一块焦黑表面的蛋糕。'],
  },
  {
    reason: '王都的钟楼停摆了，公主是城里唯一会修齿轮的人。她必须赶在庆典前把钟修好，好让大家听到开场钟声。',
    concepts: [
      /钟楼|大钟|钟声|时钟|报时|敲钟/gu,
      /修|坏|停摆|停了|齿轮|卡住|失灵|调好/gu,
      /庆典|庆祝|节日|典礼|开幕|开场|庆贺/gu,
    ],
    hints: ['庆典就要开始了，城里的大钟却没响。', '有人在钟楼找到了卡住的齿轮。', '城里只有公主懂得怎么修那套机关。'],
  },
  {
    reason: '王国的候鸟迁徙时迷了路，只有公主会吹领航的口哨。她得赶到塔顶把鸟群引回南方的航线。',
    concepts: [
      /鸟|大雁|燕子/gu,
      /口哨|哨声|吹哨|吹口|吹奏|哨子/gu,
      /带路|领路|领航|引路|指路|迷路|迷了路|迁徙|引回|南方|方向|航线/gu,
    ],
    hints: ['一群候鸟绕着王城飞了好几圈，一直找不到南边。', '领头的鸟只听得懂一种特别的口哨声。', '公主必须登上塔顶吹哨，地面上声音传不了那么远。'],
  },
  {
    reason: '公主答应在满月之夜替王国的幽灵开一场舞会。只有她记得第一支舞的舞步，跳完幽灵才能安息。',
    concepts: [
      /鬼|幽灵|亡魂|魂灵|亡灵/gu,
      /舞|跳|华尔兹/gu,
      /圆月|满月|安息|超度|解脱|往生/gu,
    ],
    hints: ['满月这天，王宫舞厅里要来一群幽灵。', '幽灵们在等人带头跳第一支舞。', '公主是唯一还记得开场舞步的人。'],
  },
];

const rebuttals = [
  '这套说辞，我家门铃听了都不响。',
  '你再说一遍，我可能就睡着了。',
  '这理由拿去换面包，老板还得找我要零钱。',
  '我左边的角觉得有道理，可惜是右边的角做主。',
];

async function modelRequest(service, endpoint, payload) {
  const response = await fetch(`${service.baseUrl.replace(/\/+$/, '')}/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${service.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: service.model, ...payload }),
    signal: AbortSignal.timeout(25000),
    redirect: 'error',
  });
  if (!response.ok) throw Object.assign(new Error(`${endpoint} HTTP ${response.status}`), { status: response.status });
  return response.json();
}

async function ask(service, instruction, context, maxTokens = 500) {
  const isMiniMaxFlash = /(?:^|\/)MiniMax-M3\.1-Flash$/i.test(service.model);
  const isQwen38Flash = /(?:^|\/)Qwen3\.8-Flash$/i.test(service.model);
  const result = await modelRequest(service, 'chat/completions', {
    messages: [{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify(context) }],
    ...(isMiniMaxFlash ? { max_tokens: 4096, reasoning_effort: 'low' } : { max_tokens: maxTokens }),
    ...(isQwen38Flash ? { enable_thinking: false, response_format: { type: 'json_object' } } : {}),
  });
  const choice = result.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('对话接口达到输出上限');
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('对话接口未返回最终文本');
  try {
    return JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
  } catch {
    throw Object.assign(new Error('对话接口未返回有效 JSON'), { invalidJson: true });
  }
}

function validateVector(vector) {
  if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite) || !Math.hypot(...vector)) {
    throw new Error('向量接口未返回有效向量');
  }
  return vector;
}

async function embed(service, input) {
  const result = await modelRequest(service, 'embeddings', { input, encoding_format: 'float' });
  return validateVector(result.data?.[0]?.embedding);
}

async function embedMany(service, inputs) {
  try {
    const { data } = await modelRequest(service, 'embeddings', { input: inputs, encoding_format: 'float' });
    const vectors = new Map(data.map(({ index, embedding }, position) => [index ?? position, embedding]));
    if (vectors.size === inputs.length) return inputs.map((_, index) => validateVector(vectors.get(index)));
  } catch (error) {
    if (![400, 413, 422].includes(error.status)) throw error;
  }
  return Promise.all(inputs.map(input => embed(service, input)));
}

function cosineSimilarity(left, right) {
  if (left.length !== right.length) throw new Error('向量长度不符');
  const dot = left.reduce((sum, value, index) => sum + value * right[index], 0);
  return dot / Math.hypot(...left) / Math.hypot(...right);
}

export function similarityScore(left, right, floor) {
  const cosine = cosineSimilarity(left, right);
  return Math.round(Math.min(1, Math.max(0, (cosine - floor) / (1 - floor))) * 100);
}

function timeReferences(text) {
  const markers = text.match(/今[日天夜晚早晨]|明[日天夜晚早晨]|昨[日天夜晚早晨]|前天|后天|午夜|正午|黎明|日落/gu) ?? [];
  return markers.map(marker => marker.replace(/日$/u, '天'));
}

function parsePuzzle(response) {
  const reason = typeof response?.reason === 'string' ? response.reason.trim() : '';
  if (!reason || reason.length > 100 || !Array.isArray(response.keywords) || response.keywords.length !== keywordGroupCount) {
    throw new Error(`对话接口未返回谜底和 ${keywordGroupCount} 组关键词`);
  }
  return { reason, groups: parseKeywordGroups(reason, response.keywords) };
}

function parseKeywordGroups(reason, rows) {
  const isTerm = value => typeof value === 'string' && /^[\p{L}\p{N} ]{1,16}$/u.test(value);
  const dates = new Set(timeReferences(reason));
  const keywords = new Set();
  return rows.map(row => {
    const keyword = typeof row?.keyword === 'string' ? row.keyword.trim() : '';
    const candidates = Array.isArray(row?.candidates) ? row.candidates.filter(isTerm).map(value => value.trim()) : [];
    const template = sentence(row?.template, 45);
    const alternatives = [...new Set(candidates.filter(word => word && !timeReferences(word).length &&
      !reason.includes(word) && !word.includes(keyword) &&
      template.replace('{word}', word).length <= 46))].slice(0, 3);
    if (!isTerm(keyword) || !reason.includes(keyword) || timeReferences(keyword).length || keywords.has(keyword) || !alternatives.length ||
        timeReferences(template).some(date => !dates.has(date)) ||
        template.split('{word}').length !== 2 || template.includes(keyword)) {
      throw new Error('对话接口未返回可替换的关键词线索');
    }
    keywords.add(keyword);
    return { keyword, alternatives, template };
  });
}

async function prepareClues(service, groups, reason) {
  const inputs = [...new Set([...(reason ? [reason] : []), ...groups.flatMap(({ keyword, alternatives }) => [keyword, ...alternatives])])];
  const vectors = await embedMany(service, inputs);
  const byText = new Map(inputs.map((text, index) => [text, vectors[index]]));
  const clues = groups.map(({ keyword, alternatives, template }) => {
    const original = byText.get(keyword);
    const closest = alternatives.map(word => ({ word, similarity: cosineSimilarity(original, byText.get(word)) }))
      .sort((left, right) => right.similarity - left.similarity)[0].word;
    return { keyword, word: closest, hint: template.replace('{word}', closest) };
  });
  return { vector: byText.get(reason), clues };
}

async function chooseClue(config, game, guess, score, turn) {
  const recentGuesses = [guess, ...game.history.slice(-5).map(entry => entry.guess)];
  const initialClues = game.clues.slice(0, keywordGroupCount);
  const mentioned = clue => recentGuesses.some(text => text.includes(clue.keyword) || text.includes(clue.word));
  const likelyPartial = score >= config.winScore - 15 || initialClues.filter(mentioned).length >= Math.ceil(initialClues.length / 2);
  const reviewDue = (!game.lastClueReview || turn - game.lastClueReview >= (likelyPartial ? 2 : 3)) &&
    (likelyPartial || turn > keywordGroupCount);
  const shownHints = [...new Set(game.history.map(entry => entry.hint))].slice(-8);

  if (reviewDue) {
    try {
      const bestGuesses = [...game.history].sort((left, right) => right.score - left.score).slice(0, 2).map(entry => entry.guess);
      const response = await ask(config.chat, clueReviewPrompt, {
        reason: game.reason, guesses: [...new Set([...recentGuesses, ...bestGuesses])], shownHints,
        clueKeywords: game.clues.map(({ keyword, word }) => ({ keyword, word })),
      });
      if (response?.keyword) {
        const [group] = parseKeywordGroups(game.reason, [response]);
        const duplicate = game.clues.some(clue => clue.keyword.includes(group.keyword));
        group.alternatives = group.alternatives.filter(word => !game.clues.some(clue => clue.word === word));
        if (!duplicate && group.alternatives.length) {
          const { clues: [clue] } = await prepareClues(config.embedding, [group]);
          return { clue, reviewDue, isNew: true, shownHints };
        }
      }
    } catch {
      // A failed review should not interrupt the player's turn.
    }
  }

  const unmentioned = game.clues.filter(item => !mentioned(item));
  const eligible = unmentioned.length ? unmentioned : game.clues;
  const clue = eligible.find(item => !item.lastShown) ??
    eligible.reduce((oldest, item) => item.lastShown < oldest.lastShown ? item : oldest);
  return { clue, reviewDue, shownHints };
}

function sentence(value, limit) {
  if (typeof value !== 'string') throw new Error('对话接口未返回有效台词');
  const spoken = value.trim().replace(/^[“「"]+|[”」"]+$/gu, '');
  const [, first, punctuation] = spoken.match(/^([^。！？!?\n]*)([。！？!?]?)/u);
  if (!first || first.length > limit) throw new Error('对话接口返回的台词长度不符');
  return `${first.trim()}${punctuation || '。'}`;
}

function substantiveLine(value, guess) {
  if (typeof value !== 'string') return;
  const clean = text => text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const said = clean(guess);
  const spoken = value.trim().replace(/^[“「"]+|[”」"]+$/gu, '')
    .replace(/^(啊|唔|哼|嗯|典|急|孝|崩|绷|麻|乐)[！!]/u, '$1，');
  for (const [, body, punctuation] of spoken.matchAll(/([^。！？!?\n]+)([。！？!?]?)/gu)) {
    const text = body.trim();
    const statement = clean(text);
    if (statement.length >= 6 && text.length <= 45 && !said.includes(statement) &&
        !/[？?]/u.test(punctuation) && !/[吗么]$/u.test(text)) {
      return `${text}${punctuation || '。'}`;
    }
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function dialogueEmojis(dragon, lines, hint, previewClue) {
  if (!Array.isArray(dragon?.emojis)) return {};
  let previewUsed = false;
  const valid = dragon.emojis.filter(entry => {
    const { emoji, cue } = entry ?? {};
    if (typeof emoji !== 'string' || emoji.length > 18 || !/^\p{Extended_Pictographic}/u.test(emoji) ||
        [...graphemes.segment(emoji)].length !== 1 || typeof cue !== 'string' || !cue.trim()) return false;
    if (lines.some(line => line.includes(cue))) return true;
    if (!previewUsed && previewClue?.includes(cue)) {
      previewUsed = true;
      return true;
    }
    return false;
  });
  const emojis = [...new Set(valid.map(({ emoji }) => emoji))].slice(0, 6);
  const hintEmojis = hint ? [...new Set(valid.filter(({ kind, cue }) => kind === 'image' && hint.includes(cue))
    .map(({ emoji }) => emoji))].slice(0, 6) : [];
  return { ...(emojis.length ? { emojis } : {}), ...(hintEmojis.length ? { hintEmojis } : {}) };
}

async function rebutGuess(service, context) {
  let dragon;
  try {
    dragon = await ask(service, rebuttalPrompt, context);
  } catch (error) {
    if (!error.invalidJson) throw error;
  }
  let rebuttal = substantiveLine(dragon?.rebuttal, context.guess);
  if (!rebuttal) {
    try {
      const revision = await ask(service, rebuttalPrompt, {
        ...context, revision: '上一版的格式或反驳不完整。用 JSON 返回两句台词，第一句抓住玩家提出的具体事物，用陈述句说明为何不能说服你。',
      });
      rebuttal = substantiveLine(revision?.rebuttal, context.guess);
      if (rebuttal) dragon = revision;
    } catch {
      // Keep the original clue if the second model request fails.
    }
  }
  let hint;
  try {
    hint = sentence(dragon?.hint, 45);
    const allowedDates = timeReferences([context.clue, ...context.previousHints].join('\n'));
    if ((context.requiredWord && !hint.includes(context.requiredWord)) ||
        timeReferences(hint).some(date => !allowedDates.includes(date))) hint = context.clue;
  } catch {
    hint = context.clue;
  }
  const lines = [rebuttal ?? '你还没说她离开后能办成什么，我没理由松爪。', hint];
  const previewClue = context.trend ? context.clue : undefined;
  return { lines, ...dialogueEmojis(dragon, lines, hint, previewClue) };
}

export async function newGame(config, previousReason) {
  if (config.mode === 'local') {
    const choices = scenarios.filter(({ reason }) => reason !== previousReason);
    return { ...choices[randomInt(choices.length)], history: [] };
  }
  const context = {
    inspiration: ['节庆', '手艺', '奇异动物', '城镇机关', '山谷传说', '食物', '天象'][randomInt(7)],
    previousReason: previousReason || undefined,
  };
  const draft = await ask(config.chat, puzzlePrompt, context, 1200);
  let puzzle;
  try {
    puzzle = parsePuzzle(draft);
  } catch {
    puzzle = parsePuzzle(await ask(config.chat, puzzlePrompt, {
      ...context, revision: `${keywordGroupCount} 个 keyword 必须逐字取自 reason，且不含日期或时刻。每组都给不同于原词的候选和含有 {word} 的线索，线索里的时间不能改变。`,
    }, 1200));
  }
  const { reason, groups } = puzzle;
  const { vector, clues } = await prepareClues(config.embedding, groups, reason);
  return { reason, clues, vector, history: [] };
}

function localScore(game, guess) {
  const matched = game.concepts.filter(pattern => Boolean(guess.match(pattern))).length;
  const pairs = new Set(game.reason.match(/[\p{Script=Han}]{2}/gu));
  const overlap = [...pairs].filter(pair => guess.includes(pair)).length;
  return Math.min(100, matched * 24 + Math.min(16, overlap * 2));
}

export async function takeTurn(config, game, guess) {
  const score = config.mode === 'local' ? localScore(game, guess) : similarityScore(game.vector, await embed(config.embedding, guess), config.similarityFloor);
  const won = score >= config.winScore;
  const turn = game.history.length + 1;

  let lines;
  let effects;
  if (config.mode === 'local') {
    const hint = game.hints[Math.min(game.hints.length - 1, turn - 1)];
    lines = won ? ['行，这个理由我认。', '公主，你可以走了。'] : [rebuttals[(turn - 1) % rebuttals.length], hint];
  } else {
    const recentTurns = game.history.slice(-4).map(({ guess, rebuttal, hint }) => ({ guess, rebuttal, hint }));
    if (won) {
      const dragon = await ask(config.chat, releasePrompt, { guess, recentTurns, reason: game.reason });
      const acknowledge = substantiveLine(dragon?.acknowledge, guess) ?? '行，你说的理由让我愿意松爪。';
      lines = [acknowledge, sentence(dragon?.release, 45)];
      effects = dialogueEmojis(dragon, lines);
    } else {
      const previous = game.history.at(-1);
      const { clue, reviewDue, isNew, shownHints } = await chooseClue(config, game, guess, score, turn);
      ({ lines, ...effects } = await rebutGuess(config.chat, {
        guess, clue: clue.hint, requiredWord: clue.word, recentTurns,
        previousHints: shownHints.filter(hint => hint !== clue.hint),
        proximity: score >= config.winScore - 15 ? '接近' : '需要继续推断',
        trend: previous && score < previous.score ? '越猜越远' : undefined,
      }));
      clue.lastShown = turn;
      if (isNew) game.clues.push(clue);
      if (reviewDue) game.lastClueReview = turn;
    }
  }
  return { turn, score, won, lines, ...effects, ...(won ? { reason: game.reason } : {}) };
}
