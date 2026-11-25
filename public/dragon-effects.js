const stage = document.querySelector('.stage');
const canvas = document.querySelector('#scene');
const layer = document.querySelector('#dragon-effects');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const meme = /(?:^|[\s，。！？!?、：“「])(?:急|孝|典|崩|绷|麻|乐)(?=$|[\s，。！？!?、”」～~])|急了|孝死|绷不住|绷了|崩了|麻了|乐了|乐死|笑死|太典|典中典|[急孝典崩绷麻乐]{2,}/u;
const anger = /可恶|岂有此理|气死|火大|惹火|找死|滚开|气得|恼火|愤怒|生气|气炸|忍无可忍/u;
const tones = [
  [meme, '😂'], [anger, '😠'], [/吓一跳|发抖|毛骨悚然|怕得/u, '😨'],
  [/难过|委屈|伤心/u, '😢'], [/开心|痛快|高兴/u, '😄'],
  [/(?:^|[\s，。！？])(?:啊|咦)[，～~…！]/u, '😮'],
  [/(?:^|[\s，。！？])(?:嗯|唔)[，～~…！]|让我想想/u, '🤔'],
  [/(?:^|[\s，。！？])哼[，～~…！]/u, '😤'],
];
const images = [
  [/蛋糕|糕点|巴斯克/u, '🍰'], [/金币|黄金|财宝/u, '🪙'], [/企鹅/u, '🐧'], [/小猫|奶猫|猫咪|野猫/u, '🐈'],
  [/鸡蛋|蛋壳|煎蛋|炒蛋/u, '🥚'], [/齿轮/u, '⚙️'], [/钟楼|钟声|铜钟|大钟/u, '🔔'], [/幽灵|鬼魂|亡魂/u, '👻'],
  [/星星|星光|星河/u, '⭐'], [/月亮|月光|满月/u, '🌙'], [/火焰|火苗|烈火/u, '🔥'], [/面包|吐司/u, '🍞'],
  [/乌鸦/u, '🐦‍⬛'], [/花朵|玫瑰/u, '🌹'], [/闪电|雷声/u, '⚡'], [/骨头|骸骨/u, '🦴'],
  [/极地|雪地|下雪|雪花|冰原/u, '❄️'], [/羊毛|针线|编织/u, '🧶'], [/麻将/u, '🀄'],
];

let particles = [];
let frame = 0;
let lastFrame;

const matchEmojis = (text, cues) => cues.filter(([pattern]) => pattern.test(text)).map(([, emoji]) => emoji);
export const emojiKey = emoji => emoji.replace(/\uFE0F/gu, '');

export function findHintEmojis(hint, suggested = []) {
  return [...matchEmojis(hint, images), ...suggested];
}

function chooseEmojis(lines, suggested) {
  const spoken = lines.join('\n');
  const candidates = [...matchEmojis(spoken, tones), ...matchEmojis(spoken, images), ...suggested];
  return [...new Map(candidates.map(emoji => [emojiKey(emoji), emoji])).values()].slice(0, 6);
}

function step(now) {
  const dt = Math.min(.035, (now - (lastFrame ?? now)) / 1000);
  lastFrame = now;
  for (const particle of particles) {
    if (now < particle.start) continue;
    const age = now - particle.start;
    if (age >= particle.duration) {
      particle.node.remove();
      continue;
    }
    particle.node.hidden = false;
    particle.vy += 1530 * dt;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.angle += particle.spin * dt;
    if (particle.x < particle.radius || particle.x > particle.right) {
      particle.x = Math.min(particle.right, Math.max(particle.radius, particle.x));
      particle.vx *= -.86;
      particle.spin *= -.9;
    }
    if (particle.y >= particle.floor && particle.vy > 0) {
      particle.y = particle.floor;
      particle.vy *= -.7;
      particle.vx *= .94;
    }
    particle.node.style.transform = `translate3d(${particle.x}px, ${particle.y}px, 0) translate(-50%, -50%) rotate(${particle.angle}deg)`;
    particle.node.style.opacity = Math.min(1, (particle.duration - age) / 520);
  }
  particles = particles.filter(({ node }) => node.isConnected);
  frame = particles.length ? requestAnimationFrame(step) : 0;
  if (!frame) lastFrame = undefined;
}

export function tossDragonEmoji(lines, suggested = []) {
  if (reducedMotion.matches) return;
  const emojis = chooseEmojis(lines, suggested);
  if (!emojis.length) return;

  const field = stage.getBoundingClientRect();
  const art = canvas.getBoundingClientRect();
  const mouthX = art.left - field.left + art.width * (204 / 360);
  const mouthY = art.top - field.top + art.height * (120 / 240);
  const ground = Math.min(field.height - 12, art.top - field.top + art.height * (197 / 240));
  const horizontalSpeed = Math.min(1150, Math.max(420, field.width));
  const now = performance.now();
  const launches = emojis.flatMap((emoji, kind) => Array.from({ length: 2 + Math.floor(Math.random() * 2) }, (_, repeat) => ({
    emoji, delay: (kind + repeat * emojis.length) * 46,
  })));

  for (const { emoji, delay } of launches) {
    const node = document.createElement('span');
    const size = 26 + Math.random() * 18;
    node.className = 'dragon-emoji';
    node.textContent = emoji;
    node.hidden = true;
    node.style.fontSize = `${size}px`;
    layer.append(node);
    particles.push({
      node, x: mouthX, y: mouthY, angle: 0, radius: size / 2,
      vx: -horizontalSpeed * (.32 + Math.random() * .42),
      vy: -240 - Math.random() * 290, spin: 150 - Math.random() * 320,
      floor: ground - size / 2, right: field.width - size / 2,
      start: now + delay, duration: 2750 + Math.random() * 700,
    });
  }
  if (!frame) frame = requestAnimationFrame(step);
}

export function clearDragonEffects() {
  cancelAnimationFrame(frame);
  frame = 0;
  lastFrame = undefined;
  particles = [];
  layer.replaceChildren();
}
