import { freePrincess, playScene } from './scene.js';
import { clearDragonEffects, emojiKey, findHintEmojis, tossDragonEmoji } from './dragon-effects.js';

const $ = id => document.getElementById(id);
const apiBase = document.querySelector('meta[name="game-api-base"]')?.content ?? '/api/';
const stage = document.querySelector('.stage');
const speech = $('lines');
const dragonSpeech = $('dragon-speech');
const dragonAnnouncement = $('dragon-announcement');
const heroSpeech = $('hero-speech');
const heroLines = $('hero-lines');
const guess = $('guess');
const form = $('form');
const submit = $('submit');
const submitLabel = $('submit-label');
const restart = $('restart');
const reveal = $('reveal');
const debugDialog = $('debug-dialog');
const debugReason = $('debug-reason');
const score = $('score');
const knownClues = $('known-clues');
const clueEmojis = $('clue-emojis');
const ending = $('ending');
const errorBox = $('error');
let gameId;
let phase = 'idle';
let lastScore;
let canReveal = false;
const seenClueEmojis = new Set();
const viewport = window.visualViewport;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const speechSegments = new Intl.Segmenter('zh', { granularity: 'grapheme' });

function fitVisibleViewport() {
  const adjusted = Math.abs(viewport.scale - 1) < 0.01 &&
    (window.innerHeight - viewport.height > 1 || Math.abs(viewport.offsetTop) > 1);
  stage.style.setProperty('--visible-height', adjusted ? `${viewport.height}px` : '');
  stage.style.setProperty('--visible-top', adjusted ? `${viewport.offsetTop}px` : '');
}

if (viewport) {
  viewport.addEventListener('resize', fitVisibleViewport);
  viewport.addEventListener('scroll', fitVisibleViewport);
  fitVisibleViewport();
}

async function request(path, data) {
  const response = await fetch(new URL(path, new URL(apiBase, location.href)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function say(...lines) {
  speech.replaceChildren(...lines.map(line => element('p', '', line)));
  dragonAnnouncement.textContent = lines.join(' ');
}

function rememberHint(hint, suggested) {
  for (const emoji of findHintEmojis(hint, suggested)) {
    const key = emojiKey(emoji);
    if (seenClueEmojis.has(key)) continue;
    seenClueEmojis.add(key);
    const clue = element('li', '', emoji);
    clue.title = hint;
    clueEmojis.append(clue);
  }
  if (seenClueEmojis.size) knownClues.hidden = false;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function speak(lines) {
  if (reducedMotion.matches) {
    say(...lines);
    return;
  }
  speech.replaceChildren();
  speech.scrollTop = 0;
  for (const line of lines) {
    const row = element('p');
    speech.append(row);
    for (const { segment } of speechSegments.segment(line)) {
      const follow = speech.scrollTop + speech.clientHeight >= speech.scrollHeight - 8;
      row.textContent += segment;
      if (follow) speech.scrollTop = speech.scrollHeight;
      await wait(20 + Math.random() * 26 + (/[，。！？；、…]/u.test(segment) ? 70 : 0));
    }
  }
  dragonAnnouncement.textContent = lines.join(' ');
}

async function openingDialogue() {
  if (!reducedMotion.matches) await wait(110);
  dragonSpeech.hidden = false;
  if (!reducedMotion.matches) {
    dragonSpeech.animate([{ opacity: 0, scale: .94 }, { opacity: 1, scale: 1 }], { duration: 210, easing: 'ease-out' });
  }
  await speak(['你就是勇者？', '你告诉我，放了公主的理由是什么？']);
}

function controls() {
  restart.disabled = ['preparing', 'queued', 'answering', 'preview'].includes(phase);
  reveal.disabled = !canReveal || !['ready', 'won'].includes(phase);
  reveal.title = canReveal ? '显示本局答案' : '完成五轮对话后解锁';
  guess.disabled = phase !== 'preparing' && phase !== 'ready';
  submit.disabled = guess.disabled || !guess.value.trim();
  submitLabel.textContent = phase === 'queued' ? '等恶龙就绪…' : '说服恶龙';
}

function showError(error) {
  errorBox.textContent = errorMessage(error);
  errorBox.hidden = false;
}

function errorMessage(error) {
  return error instanceof TypeError ? '连不上试玩服务，请确认它仍在运行。' : error.message;
}

function showScore(value) {
  const first = lastScore === undefined;
  const change = first ? 0 : value - lastScore;
  lastScore = value;
  score.replaceChildren(element('span', 'score-value', value));
  if (!first) {
    const direction = change > 0 ? 'rising' : change < 0 ? 'falling' : 'steady';
    const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '▸';
    score.append(element('small', `score-change ${direction}`, `${arrow}${Math.abs(change)}`));
  }
  score.hidden = false;
  if ((!first && !change) || reducedMotion.matches) return;
  const from = first ? 'scale(.65)' : `translateY(${change > 0 ? '14px' : '-14px'}) scale(.91)`;
  score.animate([
    { transform: from, opacity: first ? 0 : .45 },
    { transform: 'none', opacity: 1 },
  ], { duration: first ? 430 : 360, easing: 'cubic-bezier(.2,.75,.25,1)' });
}

async function begin() {
  if (restart.disabled && phase !== 'idle') return;
  if (phase !== 'unavailable') guess.value = '';
  phase = 'preparing';
  lastScore = undefined;
  canReveal = false;
  score.hidden = true;
  score.textContent = '';
  heroSpeech.hidden = true;
  heroLines.textContent = '';
  knownClues.hidden = true;
  clueEmojis.replaceChildren();
  seenClueEmojis.clear();
  form.hidden = false;
  ending.hidden = true;
  errorBox.hidden = true;
  clearDragonEffects();
  dragonSpeech.hidden = true;
  speech.replaceChildren();
  dragonAnnouncement.textContent = '';
  const intro = new Promise(resolve => playScene(resolve)).then(openingDialogue);
  if (!apiBase) {
    phase = 'preview';
    form.hidden = true;
    showError(new Error('这是前端预览。连接游戏服务器后即可与恶龙对话。'));
    controls();
    await intro;
    return;
  }
  controls();
  try {
    const [game] = await Promise.all([request('game', { previousId: gameId }), intro]);
    gameId = game.id;
    const queued = phase === 'queued';
    phase = 'ready';
    if (queued) return answer(guess.value.trim());
  } catch (error) {
    await intro;
    phase = 'unavailable';
    say('恶龙还没想好它的条件。');
    showError(error);
  }
  controls();
}

async function answer(text) {
  phase = 'answering';
  errorBox.hidden = true;
  controls();
  const previousLines = [...speech.children].map(line => line.textContent);
  say('恶龙正在琢磨……');
  try {
    const result = await request('guess', { id: gameId, guess: text });
    canReveal = result.canReveal === true;
    guess.value = '';
    showScore(result.score);
    await speak(result.lines);
    tossDragonEmoji(result.lines, result.emojis);
    if (result.won) {
      phase = 'won';
      form.hidden = true;
      ending.replaceChildren(element('strong', '', '公主获救'), element('p', '', result.reason));
      ending.hidden = false;
      freePrincess();
    } else {
      rememberHint(result.lines[1], result.hintEmojis);
    }
  } catch (error) {
    say(...previousLines);
    showError(error);
  } finally {
    if (phase !== 'won') phase = 'ready';
    controls();
    if (phase === 'won') restart.focus();
    else if (matchMedia('(pointer: fine)').matches) guess.focus({ preventScroll: true });
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  const text = guess.value.trim();
  if (!text || (phase !== 'ready' && phase !== 'preparing')) return;
  heroLines.textContent = text;
  heroLines.scrollTop = 0;
  heroSpeech.hidden = false;
  if (phase === 'ready') answer(text);
  else {
    phase = 'queued';
    controls();
  }
});

let composing = false;
guess.addEventListener('compositionstart', () => { composing = true; });
guess.addEventListener('compositionend', () => { composing = false; });
guess.addEventListener('input', controls);
guess.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) {
    event.preventDefault();
    if (!submit.disabled) form.requestSubmit();
  }
});
restart.addEventListener('click', begin);
reveal.addEventListener('click', async () => {
  if (reveal.disabled) return;
  const id = gameId;
  debugReason.textContent = '正在读取本局谜底……';
  debugDialog.showModal();
  try {
    const result = await request('game', { id, action: 'reveal' });
    if (gameId === id) debugReason.textContent = result.reason;
  } catch (error) {
    if (gameId === id) debugReason.textContent = errorMessage(error);
  }
});

begin();
