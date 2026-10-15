// 토론함뜰래? 배경음악: public/audio의 음원을 진행 단계에 맞춰 바꿔 틀어 준다.
// Web Audio로 재생해서 반복이 끊기지 않고, 곡이 바뀔 때는 서서히 겹쳐 넘어간다.
(() => {
  // 장면 → 음원. 판정 대기는 최종 변론 곡을 이어서 튼다.
  const TRACKS = {
    lobby: 'audio/lobby.mp3',
    thinking: 'audio/intro.mp3',
    free: 'audio/free.mp3',
    closing: 'audio/final.mp3',
    judging: 'audio/final.mp3',
  };
  const STING = 'audio/end.mp3'; // 판정서 공개 효과음 (한 번만)
  const VOLUME = 0.4; // 음원이 노래 음량으로 마스터링되어 있어서 배경음악으로 낮춘다
  const FADE = 1.2; // 곡 전환 시간(초)

  const STORE_KEY = 'wd-music';
  let enabled = (() => { try { return localStorage.getItem(STORE_KEY) !== 'off'; } catch { return true; } })();
  let ctx = null;
  let master = null;
  let scene = 'lobby';
  let current = null; // { url, src, gain }
  let holdUntil = 0; // 효과음이 끝날 때까지 배경음악을 쉬게 한다
  const buffers = new Map(); // url → Promise<AudioBuffer>
  const listeners = new Set();

  function load(url) {
    if (!buffers.has(url)) {
      const p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`${url}: ${r.status}`);
          return r.arrayBuffer();
        })
        .then((data) => ctx.decodeAudioData(data))
        .catch((err) => {
          buffers.delete(url); // 다음에 다시 시도할 수 있게
          throw err;
        });
      buffers.set(url, p);
    }
    return buffers.get(url);
  }

  function fadeOut(track) {
    if (!track) return;
    const t = ctx.currentTime;
    track.gain.gain.cancelScheduledValues(t);
    track.gain.gain.setValueAtTime(track.gain.gain.value, t);
    track.gain.gain.linearRampToValueAtTime(0, t + FADE);
    track.src.stop(t + FADE + 0.05);
  }

  // 지금 장면에 맞는 곡을 튼다. 이미 그 곡이면 그대로 둔다 (최종 변론 → 판정 대기처럼).
  async function apply() {
    if (!enabled || !ctx) return;
    if (ctx.currentTime < holdUntil) return;
    const url = TRACKS[scene];
    if (current?.url === url) return;
    const wanted = scene;
    let buffer;
    try {
      buffer = await load(url);
    } catch (err) {
      console.warn('배경음악을 불러오지 못했어요:', err.message);
      return;
    }
    // 불러오는 사이 장면이 또 바뀌었거나 꺼졌으면 그만둔다
    if (!enabled || scene !== wanted || current?.url === url || ctx.currentTime < holdUntil) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(1, ctx.currentTime + FADE);
    src.connect(gain).connect(master);
    src.start();
    fadeOut(current);
    current = { url, src, gain };
  }

  let unlockedAt = 0; // 브라우저가 소리를 허락한 시각
  const notify = () => {
    if (ctx?.state === 'running' && !unlockedAt) unlockedAt = performance.now();
    listeners.forEach((fn) => fn(window.Music.status()));
  };

  function init() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    // 아이폰은 무음 스위치를 켜면 웹 소리도 꺼지는데, "음악 재생"으로 알려 주면 그대로 난다 (지원하는 사파리만)
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = VOLUME;
    master.connect(ctx.destination);
    ctx.onstatechange = notify;
    // 지금 곡을 먼저, 나머지는 뒤에서 미리 받아 둔다
    load(TRACKS[scene]).catch(() => {});
    setTimeout(() => [...new Set([...Object.values(TRACKS), STING])].forEach((u) => load(u).catch(() => {})), 1500);
    return true;
  }

  function start() {
    if (!enabled || !init()) return;
    // resume()은 사용자 입력 처리 중에 바로 불러야 허락받는다 (await 뒤에 부르면 막힐 수 있다)
    if (ctx.state !== 'running') ctx.resume().then(notify, () => {});
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(VOLUME, ctx.currentTime, 0.2);
    apply();
  }

  function stop() {
    if (!ctx) return;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
    setTimeout(() => {
      if (enabled) return;
      if (current) current.src.stop();
      current = null;
      ctx.suspend();
    }, 600);
  }

  // 브라우저는 사용자가 한 번 클릭/입력하기 전엔 소리를 못 내게 한다.
  // 어떤 입력을 "허락"으로 치는지가 브라우저마다 달라서(사파리, 터치 기기 등) 여러 입력에서 모두 시도한다.
  const kick = () => { if (enabled && (!ctx || ctx.state !== 'running')) start(); };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'touchend', 'click', 'keydown']) {
    window.addEventListener(type, kick, { passive: true, capture: true });
  }
  // 페이지가 열리자마자 준비해 둔다. 브라우저가 자동 재생을 허락하면 바로 나오고, 아니면 첫 입력에서 바로 시작된다.
  if (enabled) start();

  window.Music = {
    setScene(name) {
      if (!TRACKS[name] || name === scene) return;
      scene = name;
      apply();
    },
    // 판정서 공개: 배경음악을 잠깐 내리고 효과음을 한 번 튼 뒤, 지금 장면의 곡으로 돌아온다
    async sting() {
      if (!enabled || !ctx || ctx.state !== 'running') return;
      let buffer;
      try {
        buffer = await load(STING);
      } catch {
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(master);
      src.start();
      holdUntil = ctx.currentTime + buffer.duration - 1;
      fadeOut(current);
      current = null;
      setTimeout(apply, (buffer.duration - 1) * 1000 + 50);
    },
    isOn: () => enabled,
    toggle() {
      enabled = !enabled;
      try { localStorage.setItem(STORE_KEY, enabled ? 'on' : 'off'); } catch {}
      if (enabled) start(); else stop();
      notify();
      return enabled;
    },
    // 'on' 재생 중 · 'blocked' 켜져 있지만 브라우저가 아직 소리를 막는 중 · 'off' 꺼 둠
    status: () => (!enabled ? 'off' : ctx?.state === 'running' ? 'on' : 'blocked'),
    // 방금(같은 클릭 안에서) 소리가 풀렸는지. 그 클릭으로 음악을 끄지 않게 할 때 쓴다.
    justUnlocked: () => unlockedAt > 0 && performance.now() - unlockedAt < 800,
    onChange(fn) { listeners.add(fn); },
    // 개발용: 디코딩된 음원 길이 확인
    async durations() {
      if (!ctx) start();
      const out = {};
      for (const u of new Set([...Object.values(TRACKS), STING])) out[u] = (await load(u)).duration;
      return out;
    },
    get debug() {
      return { scene, playing: current?.url ?? null, state: ctx?.state ?? 'none' };
    },
  };
})();
