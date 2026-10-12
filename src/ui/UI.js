import '@fontsource/luckiest-guy/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/800.css';
import './ui.css';

/**
 * DOM overlay: loading is handled in main.js; this owns menu, HUD, minimap,
 * callouts, kill feed, result screen and shop. Listens to bus events only —
 * never mutates game state except through game.startMatch / toMenu / revivePlayer
 * and services.economy.
 * Contract: ui.update(dt), ui.resize(w, h), ui.showMap(bool), ui.callout(text, highlight?)
 */
export class UI {
  constructor(ctx) {
    this.ctx = ctx;
    const root = (this.root = document.createElement('div'));
    root.id = 'ui';
    if (ctx.params.nohud) root.style.display = 'none';
    root.innerHTML = `
      <div class="menu" data-el="menu">
        <h1 class="logo">RÍO<span>ROYALE</span></h1>
        <p class="tagline">Sé el primero en llegar al mar</p>
        <button class="btn play" data-el="play">JUGAR</button>
        <div class="wallet">💧 <b data-el="coins">0</b> Gotas</div>
      </div>
      <div class="hud" data-el="hud">
        <div class="top">
          <div class="dist"><b data-el="dist">0.00</b><small>KM TO SEA</small></div>
          <div class="vol">💧 <b data-el="vol">0</b> <small>L</small></div>
        </div>
        <div class="alive" data-el="alive"></div>
        <canvas class="minimap" data-el="minimap" width="200" height="200"></canvas>
        <div class="feed" data-el="feed"></div>
      </div>
      <div class="callout" data-el="callout"></div>
      <div class="result" data-el="result">
        <div class="place" data-el="place">#1</div>
        <div class="sub" data-el="resultSub"></div>
        <div class="reward" data-el="reward"></div>
        <button class="btn" data-el="again">OTRA VEZ</button>
      </div>`;
    document.body.appendChild(root);
    this.el = {};
    root.querySelectorAll('[data-el]').forEach((e) => (this.el[e.dataset.el] = e));

    this.el.play.onclick = () => {
      ctx.audio?.unlock?.();
      ctx.game.startMatch();
    };
    this.el.again.onclick = () => ctx.game.toMenu();

    const bus = ctx.bus;
    bus.on('phase', ({ state }) => this.onPhase(state));
    bus.on('landed', ({ stream }) => stream.isPlayer && this.callout('SWALLOW LAKES TO GROW', 'STRONGER'));
    bus.on('eliminated', ({ victim, by }) => this.feed(`${victim.name} ${by ? `was cut off by ${by.name}` : 'dried up'}`));
    bus.on('cut', ({ attacker, victim }) => this.feed(`${attacker.name} cut ${victim.name}`));
    bus.on('finished', ({ stream, place }) => this.feed(`${stream.name} reached the sea #${place}`));
    bus.on('matchEnd', (e) => this.onMatchEnd(e));
    this.onPhase('menu');
  }

  init() {
    this.drawMapBase();
  }

  onPhase(state) {
    this.el.menu.style.display = state === 'menu' ? 'flex' : 'none';
    this.el.hud.style.display = state === 'drop' || state === 'stream' ? 'block' : 'none';
    this.el.result.style.display = state === 'result' ? 'flex' : 'none';
    this.el.coins.textContent = this.ctx.services.economy.coins.toLocaleString('en-US');
    if (state === 'drop') this.callout('THE GOAL?', 'BE THE FIRST TO THE SEA');
  }

  onMatchEnd({ outcome, place, player }) {
    const eco = this.ctx.services.economy;
    const coins = eco.rewardFor({ place, peakVolume: player.peakVolume });
    eco.grant(coins, 'match');
    eco.recordMatch(place);
    this.el.place.textContent = `#${place}`;
    this.el.resultSub.textContent = outcome === 'win' ? 'FIRST TO THE SEA!' : `Cut off by ${player.eliminatedBy?.name ?? 'the drought'}`;
    this.el.reward.textContent = `+${coins} Gotas`;
  }

  callout(text, highlight = '') {
    const c = this.el.callout;
    c.innerHTML = `${text}${highlight ? `<br><span>${highlight}</span>` : ''}`;
    c.classList.remove('show');
    void c.offsetWidth;
    c.classList.add('show');
  }

  feed(text) {
    const d = document.createElement('div');
    d.textContent = text;
    this.el.feed.prepend(d);
    setTimeout(() => d.remove(), 4000);
  }

  showMap() {}

  drawMapBase() {
    const { terrain } = this.ctx;
    const c = document.createElement('canvas');
    const N = 200;
    c.width = c.height = N;
    const g = c.getContext('2d');
    const img = g.createImageData(N, N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = (i / (N - 1) - 0.5) * terrain.size;
        const z = (j / (N - 1) - 0.5) * terrain.size;
        const h = terrain.heightAt(x, z);
        const k = (j * N + i) * 4;
        if (h <= 0) img.data.set([30, 110, 160, 255], k);
        else {
          const t = Math.min(h / 1000, 1);
          img.data.set([90 + t * 100, 120 + t * 60, 60 + t * 80, 255], k);
        }
      }
    }
    g.putImageData(img, 0, 0);
    this.mapBase = c;
  }

  drawMinimap() {
    const cv = this.el.minimap;
    const g = cv.getContext('2d');
    const { terrain, game } = this.ctx;
    const N = cv.width;
    g.drawImage(this.mapBase, 0, 0, N, N);
    for (const s of game.streams) {
      const t = s.trail;
      if (t.count < 2) continue;
      g.strokeStyle = s.isPlayer ? '#ffffff' : `#${s.color.toString(16).padStart(6, '0')}`;
      g.lineWidth = s.isPlayer ? 2.5 : 1.5;
      g.beginPath();
      for (let i = 0; i < t.count; i += 4) {
        const x = (t.data[i * 4] / terrain.size + 0.5) * N;
        const y = (t.data[i * 4 + 2] / terrain.size + 0.5) * N;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
  }

  update() {
    const { game } = this.ctx;
    const p = game.player;
    if (!p || (game.state !== 'drop' && game.state !== 'stream')) return;
    const dist = p.phase === 'drop' ? this.ctx.terrain.distToSea(p.pos.x, p.pos.z) : p.distToSea;
    this.el.dist.textContent = (dist / 1000).toFixed(2);
    this.el.vol.textContent = Math.round(p.volume).toLocaleString('en-US');
    this.el.alive.textContent = `${game.aliveCount} streams left`;
    this.frame = (this.frame ?? 0) + 1;
    if (this.frame % 6 === 0) this.drawMinimap();
  }

  resize() {}
}

