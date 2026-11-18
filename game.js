(() => {
  const $ = id => document.getElementById(id);
  const cv = $('cv');
  const ctx = cv.getContext('2d');

  // ===== 설정값 (여기서 숫자를 바꿔 난이도 조절) =====
  const cfg = {
    min: 0.20,   // 적정 구간 최소 (이보다 약하면 바람이 빠짐)
    max: 0.55,   // 적정 구간 최대 (이보다 세면 위험)
    sens: 10,    // 마이크 감도
    pop: 0.7,    // 너무 센 상태를 몇 초 버티면 터지는지
    grow: 16     // 일어나는 속도 (%/초)
  };
  const COLOR = { weak: '#f2b134', ok: '#3fb36b', hot: '#e5484d', ink: '#1d1d1f' };
  const BODY = '#3a7bd5', BODY_HOT = '#e5484d'; // 에어 댄서 몸 색 (위험할수록 빨강)

  // 게이지 구간 배치 (약함 / 적정 / 너무 셈)
  $('zWeak').style.width = (cfg.min * 100) + '%';
  $('zOk').style.left = (cfg.min * 100) + '%';
  $('zOk').style.width = ((cfg.max - cfg.min) * 100) + '%';
  $('zHot').style.left = (cfg.max * 100) + '%';
  $('zHot').style.width = ((1 - cfg.max) * 100) + '%';

  const GUIDE = '🎤 마이크에 "후~" 불어서 에어 댄서를 끝까지 일으켜 세우세요';

  // ===== 마이크 입력 =====
  let ac, analyser, buf;
  let noiseFloor = 0; // 시작 시 측정한 주변 소음
  let level = 0;      // 0~1로 정규화된 입김 세기

  async function initMic() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    ac = new (window.AudioContext || window.webkitAudioContext)();
    const src = ac.createMediaStreamSource(stream);
    analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    buf = new Float32Array(analyser.fftSize);
    src.connect(analyser);
  }

  // 현재 프레임의 볼륨(RMS)
  function rawRms() {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }

  // ===== 게임 상태 =====
  // idle | calib | play | win | pop
  let state = 'idle';
  let size = 0;          // 일어선 정도 0~100%
  let pressure = 0;      // 너무 세게 분 상태가 이어진 시간
  let wentRed = false;   // 한 번이라도 너무 세게 불었는지 (PERFECT 판정)
  let calibT = 0, calibSum = 0, calibN = 0;
  let resultTimer = null; // 결과 화면 지연 타이머 (재시작 시 취소)

  // 연출용
  let pieces = [], sparkles = [], confetti = [];
  let shake = 0, clock = 0;
  let shown = 0;         // 화면에 보이는 공기 양 (size를 부드럽게 따라감)
  let dancePhase = 0;    // 흔들림 진행 정도
  let headPos = { x: 0, y: 0 };

  // 화면 모드: idle(START만) / result(결과 카드) / play(게이지)
  function setMode(mode) {
    $('overlay').classList.toggle('hidden', mode === 'play');
    $('overlay').classList.toggle('result', mode === 'result');
    $('card').classList.toggle('hidden', mode !== 'result');
    $('meters').classList.toggle('hidden', mode !== 'play');
  }

  function showResult(reason) {
    resultTimer = null;
    // PERFECT: 한 번도 세게 안 불고 성공 / GOOD: 성공 / BAD: 터짐
    let grade, sub;
    if (reason === 'win' && !wentRed) { grade = 'PERFECT'; sub = '한 번도 세게 불지 않았어요!'; }
    else if (reason === 'win') { grade = 'GOOD'; sub = '끝까지 일어섰어요!'; }
    else { grade = 'BAD'; sub = '💥 ' + Math.floor(size) + '%에서 터졌어요'; }

    $('grade').textContent = grade;
    $('grade').className = 'grade g-' + grade;
    $('cardSub').textContent = sub;
    $('startBtn').textContent = 'RETRY';
    setMode('result');
  }

  $('startBtn').addEventListener('click', async () => {
    clearTimeout(resultTimer); // 이전 판의 결과 화면이 늦게 뜨는 것 방지
    resultTimer = null;
    try {
      if (!analyser) await initMic();
      if (ac.state === 'suspended') await ac.resume();
    } catch (e) {
      setStatus('🎤 마이크 권한을 허용한 뒤 다시 눌러주세요', COLOR.hot);
      $('startBtn').textContent = 'RETRY';
      return;
    }
    setMode('play');
    state = 'calib';
    calibT = 1.2; calibSum = 0; calibN = 0;
    size = 0; pressure = 0; wentRed = false;
    pieces = []; sparkles = []; confetti = [];
    shake = 0;
  });

  let lastStatus = '';
  function setStatus(text, color) {
    if (text !== lastStatus) { $('status').textContent = text; lastStatus = text; }
    $('status').style.color = color || '';
  }

  // ===== 메인 루프 =====
  let last = performance.now();

  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    const r = rawRms();

    // 1) 주변 소음 측정
    if (state === 'calib') {
      calibSum += r; calibN++; calibT -= dt;
      if (calibT <= 0) {
        noiseFloor = calibSum / calibN;
        state = 'play';
      }
    }

    // 2) 입김 세기 계산 (소음 제거 → 감도 → 부드럽게)
    const target = Math.max(0, Math.min(1, (r - noiseFloor * 1.2) * cfg.sens));
    level += (target - level) * 0.35;

    // 3) 규칙 적용
    let growing = false;
    if (state === 'calib') setStatus('🤫 주변 소음 측정 중… 잠시 조용히');

    if (state === 'play') {
      if (level > cfg.max) {
        pressure += dt;
        wentRed = true;
        setStatus('⚠️ 너무 세요! 살살!', COLOR.hot);
      } else {
        pressure = Math.max(0, pressure - dt * 1.5);
        if (level >= cfg.min) {
          size += cfg.grow * dt;
          growing = true;
          setStatus('👍 좋아요, 일어나고 있어요!', COLOR.ok);
        } else if (level > 0.05) {
          size = Math.max(0, size - 5 * dt);
          setStatus('🌬️ 조금 더 세게!', '#c98a0b');
        } else {
          size = Math.max(0, size - 5 * dt);
          setStatus('💨 바람이 빠지고 있어요');
        }
      }

      if (growing && Math.random() < dt * 10) spawnSparkle();
      shake = Math.max(shake, (pressure / cfg.pop) * 3);

      if (pressure >= cfg.pop) {
        state = 'pop';
        burst();
        shake = 14;
        setStatus('💥 펑!', COLOR.hot);
        resultTimer = setTimeout(() => showResult('pop'), 1200);
      } else if (size >= 100) {
        size = 100;
        state = 'win';
        celebrate();
        setStatus('🎉 성공!', COLOR.ok);
        resultTimer = setTimeout(() => showResult('win'), 1200);
      }
    }

    // 화면에 보이는 공기 양: 터지면 빠르게 쭈그러듦
    const goal = state === 'pop' ? 0 : size / 100;
    shown += (goal - shown) * Math.min(1, dt * (state === 'pop' ? 3 : 6));
    shake = Math.max(0, shake - dt * 25);

    // 4) UI 갱신
    const zoneColor = level > cfg.max ? COLOR.hot : level >= cfg.min ? COLOR.ok : COLOR.weak;
    $('gFill').style.width = (level * 100) + '%';
    $('gFill').style.background = zoneColor;
    $('micIcon').style.opacity = 0.35 + level * 0.65;
    $('dangerFill').style.width = (Math.min(1, pressure / cfg.pop) * 100) + '%';
    $('size').textContent = Math.floor(size) + '%';

    draw(dt);
    requestAnimationFrame(tick);
  }

  // ===== 에어 댄서 =====
  const N = 16;          // 몸통 마디 수
  const ARM_N = 6;       // 팔 마디 수

  function layout() {
    const W = cv.clientWidth, H = cv.clientHeight;
    const groundY = H - 80;             // 바닥 (아래쪽은 게이지 자리)
    const baseY = groundY - 26;         // 송풍기 윗면 = 몸통 시작점
    const len = Math.min(baseY - 50, 380);
    return { W, H, groundY, baseX: W / 2, baseY, len, seg: len / N, width: Math.max(24, len * 0.1) };
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // 아래 마디부터 공기가 차오름: i번째 마디의 채워진 정도 (0~1)
  function fillOf(i, p) { return clamp(p * (N + 1) - i, 0, 1); }

  // 몸통 마디 좌표 계산
  function bodyPoints(g, p, flail, speed) {
    const pts = [{ x: g.baseX, y: g.baseY }];
    const fills = [];
    let ang = 0; // 0 = 위쪽, +는 오른쪽으로 기울어짐
    const floor = g.groundY - g.width * 0.22;
    for (let i = 0; i < N; i++) {
      const f = fillOf(i, p);
      const k = i / N;
      // 바람 찬 부분: 위로 갈수록 크게 휘청이는 춤
      const dance = Math.sin(dancePhase * speed + i * 0.55) * flail * (0.05 + k * 0.22);
      // 바람 빠진 부분: 옆으로 꺾여 바닥에 구겨져 눕기
      const room = Math.max(0, 1.75 - Math.abs(ang));
      const droop = Math.min(0.6, room) + Math.sin(i * 2.3) * 0.25;
      ang += dance * f + droop * (1 - f);
      // 바람 빠진 마디는 쭈글쭈글 접혀서 짧아짐
      const segLen = g.seg * (0.38 + 0.62 * f);
      const prev = pts[i];
      const x = prev.x + Math.sin(ang) * segLen;
      const y = Math.min(floor, prev.y - Math.cos(ang) * segLen);
      pts.push({ x, y, ang });
      fills.push(f);
    }
    return { pts, fills };
  }

  // 팔 좌표 계산 (side: -1 왼쪽, 1 오른쪽)
  function armPoints(g, start, bodyAng, f, side, flail, speed) {
    const pts = [{ x: start.x, y: start.y }];
    const seg = g.len * 0.3 / ARM_N * (0.45 + 0.55 * f);
    const floor = g.groundY - g.width * 0.15;
    // 바람 차면 위로 뻗어 흔들고, 빠지면 아래로 축 늘어짐
    const up = bodyAng + side * (1.1 + Math.sin(dancePhase * speed * 1.3 + (side > 0 ? 0 : 2)) * flail * 0.9);
    const hang = side * 2.6; // 몸 방향과 상관없이 아래쪽
    let ang = up * f + hang * (1 - f);
    for (let i = 0; i < ARM_N; i++) {
      ang += Math.sin(dancePhase * speed * 1.6 + i * 0.8 + side) * flail * 0.18 * f;
      const prev = pts[i];
      pts.push({
        x: prev.x + Math.sin(ang) * seg,
        y: Math.min(floor, prev.y - Math.cos(ang) * seg)
      });
    }
    return pts;
  }

  // 마디를 이어서 굵은 튜브로 그리기
  function strokeTube(pts, widthAt, color) {
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i < pts.length - 1; i++) {
      ctx.lineWidth = widthAt(i);
      ctx.beginPath();
      ctx.moveTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
      ctx.stroke();
    }
  }

  function drawDancer(dt) {
    const g = layout();
    const danger = Math.min(1, pressure / cfg.pop);
    const playing = state === 'play' || state === 'calib';

    // 흔들림: 입김이 셀수록 빠르고 크게, 위험하면 미친 듯이
    const flail = state === 'win' ? 1.2 : (0.35 + (playing ? level : 0) * 0.9 + danger * 1.2);
    const speed = 1;
    dancePhase += dt * (2.5 + (playing ? level : 0) * 5 + danger * 8 + (state === 'win' ? 4 : 0));

    const color = mix(BODY, BODY_HOT, danger);
    const { pts, fills } = bodyPoints(g, shown, flail, speed);

    // 팔 (몸통 위쪽 70% 지점)
    const A = Math.round(N * 0.7);
    const armF = fills[A];
    const bodyAng = pts[A + 1].ang || 0;
    const armW = i => g.width * (0.45 + 0.15 * armF);
    const left = armPoints(g, pts[A], bodyAng, armF, -1, flail, speed);
    const right = armPoints(g, pts[A], bodyAng, armF, 1, flail, speed);
    strokeTube(left, armW, color);
    strokeTube(right, armW, color);

    // 몸통: 바람 빠진 곳은 납작하게
    strokeTube(pts, i => g.width * (0.55 + 0.45 * fills[i]), color);

    // 머리 위 삐죽 머리카락
    const top = pts[N];
    const headAng = top.ang || 0;
    const headF = fills[N - 1];
    headPos = { x: top.x, y: top.y };
    ctx.save();
    ctx.translate(top.x, top.y);
    ctx.rotate(headAng);
    ctx.fillStyle = color;
    const w = g.width;
    for (let k = -2; k <= 2; k++) {
      const sway = Math.sin(dancePhase * 2 + k) * 0.25 * headF;
      ctx.save();
      ctx.rotate(k * 0.35 + sway);
      ctx.beginPath();
      ctx.moveTo(-w * 0.1, -w * 0.2);
      ctx.lineTo(w * 0.1, -w * 0.2);
      ctx.lineTo(0, -w * (0.55 + 0.25 * headF));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // 얼굴
    const eyeY = w * 0.55;
    const eyeR = w * (0.12 + 0.05 * headF);
    ctx.fillStyle = '#fff';
    [-1, 1].forEach(s => {
      ctx.beginPath(); ctx.arc(s * w * 0.2, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();
    });
    ctx.fillStyle = COLOR.ink;
    [-1, 1].forEach(s => {
      ctx.beginPath(); ctx.arc(s * w * 0.2, eyeY + eyeR * 0.2, eyeR * 0.5, 0, Math.PI * 2); ctx.fill();
    });
    ctx.strokeStyle = COLOR.ink;
    ctx.lineWidth = Math.max(2, w * 0.07);
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (danger > 0.3 || state === 'pop') {
      // 위험/터짐: 놀란 입
      ctx.arc(0, w * 0.95, w * 0.12, 0, Math.PI * 2);
    } else if (headF < 0.5) {
      // 쓰러져 있을 때: 시무룩
      ctx.arc(0, w * 1.08, w * 0.18, Math.PI * 1.15, Math.PI * 1.85);
    } else {
      // 신난 웃음
      ctx.arc(0, w * 0.82, w * 0.22, Math.PI * 0.15, Math.PI * 0.85);
    }
    ctx.stroke();
    ctx.restore();

    // 송풍기 받침대
    ctx.fillStyle = '#2b2b2e';
    const bw = g.width * 2.4;
    ctx.beginPath();
    ctx.roundRect
      ? ctx.roundRect(g.baseX - bw / 2, g.baseY, bw, g.groundY - g.baseY, 6)
      : ctx.rect(g.baseX - bw / 2, g.baseY, bw, g.groundY - g.baseY);
    ctx.fill();
    // 송풍기 바람 구멍
    ctx.strokeStyle = '#55555a'; ctx.lineWidth = 2;
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.moveTo(g.baseX + k * bw * 0.25 - 6, g.baseY + 13);
      ctx.lineTo(g.baseX + k * bw * 0.25 + 6, g.baseY + 13);
      ctx.stroke();
    }

    return g;
  }

  // ===== 연출 =====
  // 터질 때 조각
  function burst() {
    for (let i = 0; i < 50; i++) {
      const a = Math.random() * Math.PI * 2, s = 150 + Math.random() * 350;
      const g = layout();
      const t = Math.random();
      pieces.push({
        x: g.baseX + (headPos.x - g.baseX) * t, y: g.baseY + (headPos.y - g.baseY) * t,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s - 150,
        life: 1, rot: Math.random() * 6
      });
    }
  }

  // 적정 세기일 때 머리 주변 반짝임
  function spawnSparkle() {
    const a = Math.random() * Math.PI * 2, d = 20 + Math.random() * 40;
    sparkles.push({
      x: headPos.x + Math.cos(a) * d, y: headPos.y + Math.sin(a) * d,
      vy: -20 - Math.random() * 30, life: 1, size: 3 + Math.random() * 4
    });
  }

  // 성공 축하 종이 조각
  function celebrate() {
    const w = cv.clientWidth;
    const colors = ['#ff8fa3', '#ff5a5f', '#3fb36b', '#f2b134', '#5aa9e6'];
    for (let i = 0; i < 90; i++) {
      confetti.push({
        x: Math.random() * w, y: -20 - Math.random() * 200,
        vx: (Math.random() - .5) * 80, vy: 80 + Math.random() * 160,
        rot: Math.random() * 6, vr: (Math.random() - .5) * 10,
        color: colors[i % colors.length], life: 3
      });
    }
  }

  function drawStar(x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const rr = i % 2 === 0 ? r : r * 0.35;
      const a = i * Math.PI / 4;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  }

  // 마이크 입력 파형 (뒤에 은은하게)
  function drawWave(W, cy) {
    if (!analyser || (state !== 'calib' && state !== 'play')) return;
    ctx.save();
    ctx.globalAlpha = 0.12 + level * 0.35;
    ctx.strokeStyle = level > cfg.max ? COLOR.hot : level >= cfg.min ? COLOR.ok : COLOR.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const step = Math.ceil(buf.length / 160);
    const amp = Math.min(90, 30 * cfg.sens);
    for (let i = 0, n = 0; i < buf.length; i += step, n++) {
      const x = (i / buf.length) * W;
      const y = cy + Math.max(-1, Math.min(1, buf[i] * 3)) * amp;
      n === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function draw(dt) {
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== W * dpr || cv.height !== H * dpr) {
      cv.width = W * dpr; cv.height = H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const g = layout();

    // 화면 흔들림
    ctx.save();
    if (shake > 0) ctx.translate((Math.random() - .5) * shake, (Math.random() - .5) * shake);

    drawWave(W, H * 0.45);

    // 목표 높이 점선
    const goalY = g.baseY - g.len;
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = '#cfcac0'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(g.baseX - 150, goalY); ctx.lineTo(g.baseX + 150, goalY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#b5b0a5'; ctx.font = '12px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('목표 100%', g.baseX + 156, goalY + 4);

    // 바닥
    ctx.strokeStyle = '#d8d3c8'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, g.groundY); ctx.lineTo(W, g.groundY); ctx.stroke();

    drawDancer(dt);

    // 반짝임
    ctx.fillStyle = '#ffd34d';
    sparkles.forEach(s => {
      s.y += s.vy * dt; s.life -= dt * 1.6;
      if (s.life <= 0) return;
      ctx.globalAlpha = s.life;
      drawStar(s.x, s.y, s.size * (0.6 + s.life * 0.4));
    });
    ctx.globalAlpha = 1;
    sparkles = sparkles.filter(s => s.life > 0);

    // 터진 조각
    pieces.forEach(p => {
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 600 * dt;
      p.life -= dt * 1.0; p.rot += dt * 8;
      if (p.life <= 0) return;
      ctx.save();
      ctx.globalAlpha = p.life; ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = BODY_HOT; ctx.fillRect(-6, -3, 12, 6);
      ctx.restore();
    });
    pieces = pieces.filter(p => p.life > 0);

    if (state === 'pop' && pieces.length) {
      ctx.fillStyle = COLOR.ink; ctx.font = 'bold 48px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('POP!', W / 2, H * 0.4);
    }

    ctx.restore();

    // 성공 축하 조각 (흔들림 영향 없이)
    confetti.forEach(c => {
      c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.vr * dt; c.life -= dt;
      if (c.life <= 0 || c.y > H + 20) return;
      ctx.save();
      ctx.globalAlpha = Math.min(1, c.life);
      ctx.translate(c.x, c.y); ctx.rotate(c.rot);
      ctx.fillStyle = c.color; ctx.fillRect(-5, -3, 10, 6);
      ctx.restore();
    });
    confetti = confetti.filter(c => c.life > 0 && c.y <= H + 20);
  }

  // 두 색을 t(0~1) 비율로 섞기
  function mix(a, b, t) {
    const pa = [1, 3, 5].map(i => parseInt(a.substr(i, 2), 16));
    const pb = [1, 3, 5].map(i => parseInt(b.substr(i, 2), 16));
    return 'rgb(' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(',') + ')';
  }

  setMode('idle');
  setStatus(GUIDE);
  requestAnimationFrame(tick);
})();
