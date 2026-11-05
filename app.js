// Вебверсія гри на двох телефонах: той самий журнал ходів, що й в Android-додатку.
// Сторінка нічого не встановлює, тому відкривається на iPhone просто за посиланням.
import { Chess } from './vendor/chess.js';

const RELAY = 'https://ntfy.sh/';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const HINT_DEPTH = 13;
const RESEND_MS = 3000;
const HISTORY_ATTEMPTS = 3;
const HISTORY_RETRY_MS = 1500;
const FILES = 'abcdefgh';

const $ = (id) => document.getElementById(id);

const state = {
  code: null,
  mySide: 'w',
  hostSide: null,
  guestJoined: false,
  chess: new Chess(),
  resignedBy: null,
  connected: false,
  selected: null,
  targets: new Set(),
  captures: new Set(),
  hintsOn: readStorage('hints') === '1',
  hint: null,
  pending: 0,
  sendError: false,
  chosenSide: 'w',
};

function readStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStorage(key, value) {
  try {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch { /* приватний режим Safari: без збереження гра теж працює */ }
}

// --- Код гри ---------------------------------------------------------------

function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

function parseCode(text) {
  const match = text.toUpperCase().match(new RegExp(`(?:^|[^A-Z0-9])([${ALPHABET}]{${CODE_LENGTH}})(?:$|[^A-Z0-9])`));
  return match ? match[1] : null;
}

const topicUrl = (code) => `${RELAY}cac-${code.toLowerCase()}`;
const gameLink = (code) => `${location.origin}${location.pathname}?g=${code}`;

// --- Партія: той самий журнал, що в OnlineGame.kt ----------------------------

function outcome() {
  const c = state.chess;
  if (state.resignedBy) {
    return `${state.resignedBy === 'w' ? 'Білі' : 'Чорні'} здалися.`;
  }
  if (c.isCheckmate()) return `Мат! Перемогли ${c.turn() === 'b' ? 'білі' : 'чорні'}.`;
  if (c.isStalemate()) return 'Нічия: пат.';
  if (c.isInsufficientMaterial()) return 'Нічия: недостатньо матеріалу.';
  if (c.isDrawByFiftyMoves()) return 'Нічия: правило 50 ходів.';
  if (c.isThreefoldRepetition()) return 'Нічия: триразове повторення.';
  return null;
}

function applyMessage(message) {
  switch (message.t) {
    case 'game':
      if (!state.hostSide && (message.host === 'w' || message.host === 'b')) state.hostSide = message.host;
      break;
    case 'join':
      state.guestJoined = true;
      break;
    case 'resign':
      if (!outcome() && (message.by === 'w' || message.by === 'b')) state.resignedBy = message.by;
      break;
    case 'move': {
      // Дублікати, чужі номери й неможливі ходи відкидаються: журнал можна читати скільки завгодно разів.
      if (!state.hostSide || outcome() || message.n !== state.chess.history().length) return false;
      const uci = String(message.uci ?? '');
      try {
        state.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      } catch {
        return false;
      }
      state.selected = null;
      state.targets = new Set();
      state.captures = new Set();
      state.hint = null;
      return true;
    }
    default:
      return false;
  }
  return false;
}

// --- Мережа ------------------------------------------------------------------

const outbox = [];
let sending = false;

async function flushOutbox() {
  if (sending) return;
  sending = true;
  while (outbox.length) {
    try {
      const response = await fetch(topicUrl(state.code), { method: 'POST', body: outbox[0] });
      if (!response.ok) throw new Error(String(response.status));
      outbox.shift();
      state.pending = outbox.length;
      state.sendError = false;
    } catch {
      state.sendError = true;
      render();
      await new Promise((resolve) => setTimeout(resolve, RESEND_MS));
    }
  }
  sending = false;
  render();
}

function send(message) {
  outbox.push(JSON.stringify(message));
  state.pending = outbox.length;
  applyMessage(message);
  flushOutbox();
}

let stream = null;

function connect() {
  stream?.close();
  stream = new EventSource(`${topicUrl(state.code)}/sse?since=all`);
  stream.onopen = () => { state.connected = true; render(); };
  stream.onerror = () => {
    state.connected = false;
    render();
    // Safari іноді закриває потік остаточно замість повторного підключення.
    if (stream.readyState === EventSource.CLOSED) setTimeout(connect, RESEND_MS);
  };
  stream.onmessage = (event) => {
    let text;
    try {
      const data = JSON.parse(event.data);
      if (data.event !== 'message') return;
      text = JSON.parse(data.message);
    } catch {
      return;
    }
    if (applyMessage(text)) refreshHint();
    render();
  };
}

// Телефон міг заснути: повертаючись, просто читаємо журнал заново.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.code && (!stream || stream.readyState !== EventSource.OPEN)) connect();
});

// --- Вхід у гру --------------------------------------------------------------

function openGame(code, side) {
  state.code = code;
  state.mySide = side;
  writeStorage(`cac-${code}`, side);
  writeStorage('last-game', code);
  history.replaceState(null, '', `?g=${code}`);
  connect();
  render();
}

async function joinGame(code) {
  const known = readStorage(`cac-${code}`);
  if (known === 'w' || known === 'b') {
    openGame(code, known);
    return;
  }
  showSetupError(null);
  $('join').disabled = true;
  try {
    // Сервіс записує журнал пакетами, тож щойно створена гра може з'явитись із затримкою.
    let game = null;
    for (let attempt = 1; attempt <= HISTORY_ATTEMPTS && !game; attempt++) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, HISTORY_RETRY_MS));
      const response = await fetch(`${topicUrl(code)}/json?poll=1&since=all`);
      if (!response.ok) throw new Error(String(response.status));
      const text = await response.text();
      const messages = text.split('\n').filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((event) => event.event === 'message')
        .map((event) => JSON.parse(event.message));
      game = messages.find((m) => m.t === 'game' && (m.host === 'w' || m.host === 'b'));
    }
    if (!game) {
      showSetupError('Гру з таким кодом не знайдено. Код діє близько 12 годин.');
      renderSetupVisible();
      return;
    }
    openGame(code, game.host === 'w' ? 'b' : 'w');
    send({ t: 'join' });
  } catch {
    showSetupError('Немає зв\'язку. Перевірте інтернет і спробуйте ще раз.');
    renderSetupVisible();
  } finally {
    $('join').disabled = false;
  }
}

function createGame() {
  const code = generateCode();
  openGame(code, state.chosenSide);
  send({ t: 'game', host: state.chosenSide });
}

function showSetupError(text) {
  $('setup-error').textContent = text ?? '';
  $('setup-error').hidden = !text;
}

function renderSetupVisible() {
  $('loading').hidden = true;
  $('setup').hidden = false;
  $('game').hidden = true;
}

// --- Дошка -------------------------------------------------------------------

const isMyTurn = () => !outcome() && !!state.hostSide && state.chess.turn() === state.mySide;

function tapSquare(square) {
  if (!isMyTurn()) return;
  if (state.selected && state.targets.has(square)) {
    attemptMove(state.selected, square);
    return;
  }
  const piece = state.chess.get(square);
  if (piece && piece.color === state.mySide && square !== state.selected) {
    const moves = state.chess.moves({ square, verbose: true });
    state.selected = square;
    state.targets = new Set(moves.map((m) => m.to));
    state.captures = new Set(moves.filter((m) => m.captured).map((m) => m.to));
  } else {
    state.selected = null;
    state.targets = new Set();
    state.captures = new Set();
  }
  render();
}

function attemptMove(from, to) {
  const moves = state.chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!moves.length) return;
  if (moves.length > 1) {
    askPromotion(from, to);
    return;
  }
  playMove(from + to);
}

function playMove(uci) {
  stopHintSearch();
  send({ t: 'move', n: state.chess.history().length, uci });
  render();
}

function askPromotion(from, to) {
  const box = $('promotion-pieces');
  box.replaceChildren();
  for (const letter of ['q', 'r', 'b', 'n']) {
    const button = document.createElement('button');
    const image = document.createElement('img');
    image.src = `pieces/${state.mySide}${letter.toUpperCase()}.svg`;
    image.alt = { q: 'Ферзь', r: 'Тура', b: 'Слон', n: 'Кінь' }[letter];
    button.append(image);
    button.addEventListener('click', () => {
      $('promotion').close();
      playMove(from + to + letter);
    });
    box.append(button);
  }
  $('promotion').showModal();
}

function kingInCheckSquare() {
  const c = state.chess;
  if (!c.inCheck()) return null;
  for (const row of c.board()) {
    for (const cell of row) {
      if (cell && cell.type === 'k' && cell.color === c.turn()) return cell.square;
    }
  }
  return null;
}

function renderBoard() {
  const board = $('board');
  const flipped = state.mySide === 'b';
  const last = state.chess.history({ verbose: true }).at(-1);
  const check = kingInCheckSquare();
  const hint = state.hintsOn && isMyTurn() ? state.hint : null;
  const nodes = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const file = flipped ? 7 - col : col;
      const rank = flipped ? row : 7 - row;
      const square = FILES[file] + (rank + 1);
      const cell = document.createElement('button');
      cell.className = 'sq';
      cell.dataset.square = square;
      cell.setAttribute('aria-label', square);
      if ((file + rank) % 2 === 1) cell.classList.add('l');
      if (last && (last.from === square || last.to === square)) cell.classList.add('last');
      if (hint && (hint.slice(0, 2) === square || hint.slice(2, 4) === square)) cell.classList.add('best');
      if (state.selected === square) cell.classList.add('sel');
      if (check === square) cell.classList.add('check');
      if (state.targets.has(square)) cell.classList.add('target');
      if (state.captures.has(square)) cell.classList.add('cap');
      const tint = document.createElement('span');
      tint.className = 'tint';
      cell.append(tint);
      if (col === 0) cell.append(coord('rank', String(rank + 1)));
      if (row === 7) cell.append(coord('file', FILES[file]));
      const piece = state.chess.get(square);
      if (piece) {
        const image = document.createElement('img');
        image.src = `pieces/${piece.color}${piece.type.toUpperCase()}.svg`;
        image.alt = '';
        cell.append(image);
      }
      nodes.push(cell);
    }
  }
  board.replaceChildren(...nodes);
  renderArrow(hint, flipped);
}

function coord(kind, text) {
  const span = document.createElement('span');
  span.className = `coord ${kind}`;
  span.textContent = text;
  return span;
}

function renderArrow(hint, flipped) {
  const svg = $('arrows');
  svg.replaceChildren();
  if (!hint) return;
  const center = (square) => {
    const file = FILES.indexOf(square[0]);
    const rank = Number(square[1]) - 1;
    const col = flipped ? 7 - file : file;
    const row = flipped ? rank : 7 - rank;
    return [col * 100 + 50, row * 100 + 50];
  };
  const [x1, y1] = center(hint.slice(0, 2));
  const [x2, y2] = center(hint.slice(2, 4));
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const neckX = x2 - dx * 44;
  const neckY = y2 - dy * 44;
  const ns = 'http://www.w3.org/2000/svg';
  const line = document.createElementNS(ns, 'line');
  line.setAttribute('x1', x1 + dx * 22);
  line.setAttribute('y1', y1 + dy * 22);
  line.setAttribute('x2', neckX);
  line.setAttribute('y2', neckY);
  line.setAttribute('stroke', '#22d66f');
  line.setAttribute('stroke-width', '20');
  line.setAttribute('stroke-opacity', '0.95');
  const head = document.createElementNS(ns, 'polygon');
  head.setAttribute('points', `${x2},${y2} ${neckX - dy * 30},${neckY + dx * 30} ${neckX + dy * 30},${neckY - dx * 30}`);
  head.setAttribute('fill', '#22d66f');
  head.setAttribute('fill-opacity', '0.95');
  svg.append(line, head);
}

function render() {
  $('loading').hidden = true;
  if (!state.code) {
    renderSetupVisible();
    return;
  }
  $('setup').hidden = true;
  $('game').hidden = false;

  const done = outcome();
  const hostWaiting = state.hostSide === state.mySide && !state.guestJoined && !done;
  $('invite').hidden = !hostWaiting;
  $('invite-code').textContent = state.code;

  let status;
  if (done) status = done;
  else if (!state.hostSide) status = 'Підключаюсь до гри…';
  else if (isMyTurn()) status = 'Ваш хід';
  else status = 'Хід суперника';
  $('status').textContent = status;
  $('status').classList.toggle('turn', !done && isMyTurn());

  const color = state.mySide === 'w' ? 'білими' : 'чорними';
  let link = `Зв'язок є · код ${state.code} · ви граєте ${color}`;
  if (state.sendError) link = 'Хід ще не надіслано, немає зв\'язку. Пробую знову…';
  else if (state.pending > 0) link = 'Надсилаю хід…';
  else if (!state.connected) link = 'Підключаюсь…';
  $('link-state').textContent = link;

  $('hints').textContent = state.hintsOn ? 'Підказки: увімк.' : 'Підказки: вимк.';
  $('hints').classList.toggle('selected', state.hintsOn);
  $('hints').hidden = !!done;
  $('resign').hidden = !!done;
  $('leave').textContent = done ? 'Нова гра' : 'Вийти';

  const sans = state.chess.history();
  $('moves-card').hidden = sans.length === 0;
  $('moves').textContent = sans
    .map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san))
    .join(' ');

  renderBoard();
  if (state.hintsOn && isMyTurn() && !state.hint) refreshHint();
}

// --- Підказки: Stockfish у браузері, лише на цьому пристрої ---------------------

let engine = null;
let searching = false;
let searchFen = null;
let queued = false;

function ensureEngine() {
  if (engine) return;
  engine = new Worker('engine/stockfish-19-lite-single.js');
  engine.onmessage = (event) => {
    const line = String(event.data ?? event);
    if (!line.startsWith('bestmove')) return;
    searching = false;
    const best = line.split(' ')[1];
    if (queued) {
      queued = false;
      refreshHint();
      return;
    }
    if (best && best !== '(none)' && searchFen === state.chess.fen()) {
      state.hint = best;
      render();
    }
  };
  engine.postMessage('uci');
  engine.postMessage('isready');
}

function stopHintSearch() {
  if (searching) engine?.postMessage('stop');
}

function refreshHint() {
  if (!state.hintsOn || !isMyTurn()) return;
  const fen = state.chess.fen();
  if (searching) {
    // Рушій ще думає над старою позицією: дочекаємось, поки він зупиниться.
    if (searchFen !== fen) {
      queued = true;
      engine.postMessage('stop');
    }
    return;
  }
  if (state.hint) return;
  ensureEngine();
  searchFen = fen;
  searching = true;
  engine.postMessage(`position fen ${fen}`);
  engine.postMessage(`go depth ${HINT_DEPTH}`);
}

// --- Кнопки --------------------------------------------------------------------

$('board').addEventListener('click', (event) => {
  const cell = event.target.closest('.sq');
  if (cell) tapSquare(cell.dataset.square);
});

$('join').addEventListener('click', () => {
  const code = parseCode($('code-input').value);
  if (!code) {
    showSetupError('Це не схоже на код гри. У коді 8 символів.');
    return;
  }
  joinGame(code);
});

$('create').addEventListener('click', createGame);

for (const button of document.querySelectorAll('[data-side]')) {
  button.addEventListener('click', () => {
    state.chosenSide = button.dataset.side;
    for (const other of document.querySelectorAll('[data-side]')) {
      other.classList.toggle('selected', other === button);
    }
  });
}

$('hints').addEventListener('click', () => {
  state.hintsOn = !state.hintsOn;
  writeStorage('hints', state.hintsOn ? '1' : '0');
  state.hint = null;
  render();
});

$('resign').addEventListener('click', () => {
  if (!outcome()) send({ t: 'resign', by: state.mySide });
  render();
});

$('leave').addEventListener('click', () => {
  stream?.close();
  writeStorage('last-game', null);
  location.href = location.pathname;
});

$('share').addEventListener('click', async () => {
  const text = `Зіграймо в шахи! Код гри: ${state.code}`;
  const url = gameLink(state.code);
  if (navigator.share) {
    try { await navigator.share({ title: 'Шахи вдвох', text, url }); } catch { /* гравець закрив меню */ }
  } else {
    await copyLink();
  }
});

async function copyLink() {
  try {
    await navigator.clipboard.writeText(gameLink(state.code));
    $('copy').textContent = 'Скопійовано';
  } catch {
    $('copy').textContent = 'Не вдалось скопіювати';
  }
}
$('copy').addEventListener('click', copyLink);

// На iPhone немає кнопки встановлення, тому підказуємо шлях через меню Safari.
const isIphone = /iPhone|iPad|iPod/.test(navigator.userAgent);
if (isIphone && !navigator.standalone && readStorage('install-seen') !== '1') {
  $('install').hidden = false;
}
$('install-close').addEventListener('click', () => {
  writeStorage('install-seen', '1');
  $('install').hidden = true;
});

// --- Старт -----------------------------------------------------------------------

const fromLink = parseCode(new URLSearchParams(location.search).get('g') ?? '');
if (fromLink) {
  $('code-input').value = fromLink;
  joinGame(fromLink);
} else {
  render();
}
