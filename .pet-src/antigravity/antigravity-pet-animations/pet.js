(function () {
  'use strict';
  const names = { idle: '待机', thinking: '思考', working: '工作', complete: '完成' };
  const markup = `<div class="ag-shadow"></div><div class="ag-body-motion"><div class="ag-body">
    <img class="ag-logo" alt="" draggable="false">
    <svg class="ag-face" viewBox="0 0 180 180" aria-hidden="true">
      <g class="ag-eyes-normal">
        <g class="ag-eye"><ellipse cx="78" cy="61" rx="6.5" ry="8.5" fill="white"/><g class="ag-pupil"><ellipse cx="78.5" cy="62" rx="3.1" ry="4.4" fill="#203659"/><circle cx="79.4" cy="60.4" r="1" fill="white"/></g></g>
        <g class="ag-eye ag-eye-right"><ellipse cx="102" cy="61" rx="6.5" ry="8.5" fill="white"/><g class="ag-pupil"><ellipse cx="102.5" cy="62" rx="3.1" ry="4.4" fill="#203659"/><circle cx="103.4" cy="60.4" r="1" fill="white"/></g></g>
      </g>
      <g class="ag-brows" stroke="#203659" stroke-width="2.1" stroke-linecap="round"><path d="m72 48 11 3M97 51l11-3"/></g>
      <g class="ag-happy-eye" fill="none" stroke="#203659" stroke-width="3" stroke-linecap="round"><path d="M72 62q6-9 12 0M96 62q6-9 12 0"/></g>
      <path class="ag-mouth ag-mouth-normal" d="M84 78q6 6 12 0"/>
      <path class="ag-happy-mouth" d="M83 76q7 4 14 0q-1 12-7 12t-7-12" fill="#203659"/><path class="ag-happy-mouth" d="M86 84q4-3 8 0q-4 6-8 0" fill="#fb9696"/>
    </svg></div></div>
    <div class="ag-thought"><div class="ag-thought-cloud"><i class="ag-thought-dot"></i><i class="ag-thought-dot"></i><i class="ag-thought-dot"></i></div></div>
    <div class="ag-terminal"><div class="ag-terminal-header"><i></i><i></i><i></i></div><div class="ag-code"><div class="ag-code-line"><i></i><i></i></div><div class="ag-code-line"><i></i><i></i></div><div class="ag-code-line"><i></i><i></i></div></div><i class="ag-hand ag-hand-left"></i><i class="ag-hand ag-hand-right"></i></div>
    <div class="ag-success"><svg viewBox="0 0 28 28" aria-hidden="true"><path d="m4 14 7 7L24 6"/></svg></div>
    <div class="ag-burst" aria-hidden="true"></div>`;

  class AntigravityPet {
    constructor(element, options = {}) {
      if (!(element instanceof HTMLElement)) throw new TypeError('A pet container element is required.');
      this.element = element;
      this.destroyed = false;
      element.classList.add('ag-pet');
      element.innerHTML = markup;
      element.setAttribute('role', 'img');
      element.querySelector('.ag-logo').src = options.imageSrc || './assets/antigravity.svg';
      const colors = ['#4285f4', '#fbbc04', '#34a853', '#ea4335'];
      for (let i = 0; i < 12; i++) {
        const bit = document.createElement('i');
        const angle = (i / 12) * Math.PI * 2;
        bit.className = 'ag-confetti';
        bit.style.setProperty('--dx', String(Math.cos(angle) * .62));
        bit.style.setProperty('--dy', String(Math.sin(angle) * .57 - .12));
        bit.style.setProperty('--turn', `${i % 2 ? 250 : -210}deg`);
        bit.style.setProperty('--color', colors[i % 4]);
        element.querySelector('.ag-burst').append(bit);
      }
      this.setSize(options.size ?? 240);
      this.setSpeed(options.speed ?? 1);
      this.setFace(options.face !== false);
      this.setPaused(Boolean(options.paused));
      this.setState(options.state || 'idle');
    }
    setState(state, { restart = false } = {}) {
      if (!Object.hasOwn(names, state)) throw new RangeError(`Unknown pet state: ${state}`);
      if (this.destroyed) return;
      if (restart && this.element.dataset.state === state) {
        this.element.dataset.state = '';
        void this.element.offsetWidth;
      }
      this.element.dataset.state = state;
      this.element.setAttribute('aria-label', `Antigravity 宠物：${names[state]}`);
      this.element.dispatchEvent(new CustomEvent('petstatechange', { detail: { state } }));
    }
    setSpeed(value) {
      const speed = Number(value);
      if (!Number.isFinite(speed) || speed < .25 || speed > 3) throw new RangeError('Speed must be between 0.25 and 3.');
      this.element.style.setProperty('--time-scale', String(1 / speed));
    }
    setSize(value) {
      const size = Number(value);
      if (!Number.isFinite(size) || size < 32 || size > 1024) throw new RangeError('Size must be between 32 and 1024.');
      this.element.style.setProperty('--pet-size', `${size}px`);
    }
    setFace(value) { this.element.dataset.face = String(Boolean(value)); }
    setPaused(value) { this.element.dataset.paused = String(Boolean(value)); }
    restart() { this.setState(this.element.dataset.state, { restart: true }); }
    destroy() { this.destroyed = true; this.element.replaceChildren(); }
  }
  window.AntigravityPet = AntigravityPet;
}());
