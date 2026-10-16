const socket = io();
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const SIDE = { pro: '찬성', con: '반대' };
const STAGE = { opening: '입론', free: '자유토론', closing: '최종 변론' };

// 닉네임은 브라우저 전체(localStorage)에 기억하고,
// 플레이어 키와 방 코드는 탭마다(sessionStorage) 따로 둔다.
// 그래야 같은 브라우저의 탭 두 개가 서로 다른 플레이어로 들어갈 수 있고, 새로고침하면 같은 자리로 돌아온다.
const makeStore = (getStorage) => ({
  get(k) { try { return getStorage().getItem(k); } catch { return null; } },
  set(k, v) { try { getStorage().setItem(k, v); } catch {} },
  del(k) { try { getStorage().removeItem(k); } catch {} },
});
const store = makeStore(() => localStorage);
const tabStore = makeStore(() => sessionStorage);
let playerKey = tabStore.get('wd-key');
if (!playerKey) {
  playerKey = crypto.randomUUID?.() ?? String(Math.random()).slice(2);
  tabStore.set('wd-key', playerKey);
}

let state = null;
let clockOffset = 0;
let renderedTurns = 0;
let renderedTopic = null;
let renderedPhase = null;
let lastComment = null;
let lobby = { rooms: [], playing: 0, online: 0 };

// ---------- 로비 ----------
const nameInput = $('#name');
nameInput.value = store.get('wd-name') ?? '';
let inviteCode = new URLSearchParams(location.search).get('room')?.toUpperCase();
if (inviteCode) {
  $('#join-invite').hidden = false;
  $('#invite-code').textContent = inviteCode;
}

function myName() {
  const n = nameInput.value.trim();
  if (n) store.set('wd-name', n);
  return n;
}

function requireName() {
  const n = myName();
  if (!n) {
    showLobbyError('토론자 이름을 먼저 정해 주세요.');
    nameInput.focus();
  }
  return n;
}

// 이름을 치는 동안 서버에 물어서 쓸 수 있는 이름인지 바로 보여 준다
let nameCheckTimer = null;
function checkNameSoon() {
  clearTimeout(nameCheckTimer);
  const hint = $('#name-hint');
  const name = nameInput.value.trim();
  if (!name) {
    hint.textContent = '';
    hint.className = 'name-hint';
    return;
  }
  nameCheckTimer = setTimeout(() => {
    socket.emit('name:check', name, (res) => {
      if (nameInput.value.trim() !== name) return; // 그사이 또 바뀌었으면 무시
      hint.textContent = res.ok ? '사용할 수 있는 이름이에요' : res.reason;
      hint.className = `name-hint ${res.ok ? 'ok' : 'bad'}`;
    });
  }, 350);
}
nameInput.addEventListener('input', () => {
  showLobbyError('');
  checkNameSoon();
});

function showLobbyError(msg) {
  const el = $('#lobby-error');
  el.textContent = msg;
  el.hidden = !msg;
}

$('#btn-quick').onclick = () => {
  const name = requireName();
  if (name) socket.emit('quickmatch', { name, key: playerKey });
};
$('#btn-create').onclick = () => {
  const name = requireName();
  if (name) socket.emit('create', { name, key: playerKey });
};
$('#btn-join').onclick = () => {
  const name = requireName();
  const code = $('#code').value.trim().toUpperCase();
  if (!code) return showLobbyError('초대 코드를 입력해 주세요.');
  if (name) socket.emit('join', { code, name, key: playerKey });
};
$('#btn-join-invite').onclick = () => {
  const name = requireName();
  if (name) socket.emit('join', { code: inviteCode, name, key: playerKey });
};
$('#btn-copy').onclick = async () => {
  const url = `${location.origin}/?room=${state.code}`;
  try {
    await navigator.clipboard.writeText(url);
    $('#btn-copy').textContent = '복사했어요!';
  } catch {
    prompt('이 링크를 상대에게 보내세요', url);
  }
  setTimeout(() => ($('#btn-copy').textContent = '초대 링크 복사'), 1500);
};

socket.on('joined', ({ code }) => {
  tabStore.set('wd-room', code);
  history.replaceState(null, '', `/?room=${code}`);
  showLobbyError('');
});

// 방에서 나와 로비로 돌아왔을 때: 재접속 대상 방을 지우고 화면을 처음 상태로
socket.on('left', () => {
  state = null;
  window.Music?.setScene('lobby');
  inviteCode = null;
  tabStore.del('wd-room');
  history.replaceState(null, '', '/');
  $('#join-invite').hidden = true;
  renderedPhase = null;
  lastComment = null;
  $('.app').classList.remove('in-debate', 'wide');
  document.body.classList.remove('wide');
  showScreen('lobby');
  renderLobby();
});

socket.on('lobby', (data) => {
  lobby = data;
  renderLobby();
});

// 연결 상태: 끊기면 로비에 표시하고, 다시 붙으면 서버가 최신 목록을 보내 준다
socket.on('disconnect', () => renderLobby());
socket.on('connect', () => renderLobby());

const refreshBtn = $('#btn-refresh');
refreshBtn.onclick = () => {
  refreshBtn.classList.remove('spin');
  void refreshBtn.offsetWidth;
  refreshBtn.classList.add('spin');
  if (socket.connected) socket.emit('lobby:refresh');
  else socket.connect();
};

function renderLobby() {
  const stats = $('#lobby-stats');
  stats.innerHTML = '';
  const dot = document.createElement('span');
  dot.className = socket.connected ? 'live' : 'live down';
  stats.append(dot, document.createTextNode(
    socket.connected ? `접속 ${lobby.online}명 · 토론 중 ${lobby.playing}판` : '연결이 끊겼어요 · 다시 연결하는 중…'
  ));

  const list = $('#room-list');
  list.innerHTML = '';
  $('#room-empty').hidden = lobby.rooms.length > 0;
  for (const r of lobby.rooms) {
    const li = document.createElement('li');
    li.className = `room${r.waitingName ? ' waiting' : ''}`;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');

    const top = document.createElement('div');
    top.className = 'room-top';
    const cat = document.createElement('span');
    cat.className = 'room-cat';
    cat.textContent = r.category;
    const code = document.createElement('span');
    code.className = 'room-code-tag';
    code.textContent = r.code;
    top.append(cat, code);

    const title = document.createElement('p');
    title.className = 'room-title';
    title.textContent = r.title;
    const bg = document.createElement('p');
    bg.className = 'room-bg';
    bg.textContent = r.background;

    const foot = document.createElement('div');
    foot.className = 'room-foot';
    const status = document.createElement('span');
    status.className = 'room-status';
    status.textContent = r.waitingName ? `${r.waitingName}님이 기다리는 중` : '비어 있음 · 먼저 들어가 기다리기';
    const enter = document.createElement('span');
    enter.className = 'room-enter';
    enter.textContent = r.waitingName ? '바로 대결' : '입장';
    foot.append(status, enter);

    li.append(top, title, bg, foot);
    const go = () => {
      const name = requireName();
      if (name) socket.emit('join', { code: r.code, name, key: playerKey });
    };
    li.onclick = go;
    li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    list.append(li);
  }
}
socket.on('fail', (msg) => {
  showScreen('lobby');
  showLobbyError(msg);
});

// 연결이 다시 붙으면 원래 방으로 자동 복귀
socket.on('connect', () => {
  socket.emit('hello', { key: playerKey }); // 내가 점유한 이름은 "사용 중"으로 보이지 않게
  checkNameSoon();
  const code = inviteCode ?? tabStore.get('wd-room');
  if (code && state) socket.emit('join', { code, name: myName() || '익명', key: playerKey });
});
// 처음 열었을 때 이미 들어가 있던 방이면 바로 복귀 시도
if (inviteCode && inviteCode === tabStore.get('wd-room') && myName()) {
  socket.emit('join', { code: inviteCode, name: myName(), key: playerKey });
}

// ---------- 진영 선택 / 발언 / 기타 ----------
$$('.choice').forEach((btn) => {
  btn.onclick = () => socket.emit('choose', btn.dataset.choice);
});

const speech = $('#speech');
const speakBtn = $('#speak-form button');
let draftTimer = null;
let cooldownUntil = 0;
const isFree = () => state?.current?.stage === 'free';

function updateCount() {
  $('#count').textContent = `${speech.value.length} / ${speech.maxLength}`;
}
speech.addEventListener('input', () => {
  updateCount();
  if (isFree()) return; // 자유토론은 초안 저장 없이 바로바로 보낸다
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => socket.emit('draft', speech.value), 400);
});
speech.addEventListener('keydown', (e) => {
  if (e.isComposing) return; // 한글 조합 중 Enter는 무시
  // 자유토론은 Enter로 바로 전송(Shift+Enter 줄바꿈), 입론·변론은 Ctrl/Cmd+Enter
  if (e.key === 'Enter' && (isFree() ? !e.shiftKey : e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    $('#speak-form').requestSubmit();
  }
});
$('#speak-form').onsubmit = (e) => {
  e.preventDefault();
  if (!speech.value.trim() || Date.now() < cooldownUntil) return;
  socket.emit('speak', speech.value);
  speech.value = '';
  updateCount();
  if (isFree()) {
    cooldownUntil = Date.now() + state.limits.freeCooldownMs;
    speakBtn.disabled = true;
    setTimeout(() => (speakBtn.disabled = false), state.limits.freeCooldownMs);
  }
};

$('#btn-retry').onclick = () => socket.emit('retry');
$('#btn-rematch').onclick = () => socket.emit('rematch');
$('#btn-leave-waiting').onclick = () => socket.emit('leave');
$('#btn-leave-result').onclick = () => socket.emit('leave');

// ---------- 렌더링 ----------
function showScreen(name) {
  $$('.screen').forEach((s) => (s.hidden = s.id !== `screen-${name}`));
  $('.app').classList.toggle('lobby-wide', name === 'lobby');
}
showScreen('lobby');

socket.on('state', (s) => {
  clockOffset = s.serverNow - Date.now();
  const prevPhase = state?.phase;
  state = s;
  render(prevPhase);
});

// 진행 단계에 맞는 배경음악 장면
function musicScene(s) {
  if (s.phase === 'debate') return s.current.stage === 'opening' ? 'thinking' : s.current.stage;
  if (s.phase === 'judging') return 'judging';
  return 'lobby';
}

function render(prevPhase) {
  const s = state;
  window.Music?.setScene(musicScene(s));
  if (s.phase === 'result' && prevPhase && prevPhase !== 'result') window.Music?.sting();
  $('#mock-banner').hidden = !s.mockMode;
  const opponent = s.players.find((p) => !p.isMe);
  $('#opponent-left').hidden = !opponent || opponent.connected || s.phase === 'waiting';

  $('#error-box').hidden = !s.error;
  if (s.error) $('#error-msg').textContent = s.error.message;

  const inGame = ['debate', 'judging', 'result'].includes(s.phase);
  $('.app').classList.toggle('in-debate', s.phase === 'debate' || s.phase === 'judging');
  $('.app').classList.toggle('wide', inGame);
  document.body.classList.toggle('wide', inGame);

  switch (s.phase) {
    case 'waiting':
      showScreen('waiting');
      renderWaiting(s);
      break;
    case 'topic':
      showScreen('topic');
      break;
    case 'choosing':
      showScreen('choosing');
      renderChoosing(s, opponent);
      break;
    case 'coin':
      showScreen('coin');
      if (prevPhase !== 'coin') playCoin(s);
      break;
    default:
      showScreen('debate');
      renderDebate(s, prevPhase);
  }
  if (s.phase !== renderedPhase) {
    renderedPhase = s.phase;
    window.scrollTo({ top: 0 });
  }
}

function renderWaiting(s) {
  const isPublic = s.visibility === 'public';
  $('#waiting-public').hidden = !isPublic;
  $('#waiting-private').hidden = isPublic;
  if (isPublic) {
    $('#waiting-category').textContent = s.topic.category ?? '논제';
    $('#waiting-title').textContent = s.topic.title;
    $('#waiting-bg').textContent = s.topic.background;
  } else {
    $('#room-code').textContent = s.code;
  }
}

function renderChoosing(s, opponent) {
  $('#screen-choosing .topic-title').textContent = s.topic.title;
  $('#screen-choosing .topic-bg').textContent = s.topic.background;
  $('[data-hint="pro"]').textContent = s.topic.proHint;
  $('[data-hint="con"]').textContent = s.topic.conHint;
  $$('.choice').forEach((btn) => {
    btn.disabled = !!s.me.choice;
    btn.classList.toggle('picked', s.me.choice === btn.dataset.choice);
  });
  let status = '';
  if (s.me.choice) status = `${SIDE[s.me.choice]}석을 골랐습니다. `;
  status += opponent?.chose ? `${opponent.name}님도 자리를 골랐습니다.` : `${opponent?.name ?? '상대'}님이 자리를 고르는 중…`;
  $('#choose-status').textContent = status;
}

function playCoin(s) {
  const side = SIDE[s.coin.contested];
  $('#coin-intro').textContent = `두 토론자 모두 ${side}석을 원합니다. 동전으로 정하겠습니다.`;
  $('#coin-result').textContent = '';
  const coin = $('#coin');
  coin.className = 'coin';
  void coin.offsetWidth; // 애니메이션 재시작
  coin.classList.add('flip', s.coin.contested === 'pro' ? 'land-front' : 'land-back');
  setTimeout(() => {
    $('#coin-result').textContent = `${s.coin.winner}님 ${side}, ${s.coin.loser}님 ${s.coin.contested === 'pro' ? '반대' : '찬성'}!`;
  }, 2000);
}

const playerOf = (s, side) => s.players.find((x) => x.side === side);
// 상대가 나간 뒤에도 판정서와 속기록에 이름이 남도록 서버가 보내 준 진영별 이름을 함께 쓴다
function nameOf(s, side) {
  const p = playerOf(s, side);
  if (p) return `${p.name}${p.isMe ? ' (나)' : ''}`;
  return s.names?.[side] ?? SIDE[side];
}

function renderStage(s) {
  $('.topic-mini').textContent = s.topic.title;
  $('.topic-mini').title = s.topic.title;

  const { pro, con, comment } = s.gauge;
  $('.gauge-pro').style.width = `${pro}%`;
  $('.gauge-con').style.width = `${con}%`;
  $('.gauge').setAttribute('aria-valuenow', pro);
  $('.pro-num').textContent = pro;
  $('.con-num').textContent = con;

  const commentEl = $('.gauge-comment');
  commentEl.textContent = comment;
  if (lastComment !== null && lastComment !== comment) {
    commentEl.classList.remove('flash');
    void commentEl.offsetWidth;
    commentEl.classList.add('flash');
  }
  lastComment = comment;

  // 연단: 이름표, 발언 중이면 조명, 연결이 끊기면 자리 비움
  const step = s.phase === 'debate' ? s.current : null;
  for (const side of ['pro', 'con']) {
    const p = playerOf(s, side);
    const podium = $(`#podium-${side}`);
    const speaking = !!step && !s.paused && (step.stage === 'free' || step.side === side);
    const away = p && !p.connected;
    podium.classList.toggle('speaking', speaking);
    podium.classList.toggle('away', !!away);
    $(`.${side}-name`).textContent = p?.name ?? SIDE[side];
    podium.querySelector('.podium-status span').textContent =
      away ? '자리 비움' : speaking ? '발언 중' : p?.isMe ? '나' : '대기';
  }

  // 진행 단계 표시
  const order = ['opening', 'free', 'closing'];
  const nowIdx = step ? order.indexOf(step.stage) : order.length;
  $$('.steps li').forEach((li) => {
    const i = order.indexOf(li.dataset.stage);
    li.classList.toggle('done', i < nowIdx);
    li.classList.toggle('now', i === nowIdx);
  });
}

function renderDebate(s) {
  renderStage(s);
  const screen = $('#screen-debate');
  const live = s.phase === 'debate';
  const result = s.phase === 'result';
  screen.classList.toggle('is-result', result);
  $('#debate-live').hidden = !live;
  $('#judging').hidden = s.phase !== 'judging' || !!s.error;
  $('#result').hidden = !result;
  $('#result-actions').hidden = !result;

  renderLog(s);

  if (live) {
    const { stage, side } = s.current;
    const free = stage === 'free';
    const mine = free || side === s.me.side;
    $('#turn-label').textContent = s.paused
      ? '일시 정지'
      : free ? '자유토론 · 양측 모두 발언 가능' : `${SIDE[side]} 측 ${STAGE[stage]} · ${side === s.me.side ? '내 차례' : nameOf(s, side)}`;
    $('#speak-form').hidden = !mine;
    $('#wait-turn').hidden = mine;
    $('#wait-turn').textContent = `${nameOf(s, side)}님이 ${SIDE[side]} 측 ${STAGE[stage]}을 준비하고 있습니다…`;

    const maxLen = free ? s.limits.free : s.limits.speech;
    if (speech.maxLength !== maxLen) {
      speech.maxLength = maxLen;
      speech.value = speech.value.slice(0, maxLen);
      updateCount();
    }
    speech.rows = free ? 2 : 4;
    $('#speak-form').classList.toggle('free', free);
    $('.speak-head span').textContent = free ? '자유토론 · 마이크가 켜져 있습니다' : `${SIDE[side]} 측 ${STAGE[stage]} · 마이크가 켜졌습니다`;
    speakBtn.textContent = free ? '보내기' : '발언 마치기';
    speech.placeholder = free
      ? '짧게 치고받으세요 (Enter 전송, Shift+Enter 줄바꿈)'
      : stage === 'opening'
        ? '내 주장과 근거를 펼쳐 보세요 (Ctrl+Enter 제출)'
        : '왜 내 쪽이 옳은지 마지막으로 정리하세요 (Ctrl+Enter 제출)';
  } else {
    $('#speak-form').hidden = true;
    $('#wait-turn').hidden = true;
  }

  if (result) renderResult(s);
}

const logScroll = $('#log-scroll');
const jumpBtn = $('#jump-latest');
const nearBottom = () => logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight < 80;
function scrollLogToEnd() {
  logScroll.scrollTop = logScroll.scrollHeight;
  jumpBtn.hidden = true;
}
logScroll.addEventListener('scroll', () => {
  if (nearBottom()) jumpBtn.hidden = true;
});
jumpBtn.onclick = scrollLogToEnd;

function makeEntry(s, t) {
  const li = document.createElement('li');
  li.className = `entry ${t.side} stage-${t.stage}`;
  if (t.timedOut) li.classList.add('timeout');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = SIDE[t.side];
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = nameOf(s, t.side);
  meta.append(tag, who);
  const body = document.createElement('p');
  body.textContent = t.text;
  li.append(meta, body);
  return li;
}

// 속기록은 새 발언만 덧붙인다. 맨 아래를 보고 있었으면 따라 내려가고,
// 위로 올려서 지난 발언을 읽는 중이면 자리를 지키고 "새 발언 보기" 버튼만 띄운다.
function renderLog(s) {
  const log = $('#log');
  if (renderedTopic !== s.topic.title || s.turns.length < renderedTurns) {
    log.innerHTML = '';
    renderedTurns = 0;
    renderedTopic = s.topic.title;
    jumpBtn.hidden = true;
  }
  $('#log-empty').hidden = s.turns.length > 0;
  if (s.turns.length === renderedTurns) return;

  const follow = nearBottom();
  let prevStage = s.turns[renderedTurns - 1]?.stage ?? null;
  let mineAdded = false;
  for (const t of s.turns.slice(renderedTurns)) {
    if (t.stage !== prevStage) {
      const div = document.createElement('li');
      div.className = 'entry-divider';
      div.textContent = `— ${STAGE[t.stage]} —`;
      log.append(div);
      prevStage = t.stage;
    }
    log.append(makeEntry(s, t));
    if (t.side === s.me.side) mineAdded = true;
  }
  renderedTurns = s.turns.length;

  if (s.phase !== 'debate') return;
  if (follow || mineAdded) requestAnimationFrame(scrollLogToEnd);
  else jumpBtn.hidden = false;
}

function fillList(sel, items) {
  const ul = $(sel);
  ul.innerHTML = '';
  for (const it of items ?? []) {
    const li = document.createElement('li');
    li.textContent = it;
    ul.append(li);
  }
}

function renderResult(s) {
  const r = s.report;
  $('#v-topic').textContent = s.topic.title;
  $('#v-pro').textContent = nameOf(s, 'pro');
  $('#v-con').textContent = nameOf(s, 'con');

  const title = $('#winner-title');
  title.innerHTML = '';
  if (r.winner === 'draw') {
    title.textContent = '양측 동률로 무승부를 선언한다.';
  } else {
    const who = document.createElement('span');
    who.className = r.winner;
    who.textContent = `${SIDE[r.winner]} 측 ${playerOf(s, r.winner)?.name ?? s.names?.[r.winner] ?? ''}`;
    title.append(who, document.createTextNode('의 승리로 판정한다.'));
  }
  $('#final-score').textContent = `찬성 ${r.pro} : ${r.con} 반대`;

  const stamp = $('#stamp');
  stamp.textContent = r.winner === 'draw' ? '무' : '승';
  if (!stamp.classList.contains('go')) stamp.classList.add('go');

  $('#r-score').textContent = r.scoreReason;
  $('#r-win-title').textContent = r.winner === 'draw' ? '팽팽했던 이유' : `${SIDE[r.winner]} 측이 이긴 이유`;
  $('#r-win').textContent = r.winReason;
  fillList('#r-pro', r.proKeyPoints);
  fillList('#r-con', r.conKeyPoints);
  fillList('#r-missed', r.missedArguments);

  const tips = $('#r-tips');
  tips.innerHTML = '';
  for (const side of [s.me.side, s.me.side === 'pro' ? 'con' : 'pro']) {
    const box = document.createElement('div');
    box.className = `tips side-${side}${side === s.me.side ? ' mine' : ''}`;
    const h = document.createElement('h4');
    h.textContent = side === s.me.side ? `나에게 (${SIDE[side]} 측)` : `${nameOf(s, side)}에게 (${SIDE[side]} 측)`;
    const ul = document.createElement('ul');
    for (const t of side === 'pro' ? r.proTips : r.conTips) {
      const li = document.createElement('li');
      li.textContent = t;
      ul.append(li);
    }
    box.append(h, ul);
    tips.append(box);
  }
  const d = new Date();
  $('#v-date').textContent = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
  renderHistory(s);

  const opponent = s.players.find((p) => !p.isMe);
  const btn = $('#btn-rematch');
  btn.disabled = s.me.wantsRematch || !opponent;
  btn.textContent = !opponent
    ? '상대가 로비로 나갔어요'
    : s.me.wantsRematch
    ? `${opponent?.name ?? '상대'}님의 수락을 기다리는 중…`
    : opponent?.wantsRematch ? `${opponent.name}님이 재대결을 신청했어요! 수락하기` : '새 논제로 한 판 더';
}

// 게이지 갱신 시점마다 찬성 점수 흐름을 간단한 SVG 선 그래프로 그린다 (50 = 팽팽)
const CHART_LABEL = { start: '시작', opening: '입론', free: '자유', closing: '변론', final: '판정' };
function renderHistory(s) {
  const W = 320, H = 140, padL = 28, padR = 12, padT = 12, padB = 24;
  const hist = s.gaugeHistory;
  const x = (i) => padL + (i / Math.max(1, hist.length - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - v / 100) * (H - padT - padB);
  const pts = hist.map((g, i) => `${x(i).toFixed(1)},${y(g.pro).toFixed(1)}`).join(' ');
  // 단계가 바뀌는 첫 지점에만 라벨을 단다
  const ticks = hist.map((g, i) => (i === 0 || g.stage !== hist[i - 1].stage
    ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="tick">${CHART_LABEL[g.stage]}</text>` : '')).join('');
  const dots = hist.map((g, i) =>
    `<circle cx="${x(i)}" cy="${y(g.pro)}" r="3.5" class="dot${g.stage === 'final' ? ' final' : ''}"><title>${CHART_LABEL[g.stage]}: 찬성 ${g.pro} : ${100 - g.pro} 반대</title></circle>`).join('');
  $('#history-chart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="토론 중 찬성 우세 점수 변화">
      <rect x="${padL}" y="${padT}" width="${W - padL - padR}" height="${y(50) - padT}" class="zone-pro"/>
      <rect x="${padL}" y="${y(50)}" width="${W - padL - padR}" height="${H - padB - y(50)}" class="zone-con"/>
      <line x1="${padL}" x2="${W - padR}" y1="${y(50)}" y2="${y(50)}" class="mid"/>
      <text x="${padL - 6}" y="${padT + 10}" text-anchor="end" class="tick">찬</text>
      <text x="${padL - 6}" y="${H - padB}" text-anchor="end" class="tick">반</text>
      <polyline points="${pts}" class="line"/>
      ${dots}${ticks}
    </svg>`;
}

// ---------- 타이머 ----------
setInterval(() => {
  if (state?.phase !== 'debate' || !state.deadline || state.paused) return;
  const left = Math.max(0, state.deadline - (Date.now() + clockOffset));
  const sec = Math.ceil(left / 1000);
  $('#timer').textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  $('#timer').classList.toggle('urgent', sec <= 10);
  $('#timer-fill').style.width = `${(left / (state.current.seconds * 1000)) * 100}%`;
}, 250);

// ---------- 배경음악 버튼 + 볼륨 패널 ----------
const musicBtn = $('#btn-music');
const musicPanel = $('#music-panel');
const musicSwitch = $('#music-onoff');
const volumeInput = $('#music-volume');
const volumeVal = $('#music-volume-val');

function renderMusicBtn(status) {
  musicBtn.classList.toggle('off', status === 'off');
  musicBtn.classList.toggle('blocked', status === 'blocked');
  musicBtn.querySelector('span').textContent =
    status === 'on' ? '음악 켜짐' : status === 'blocked' ? '탭하면 음악 재생' : '음악 꺼짐';
  musicSwitch.setAttribute('aria-checked', String(status !== 'off'));
}
function renderVolume() {
  const v = Math.round(window.Music.getVolume() * 100);
  volumeInput.value = v;
  volumeVal.textContent = `${v}%`;
  volumeInput.style.setProperty('--fill', `${v}%`);
}
function setPanel(open) {
  musicPanel.hidden = !open;
  musicBtn.setAttribute('aria-expanded', String(open));
}

if (window.Music) {
  renderMusicBtn(window.Music.status());
  renderVolume();
  window.Music.onChange(renderMusicBtn);

  // 버튼은 설정 패널을 열고 닫는다. 이 클릭으로 막혀 있던 소리도 함께 풀린다(music.js가 첫 입력에서 재생 시작).
  musicBtn.onclick = (e) => {
    e.stopPropagation();
    setPanel(musicPanel.hidden);
  };
  musicSwitch.onclick = (e) => {
    e.stopPropagation();
    window.Music.toggle();
  };
  volumeInput.addEventListener('input', () => {
    window.Music.setVolume(volumeInput.value / 100);
    // 꺼 둔 상태에서 볼륨을 올리면 다시 켠다
    if (!window.Music.isOn() && volumeInput.value > 0) window.Music.toggle();
    renderVolume();
  });
  // 패널 밖을 누르거나 Esc를 누르면 닫는다
  document.addEventListener('click', (e) => {
    if (!musicPanel.hidden && !$('#music-ctl').contains(e.target)) setPanel(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !musicPanel.hidden) {
      setPanel(false);
      musicBtn.focus();
    }
  });
} else {
  $('#music-ctl').hidden = true;
}
