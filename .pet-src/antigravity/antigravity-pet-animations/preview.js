(function () {
  'use strict';
  const states = {
    idle: { name: '待机', title: '我在，随时开始。', description: '轻轻悬浮，偶尔眨眼。', duration: 2500 },
    thinking: { name: '思考', title: '让我想一想。', description: '歪着脑袋，把思路慢慢串起来。', duration: 3500 },
    working: { name: '工作', title: '好，交给我。', description: '专注敲击，让想法一点点成形。', duration: 4500 },
    complete: { name: '完成', title: '完成啦！', description: '跳一下，庆祝这个小小的进展。', duration: 3500 }
  };
  const stage = document.getElementById('pet-stage');
  const anchor = document.getElementById('pet-anchor');
  const mainElement = document.getElementById('main-pet');
  const imageSrc = document.querySelector('.brand img').getAttribute('src');
  const pet = new AntigravityPet(mainElement, { imageSrc });
  const minis = Array.from(document.querySelectorAll('.mini-pet')).map(element => new AntigravityPet(element, { imageSrc, size: 145, state: element.dataset.miniState }));
  const allPets = [pet, ...minis];
  const pauseButton = document.getElementById('pause');
  const demoButton = document.getElementById('demo');
  const demoNote = document.getElementById('demo-note');
  const sizeInput = document.getElementById('pet-size');
  const order = Object.keys(states);
  let paused = false, speed = 1, demo = false, demoIndex = 0, elapsed = 0, lastTime = null, raf = 0;
  let position = { x: .5, y: .45 }, drag = null;
  function setState(state, restart = true) {
    pet.setState(state, { restart });
    stage.dataset.state = state;
    document.getElementById('status-label').textContent = states[state].name;
    document.getElementById('state-title').textContent = states[state].title;
    document.getElementById('state-description').textContent = states[state].description;
    document.querySelectorAll('[data-select-state]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.selectState === state)));
  }
  function demoUI(message) {
    demoButton.classList.toggle('active', demo);
    demoButton.setAttribute('aria-pressed', String(demo));
    demoButton.textContent = demo ? '停止流程演示' : '播放完整流程';
    stage.dataset.demo = demo ? 'running' : 'stopped';
    if (message) demoNote.textContent = message;
  }
  function stopDemo(message) {
    demo = false;
    cancelAnimationFrame(raf);
    raf = 0; lastTime = null;
    demoUI(message);
  }
  function tick(now) {
    if (!demo || paused || document.hidden) { lastTime = null; raf = 0; return; }
    if (lastTime !== null) elapsed += (now - lastTime) * speed;
    lastTime = now;
    if (elapsed >= states[order[demoIndex]].duration) {
      elapsed = 0;
      demoIndex++;
      if (demoIndex >= order.length) {
        stopDemo('流程演示完成，可手动切换状态或再次播放。');
        stage.dataset.demo = 'complete';
        return;
      }
      setState(order[demoIndex]);
      demoNote.textContent = `正在演示 ${demoIndex + 1}/4 · ${states[order[demoIndex]].name}`;
    }
    raf = requestAnimationFrame(tick);
  }
  function resumeDemo() { if (demo && !paused && !document.hidden && !raf) { lastTime = null; raf = requestAnimationFrame(tick); } }
  function setPaused(value) {
    paused = value;
    allPets.forEach(item => item.setPaused(paused || document.hidden));
    pauseButton.textContent = paused ? '继续动画' : '暂停动画';
    pauseButton.setAttribute('aria-pressed', String(paused));
    if (paused) { cancelAnimationFrame(raf); raf = 0; lastTime = null; }
    else resumeDemo();
  }
  document.querySelectorAll('[data-select-state]').forEach(button => button.addEventListener('click', () => {
    stopDemo('手动预览 · 可重新播放当前状态。');
    setState(button.dataset.selectState);
  }));
  document.querySelectorAll('.segmented [data-bg]').forEach(button => button.addEventListener('click', () => {
    stage.dataset.bg = button.dataset.bg;
    document.querySelectorAll('.segmented [data-bg]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }));
  pauseButton.addEventListener('click', () => setPaused(!paused));
  document.getElementById('replay').addEventListener('click', () => {
    stopDemo('已重播当前状态。');
    setState(mainElement.dataset.state);
  });
  document.getElementById('replay-complete').addEventListener('click', () => minis[3].restart());
  demoButton.addEventListener('click', () => {
    if (demo) { stopDemo('流程已停止，可手动切换状态。'); return; }
    demo = true; demoIndex = 0; elapsed = 0; lastTime = null;
    setPaused(false); setState('idle');
    demoUI('正在演示 1/4 · 待机');
    resumeDemo();
  });
  document.getElementById('speed').addEventListener('change', event => {
    speed = Number(event.target.value);
    allPets.forEach(item => item.setSpeed(speed));
  });
  document.getElementById('face').addEventListener('change', event => allPets.forEach(item => item.setFace(event.target.checked)));
  function place(x, y) {
    const bounds = stage.getBoundingClientRect();
    const size = Number(sizeInput.value), half = size / 2 + 8;
    const nx = Math.max(half, Math.min(bounds.width - half, x));
    const ny = Math.max(half, Math.min(bounds.height - half - 50, y));
    position = { x: nx / bounds.width, y: ny / bounds.height };
    anchor.style.left = `${position.x * 100}%`; anchor.style.top = `${position.y * 100}%`;
  }
  sizeInput.addEventListener('input', () => {
    pet.setSize(sizeInput.value);
    document.getElementById('size-value').textContent = `${sizeInput.value} px`;
    const b = stage.getBoundingClientRect(); place(position.x * b.width, position.y * b.height);
  });
  new ResizeObserver(() => { const b = stage.getBoundingClientRect(); place(position.x * b.width, position.y * b.height); }).observe(stage);
  anchor.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    const b = stage.getBoundingClientRect();
    drag = { id: event.pointerId, dx: event.clientX - b.left - b.width * position.x, dy: event.clientY - b.top - b.height * position.y };
    anchor.setPointerCapture(event.pointerId);
  });
  anchor.addEventListener('pointermove', event => { if (drag && drag.id === event.pointerId) { const b = stage.getBoundingClientRect(); place(event.clientX - b.left - drag.dx, event.clientY - b.top - drag.dy); } });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) anchor.addEventListener(name, () => { drag = null; });
  anchor.addEventListener('keydown', event => {
    const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
    if (delta) { event.preventDefault(); const b = stage.getBoundingClientRect(); place(position.x * b.width + delta[0], position.y * b.height + delta[1]); }
  });
  document.addEventListener('visibilitychange', () => {
    allPets.forEach(item => item.setPaused(paused || document.hidden));
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; lastTime = null; }
    else resumeDemo();
  });
  // The public component is reusable; page controls are only a preview of agent states.
  window.antigravityPet = pet;
  setState('idle', false);
  demoUI();
}());
