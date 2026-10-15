import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { scoreGauge, finalReport, mockMode, BlockedError } from './src/ai.js';
import { takeTopic, warmUp } from './src/topics.js';

const env = (name, fallback) => Number(process.env[name]) || fallback;

const PORT = env('PORT', 3000);
const OPENING_SECONDS = env('OPENING_SECONDS', 90);
const FREE_SECONDS = env('FREE_SECONDS', 180);
const CLOSING_SECONDS = env('CLOSING_SECONDS', 60);
const MAX_SPEECH = 1000; // 입론·최종 변론 한 번에 쓸 수 있는 글자 수
const MAX_FREE_MSG = 200; // 자유토론 메시지 하나의 글자 수
const FREE_COOLDOWN_MS = 3000; // 자유토론 연속 전송 간격
const GAUGE_IDLE_MS = 4000; // 자유토론 중 대화가 이만큼 멈추면 게이지 갱신
const GAUGE_BATCH = 4; // 또는 채점 안 된 메시지가 이만큼 쌓이면 갱신
const COIN_MS = 3500;
const ROOM_TTL_MS = 10 * 60 * 1000;

// 로비에 늘 열어 두는 공개 토론회 수 (빈 방 + 한 명이 기다리는 방)
const OPEN_ROOMS = env('OPEN_ROOMS', 6);
// 아무도 안 들어간 빈 공개방은 이 시간이 지나면 새 주제로 바꾼다 (로비를 보는 사람이 있을 때만)
const TOPIC_STALE_MS = env('TOPIC_STALE_MINUTES', 10) * 60 * 1000;

// 남용 방지: 방 개수 상한, IP당 비공개방 생성 속도
const MAX_ROOMS = env('MAX_ROOMS', 200);
const CREATE_LIMIT = env('CREATE_LIMIT', 5);
const CREATE_WINDOW_MS = 10 * 60 * 1000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// 진행 순서: 입론(턴제) → 자유토론 → 최종 변론(턴제, 입론과 반대 순서)
const STEPS = [
  { stage: 'opening', side: 'pro', seconds: OPENING_SECONDS },
  { stage: 'opening', side: 'con', seconds: OPENING_SECONDS },
  { stage: 'free', side: null, seconds: FREE_SECONDS },
  { stage: 'closing', side: 'con', seconds: CLOSING_SECONDS },
  { stage: 'closing', side: 'pro', seconds: CLOSING_SECONDS },
];

const app = express();
app.use(express.static('public'));
// 배포 서비스가 서버가 살아 있는지 확인하는 주소
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
const httpServer = createServer(app);
const io = new Server(httpServer, { maxHttpBufferSize: 16 * 1024 });

/** @type {Map<string, any>} */
const rooms = new Map();
/** @type {Map<string, number[]>} IP별 최근 방 생성 시각 */
const createLog = new Map();

function allowCreate(ip) {
  const now = Date.now();
  const recent = (createLog.get(ip) ?? []).filter((t) => now - t < CREATE_WINDOW_MS);
  if (recent.length >= CREATE_LIMIT) {
    createLog.set(ip, recent);
    return false;
  }
  recent.push(now);
  createLog.set(ip, recent);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of createLog) {
    if (times.every((t) => now - t >= CREATE_WINDOW_MS)) createLog.delete(ip);
  }
}, CREATE_WINDOW_MS).unref();

function clientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (TRUST_PROXY && forwarded) return String(forwarded).split(',')[0].trim();
  return socket.handshake.address;
}

function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function freshMatch(room) {
  clearTimers(room);
  Object.assign(room, {
    matchId: (room.matchId ?? 0) + 1,
    phase: 'topic',
    topic: null,
    error: null,
    coin: null,
    turns: [],
    drafts: { pro: '', con: '' },
    stepIndex: -1,
    deadline: null,
    paused: false,
    pausedLeft: 0,
    gauge: { pro: 50, con: 50, comment: '토론 시작 전, 팽팽한 상태' },
    gaugeHistory: [{ n: 0, pro: 50, stage: 'start' }],
    // 게이지 채점은 한 번에 하나만 돌리고, 도는 동안 들어온 발언은 끝난 뒤 이어서 채점한다
    gaugeJob: { busy: false, dirty: false, scored: 0, pending: 0 },
    names: null,
    report: null,
    reportRunning: false,
    rematch: new Set(),
  });
  for (const p of room.players) {
    p.choice = null;
    p.side = null;
    p.lastFreeAt = 0;
  }
}

function clearTimers(room) {
  clearTimeout(room.timer);
  clearTimeout(room.gaugeTimer);
  clearTimeout(room.coinTimer);
}

const playerBySide = (room, side) => room.players.find((p) => p.side === side);
const sidePlayers = (room) => ({ pro: playerBySide(room, 'pro'), con: playerBySide(room, 'con') });
const currentStep = (room) => STEPS[room.stepIndex];

function viewFor(room, player) {
  const bothChose = room.players.length === 2 && room.players.every((p) => p.choice);
  const step = room.phase === 'debate' ? currentStep(room) : null;
  return {
    code: room.code,
    visibility: room.visibility,
    phase: room.phase,
    serverNow: Date.now(),
    mockMode,
    limits: { speech: MAX_SPEECH, free: MAX_FREE_MSG, freeCooldownMs: FREE_COOLDOWN_MS },
    me: { name: player.name, side: player.side, choice: player.choice, wantsRematch: room.rematch?.has(player.key) ?? false },
    players: room.players.map((p) => ({
      name: p.name,
      connected: !!p.socketId,
      chose: !!p.choice,
      choice: bothChose ? p.choice : null,
      side: p.side,
      isMe: p === player,
      wantsRematch: room.rematch?.has(p.key) ?? false,
    })),
    topic: room.topic,
    names: room.names ?? null,
    error: room.error,
    coin: room.coin,
    turns: room.turns,
    current: step && { ...step, index: room.stepIndex, total: STEPS.length },
    deadline: room.deadline,
    paused: room.paused,
    gauge: room.gauge,
    gaugeHistory: room.gaugeHistory,
    report: room.report,
  };
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('state', viewFor(room, p));
  }
}

// ---------- 주제 · 진영 ----------

// 새 판 시작. 공개방은 방에 붙어 있던 주제로 바로 진영 선택에 들어가고,
// 비공개방과 재대결은 주제 풀에서 하나 꺼낸다.
async function startMatch(room, presetTopic = null) {
  freshMatch(room);
  const matchId = room.matchId;
  if (presetTopic) {
    room.topic = presetTopic;
    room.phase = 'choosing';
    broadcast(room);
    return;
  }
  broadcast(room);
  try {
    const topic = await takeTopic();
    if (!rooms.has(room.code) || room.matchId !== matchId) return;
    room.topic = topic;
    room.phase = 'choosing';
  } catch (err) {
    if (room.matchId !== matchId) return;
    console.error('주제 준비 실패:', err);
    room.error = { kind: 'topic', message: '주제를 준비하지 못했어요. 다시 시도해 주세요.' };
  }
  broadcast(room);
}

// ---------- 로비 · 공개방 ----------

const isOpenPublic = (r) => r.visibility === 'public' && r.phase === 'waiting' && r.players.length < 2;

function lobbyView() {
  const open = [...rooms.values()]
    .filter(isOpenPublic)
    .sort((a, b) => b.players.length - a.players.length || a.createdAt - b.createdAt);
  return {
    rooms: open.map((r) => ({
      code: r.code,
      title: r.topic.title,
      background: r.topic.background,
      category: r.topic.category ?? '자유',
      waitingName: r.players[0]?.name ?? null,
    })),
    // 결과 화면은 토론이 끝난 것으로 보고 세지 않는다
    playing: [...rooms.values()].filter((r) => r.players.length === 2 && r.phase !== 'waiting' && r.phase !== 'result').length,
    online: io.engine.clientsCount,
  };
}

let lobbyTimer = null;
function scheduleLobby() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(() => {
    lobbyTimer = null;
    io.to('lobby').emit('lobby', lobbyView());
  }, 150);
}

let opening = 0; // 지금 만들고 있는 공개방 수 (동시에 너무 많이 만들지 않게)

async function ensureOpenRooms() {
  const open = [...rooms.values()].filter(isOpenPublic);
  // 사람이 나가서 빈 방이 남아돌면 정리한다
  const empties = open.filter((r) => r.players.length === 0);
  for (const r of empties.slice(0, Math.max(0, open.length - OPEN_ROOMS - 2))) deleteRoom(r, false);

  const need = OPEN_ROOMS - open.length - opening;
  if (need <= 0) return;
  opening += need;
  // 한 개씩 차례로 만들면서, 지금 로비에 없는 분야부터 채운다
  for (let i = 0; i < need; i++) {
    try {
      if (rooms.size >= MAX_ROOMS) continue;
      const shown = [...rooms.values()].filter(isOpenPublic).map((r) => r.topic.category);
      const topic = await takeTopic(shown);
      const code = newCode();
      rooms.set(code, newRoom(code, 'public', topic));
      scheduleLobby();
    } catch (err) {
      console.error('공개방 생성 실패:', err);
    } finally {
      opening -= 1;
    }
  }
}

// 오래 아무도 안 들어간 빈 방을 하나씩 새 주제로 교체한다.
// 한 번에 다 바꾸지 않고 1분에 하나씩 바꿔서 목록이 갑자기 통째로 바뀌지 않게 하고,
// 로비를 보는 사람이 없으면 바꾸지 않는다 (볼 사람이 없는데 주제를 만들 필요가 없으니까).
function rotateStaleRooms() {
  const watchers = io.sockets.adapter.rooms.get('lobby')?.size ?? 0;
  if (!watchers) return;
  const now = Date.now();
  const stale = [...rooms.values()]
    .filter((r) => isOpenPublic(r) && r.players.length === 0 && now - r.idleSince > TOPIC_STALE_MS)
    .sort((a, b) => a.idleSince - b.idleSince);
  if (stale.length) deleteRoom(stale[0]); // deleteRoom이 ensureOpenRooms로 새 방을 채운다
}

function newRoom(code, visibility, topic = null) {
  return { code, visibility, players: [], phase: 'waiting', topic, rematch: new Set(), createdAt: Date.now(), idleSince: Date.now() };
}

function deleteRoom(room, refill = true) {
  clearTimers(room);
  clearTimeout(room.cleanup);
  rooms.delete(room.code);
  scheduleLobby();
  if (refill) ensureOpenRooms();
}

setInterval(ensureOpenRooms, 30 * 1000).unref();
setInterval(rotateStaleRooms, 60 * 1000).unref();

function resolveSides(room) {
  const [a, b] = room.players;
  if (a.choice !== b.choice) {
    a.side = a.choice;
    b.side = b.choice;
    startDebate(room);
    return;
  }
  // 같은 진영을 골랐으면 코인토스로 한 명을 반대편으로 보낸다
  const keeper = Math.random() < 0.5 ? a : b;
  const mover = keeper === a ? b : a;
  keeper.side = keeper.choice;
  mover.side = keeper.choice === 'pro' ? 'con' : 'pro';
  room.phase = 'coin';
  room.coin = { contested: keeper.choice, winner: keeper.name, loser: mover.name };
  broadcast(room);
  room.coinTimer = setTimeout(() => {
    if (rooms.has(room.code) && room.phase === 'coin') startDebate(room);
  }, COIN_MS);
}

// ---------- 토론 진행 ----------

function startDebate(room) {
  // 한 명이 결과 화면에서 나가도 판정서에 이름이 남도록 진영별 이름을 따로 적어 둔다
  room.names = { pro: playerBySide(room, 'pro').name, con: playerBySide(room, 'con').name };
  room.phase = 'debate';
  room.stepIndex = -1;
  advance(room);
}

function advance(room) {
  room.stepIndex += 1;
  if (room.stepIndex >= STEPS.length) {
    clearTimeout(room.timer);
    room.phase = 'judging';
    room.deadline = null;
    broadcast(room);
    runFinalReport(room);
    return;
  }
  room.drafts = { pro: '', con: '' };
  armTimer(room, currentStep(room).seconds * 1000);
  broadcast(room);
}

function armTimer(room, ms) {
  clearTimeout(room.timer);
  room.deadline = Date.now() + ms;
  const stepIndex = room.stepIndex;
  room.timer = setTimeout(() => endStep(room, stepIndex), ms + 300);
}

function endStep(room, stepIndex) {
  if (room.phase !== 'debate' || room.stepIndex !== stepIndex) return;
  const step = currentStep(room);
  if (step.side) {
    submitTurn(room, room.drafts[step.side], true);
  } else {
    flushGauge(room);
    advance(room);
  }
}

function submitTurn(room, rawText, timedOut = false) {
  const { stage, side } = currentStep(room);
  let text = String(rawText ?? '').trim().slice(0, MAX_SPEECH);
  if (!text) text = '(시간 초과로 발언하지 못함)';
  room.turns.push({ side, stage, text, timedOut });
  flushGauge(room);
  advance(room);
}

function submitFree(room, player, rawText) {
  const now = Date.now();
  if (now - player.lastFreeAt < FREE_COOLDOWN_MS) return;
  const text = String(rawText ?? '').trim().slice(0, MAX_FREE_MSG);
  if (!text) return;
  player.lastFreeAt = now;
  room.turns.push({ side: player.side, stage: 'free', text });
  room.gaugeJob.pending += 1;
  // 메시지마다 채점하면 비용이 커지므로, 몇 개 쌓이거나 대화가 잠깐 멈췄을 때 묶어서 채점한다
  if (room.gaugeJob.pending >= GAUGE_BATCH) {
    flushGauge(room);
  } else {
    clearTimeout(room.gaugeTimer);
    room.gaugeTimer = setTimeout(() => flushGauge(room), GAUGE_IDLE_MS);
  }
  broadcast(room);
}

// ---------- 게이지 ----------

function flushGauge(room) {
  clearTimeout(room.gaugeTimer);
  room.gaugeJob.pending = 0;
  updateGauge(room);
}

async function updateGauge(room) {
  const job = room.gaugeJob;
  if (job.busy) {
    job.dirty = true;
    return;
  }
  job.busy = true;
  try {
    do {
      job.dirty = false;
      const from = job.scored;
      const to = room.turns.length;
      if (to === from) break;
      try {
        const gauge = await scoreGauge(room.topic, sidePlayers(room), room.turns.slice(0, to), room.gauge.pro, from);
        // 그사이 새 판이 시작됐거나 결과가 나왔으면 버린다
        if (room.gaugeJob !== job || room.phase === 'result') return;
        job.scored = to;
        room.gauge = gauge;
        room.gaugeHistory.push({ n: to, pro: gauge.pro, stage: room.turns[to - 1].stage });
        broadcast(room);
      } catch (err) {
        console.error('게이지 채점 실패:', err.message ?? err);
        break; // 채점 못 한 발언은 다음 채점 때 함께 반영된다
      }
    } while (job.dirty);
  } finally {
    job.busy = false;
  }
}

// ---------- 최종 판정 ----------

async function runFinalReport(room) {
  if (room.reportRunning) return;
  room.reportRunning = true;
  room.error = null;
  const matchId = room.matchId;
  try {
    const report = await finalReport(room.topic, sidePlayers(room), room.turns, room.gaugeHistory);
    if (!rooms.has(room.code) || room.matchId !== matchId) return;
    room.report = report;
    room.gauge = { pro: report.pro, con: report.con, comment: '최종 판정 완료' };
    room.gaugeHistory.push({ n: room.turns.length, pro: report.pro, stage: 'final' });
    room.phase = 'result';
    scheduleLobby(); // 로비의 "토론 중" 수를 바로 줄인다
  } catch (err) {
    if (room.matchId !== matchId) return;
    console.error('최종 판정 실패:', err.message ?? err);
    room.error = {
      kind: 'report',
      message: err instanceof BlockedError
        ? '부적절한 표현이 있어 AI가 판정을 거부했어요. 다시 시도해도 같을 수 있어요.'
        : '판정을 만들지 못했어요. 다시 시도해 주세요.',
    };
  } finally {
    room.reportRunning = false;
  }
  broadcast(room);
}

// ---------- 연결 끊김 ----------

// 둘 다 나가면 타이머를 멈춰서, 아무도 없는 방에서 시간 초과 턴과 AI 호출이 이어지지 않게 한다
function pauseIfAbandoned(room) {
  if (room.phase !== 'debate' || room.paused || room.players.some((p) => p.socketId)) return;
  room.paused = true;
  room.pausedLeft = Math.max(1000, room.deadline - Date.now());
  clearTimeout(room.timer);
  clearTimeout(room.gaugeTimer);
}

function resumeIfPaused(room) {
  if (!room.paused) return;
  room.paused = false;
  armTimer(room, room.pausedLeft);
}

function cleanName(name) {
  return String(name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, 12);
}

// ---------- 닉네임 점유 ----------
// 이름은 그 이름을 쓰는 탭(플레이어 키)이 접속해 있는 동안만 점유한다.
// 연결이 모두 끊기면 잠깐(새로고침·순간 끊김 대비) 기다렸다가 풀어 준다.
const NAME_GRACE_MS = env('NAME_GRACE_SECONDS', 15) * 1000;
const RESERVED_NAMES = new Set(['ai', 'ai 심판', '심판', '사회자', '진행자', '관리자', '운영자', 'admin', '익명']);
/** @type {Map<string, {key: string, sockets: Set<string>, releaseTimer: any}>} 정규화한 이름 → 주인 */
const nameOwners = new Map();
/** @type {Map<string, string>} 플레이어 키 → 정규화한 이름 */
const nameOfKey = new Map();

// 대소문자와 띄어쓰기 차이는 같은 이름으로 본다
const nameId = (display) => display.toLowerCase().replace(/\s/g, '');

function checkName(display, key) {
  if (!display) return '토론자 이름을 정해 주세요.';
  if (RESERVED_NAMES.has(display.toLowerCase()) || RESERVED_NAMES.has(nameId(display))) return '진행자와 헷갈리는 이름은 쓸 수 없어요.';
  const owner = nameOwners.get(nameId(display));
  if (owner && owner.key !== key) return '이미 다른 토론자가 쓰고 있는 이름이에요.';
  return null;
}

function releaseName(id) {
  const owner = nameOwners.get(id);
  if (!owner) return;
  clearTimeout(owner.releaseTimer);
  nameOwners.delete(id);
  if (nameOfKey.get(owner.key) === id) nameOfKey.delete(owner.key);
}

/** 이름을 이 소켓(키)의 것으로 잡는다. 실패하면 이유를 돌려준다. */
function claimName(socket, key, rawName) {
  const display = cleanName(rawName);
  const err = checkName(display, key);
  if (err) return { err };
  const id = nameId(display);
  const prev = nameOfKey.get(key);
  if (prev && prev !== id) releaseName(prev); // 이름을 바꾸면 예전 이름은 바로 풀어 준다
  let owner = nameOwners.get(id);
  if (!owner) {
    owner = { key, sockets: new Set(), releaseTimer: null };
    nameOwners.set(id, owner);
  }
  clearTimeout(owner.releaseTimer);
  owner.sockets.add(socket.id);
  nameOfKey.set(key, id);
  socket.data.nameKey = key;
  return { display };
}

function dropNameSocket(socket) {
  const key = socket.data.nameKey;
  const id = key && nameOfKey.get(key);
  const owner = id && nameOwners.get(id);
  if (!owner) return;
  owner.sockets.delete(socket.id);
  if (owner.sockets.size === 0) {
    owner.releaseTimer = setTimeout(() => releaseName(id), NAME_GRACE_MS);
  }
}

io.on('connection', (socket) => {
  let room = null;
  let player = null;

  socket.join('lobby');
  socket.emit('lobby', lobbyView());
  scheduleLobby(); // 접속자 수 갱신

  function bind(r, p) {
    room = r;
    player = p;
    p.socketId = socket.id;
    clearTimeout(r.cleanup);
    resumeIfPaused(r);
    socket.leave('lobby');
    socket.emit('joined', { code: r.code, visibility: r.visibility });
  }

  // 방에 새 플레이어로 들어간다. 두 번째 사람이 들어오면 바로 판이 시작된다.
  // 이름을 점유하고 방에 새 플레이어로 들어간다. 이름이 겹치면 들어가지 않는다.
  function enter(r, name, key) {
    const claim = claimName(socket, key, name);
    if (claim.err) {
      socket.emit('fail', claim.err);
      return false;
    }
    const p = { key, name: claim.display, socketId: null, choice: null, side: null, lastFreeAt: 0 };
    r.players.push(p);
    bind(r, p);
    if (r.players.length === 2) {
      startMatch(r, r.visibility === 'public' ? r.topic : null);
      ensureOpenRooms(); // 공개방 하나가 찼으니 새 빈 방을 보충
    } else {
      broadcast(r);
    }
    scheduleLobby();
    return true;
  }

  // 방에서 빠진다. 대기 중이거나 결과 화면에서만 쓴다 (토론 도중 이탈은 연결 끊김으로 처리).
  function removeFromRoom() {
    const r = room;
    r.players = r.players.filter((p) => p !== player);
    r.rematch?.delete(player.key);
    room = null;
    player = null;
    if (r.players.length === 0 && (r.visibility === 'private' || r.phase !== 'waiting')) {
      deleteRoom(r);
    } else {
      if (r.players.length === 0) r.idleSince = Date.now(); // 누가 잠깐 들어왔다 나간 방은 다시 처음부터 센다
      broadcast(r);
      scheduleLobby();
    }
  }

  socket.on('create', ({ name, key } = {}) => {
    if (room || typeof key !== 'string') return;
    if (rooms.size >= MAX_ROOMS) return socket.emit('fail', '지금은 방이 너무 많아요. 잠시 후 다시 시도해 주세요.');
    const nameErr = checkName(cleanName(name), key);
    if (nameErr) return socket.emit('fail', nameErr);
    if (!allowCreate(clientIp(socket))) return socket.emit('fail', '방을 너무 자주 만들었어요. 잠시 후 다시 시도해 주세요.');
    const r = newRoom(newCode(), 'private');
    rooms.set(r.code, r);
    enter(r, name, key);
  });

  socket.on('join', ({ code, name, key } = {}) => {
    if (typeof key !== 'string') return;
    const r = rooms.get(String(code ?? '').trim().toUpperCase());
    if (!r) return socket.emit('fail', '방을 찾을 수 없어요. 이미 끝났거나 코드가 틀렸어요.');
    const existing = r.players.find((p) => p.key === key);
    if (existing) {
      claimName(socket, key, existing.name); // 재접속: 이름 점유도 다시 이어 간다 (그새 다른 사람이 가져갔으면 그냥 둔다)
      bind(r, existing);
      broadcast(r);
      return;
    }
    if (room) return; // 이미 다른 방에 들어가 있는 연결
    if (r.players.length >= 2) return socket.emit('fail', '이미 두 명이 토론 중인 방이에요.');
    enter(r, name, key);
  });

  // 랜덤 매칭: 상대가 기다리는 공개방이 있으면 가장 오래 기다린 사람에게, 없으면 빈 공개방에 들어가 기다린다
  socket.on('quickmatch', ({ name, key } = {}) => {
    if (room || typeof key !== 'string') return;
    const open = [...rooms.values()].filter(isOpenPublic);
    const waiting = open.filter((r) => r.players.length === 1 && r.players[0].key !== key)
      .sort((a, b) => a.createdAt - b.createdAt);
    const empty = open.filter((r) => r.players.length === 0);
    const target = waiting[0] ?? empty[Math.floor(Math.random() * empty.length)];
    if (!target) return socket.emit('fail', '열린 토론회를 준비하는 중이에요. 잠시 후 다시 눌러 주세요.');
    enter(target, name, key);
  });

  socket.on('leave', () => {
    if (!room) return;
    if (room.phase !== 'waiting' && room.phase !== 'result') return;
    removeFromRoom();
    socket.join('lobby');
    socket.emit('left');
    socket.emit('lobby', lobbyView());
  });

  // 로비 새로고침 버튼: 목록은 바뀔 때마다 자동으로 오지만, 직접 다시 받아 볼 수도 있게
  socket.on('lobby:refresh', () => {
    if (!room) socket.emit('lobby', lobbyView());
  });

  socket.on('choose', (choice) => {
    if (!room || room.phase !== 'choosing' || player.choice) return;
    if (choice !== 'pro' && choice !== 'con') return;
    player.choice = choice;
    if (room.players.every((p) => p.choice)) resolveSides(room);
    else broadcast(room);
  });

  socket.on('draft', (text) => {
    if (!room || room.phase !== 'debate') return;
    if (currentStep(room).side !== player.side) return;
    room.drafts[player.side] = String(text ?? '').slice(0, MAX_SPEECH);
  });

  socket.on('speak', (text) => {
    if (!room || room.phase !== 'debate' || room.paused) return;
    const step = currentStep(room);
    if (step.stage === 'free') return submitFree(room, player, text);
    if (step.side !== player.side || !String(text ?? '').trim()) return;
    submitTurn(room, text);
  });

  socket.on('retry', () => {
    if (!room?.error) return;
    if (room.error.kind === 'topic') {
      startMatch(room);
    } else {
      broadcast(room);
      runFinalReport(room);
    }
  });

  // 다시하기는 둘 다 눌러야 시작한다 (한 명이 혼자 주제를 계속 새로 뽑지 못하게)
  socket.on('rematch', () => {
    if (!room || room.phase !== 'result' || room.players.length < 2) return;
    room.rematch.add(player.key);
    if (room.players.every((p) => room.rematch.has(p.key))) startMatch(room);
    else broadcast(room);
  });

  // 로비에서 이름을 칠 때 바로 쓸 수 있는지 알려 준다
  socket.on('name:check', (name, ack) => {
    if (typeof ack !== 'function') return;
    const err = checkName(cleanName(name), socket.data.checkKey);
    ack({ ok: !err, reason: err });
  });
  socket.on('hello', ({ key } = {}) => {
    if (typeof key === 'string') socket.data.checkKey = key;
  });

  socket.on('disconnect', () => {
    dropNameSocket(socket);
    scheduleLobby();
    if (!room || player.socketId !== socket.id) return;
    // 공개방에서 기다리던 사람이 나가면 자리를 비워서, 로비에 유령 대기자가 남지 않게 한다
    if (room.visibility === 'public' && room.phase === 'waiting') {
      removeFromRoom();
      return;
    }
    player.socketId = null;
    pauseIfAbandoned(room);
    broadcast(room);
    if (room.players.every((p) => !p.socketId)) {
      const r = room;
      r.cleanup = setTimeout(() => deleteRoom(r), ROOM_TTL_MS);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Wanna Debate? (토론함뜰래?): http://localhost:${PORT}`);
  warmUp().then(ensureOpenRooms);
  if (mockMode) console.log('GEMINI_API_KEY가 없어 테스트 모드(가짜 AI 응답)로 실행합니다.');
});
