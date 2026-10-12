const COLORS = ['#FFD23F', '#FFB800', '#35D0D6', '#ffffff', '#FF5FA2', '#7DFF6B', '#A77BFF'];

/** Lightweight dt-driven confetti + water-drop burst on a full-screen canvas. */
export class Confetti {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.parts = [];
    this.on = false;
    this.seed = 1;
  }

  rand() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  start() {
    this.on = true;
    this.parts = [];
    this.seed = 7;
    this.age = 0;
    this.b1 = this.b2 = false;
    this.drizzle = 0;
  }

  stop() {
    this.on = false;
    this.parts = [];
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  spawn(n, W, H) {
    for (let i = 0; i < n; i++) {
      const side = this.rand() < 0.5 ? -1 : 1;
      this.parts.push({
        x: W / 2 + side * W * (0.05 + this.rand() * 0.1),
        y: H * 0.32,
        vx: side * (120 + this.rand() * 420) + (this.rand() - 0.5) * 120,
        vy: -(380 + this.rand() * 520),
        r: this.rand() * Math.PI,
        vr: (this.rand() - 0.5) * 14,
        w: 6 + this.rand() * 8,
        hgt: 4 + this.rand() * 6,
        c: COLORS[Math.floor(this.rand() * COLORS.length)],
        life: 2.6 + this.rand() * 1.8,
        age: 0,
        drop: this.rand() < 0.22,
      });
    }
  }

  update(dt, W, H) {
    if (!this.on) return;
    const cv = this.canvas;
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    this.age += dt;
    // two bursts, then a light drizzle
    if (!this.b1) {
      this.b1 = true;
      this.spawn(90, W, H);
    }
    if (!this.b2 && this.age > 0.55) {
      this.b2 = true;
      this.spawn(70, W, H);
    }
    if (this.age < 4) {
      this.drizzle = (this.drizzle ?? 0) + dt * 14;
      while (this.drizzle >= 1) {
        this.drizzle--;
        this.spawn(1, W, H);
      }
    }
    const g = this.g;
    g.clearRect(0, 0, W, H);
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.age += dt;
      if (p.age > p.life || p.y > H + 40) {
        this.parts.splice(i, 1);
        continue;
      }
      p.vy += 720 * dt;
      p.vx *= Math.exp(-dt * 1.4);
      p.vy = Math.min(p.vy, 260 + (p.w % 3) * 40);
      p.x += p.vx * dt + Math.sin(p.age * 6 + p.r) * 30 * dt;
      p.y += p.vy * dt;
      p.r += p.vr * dt;
      const a = p.age > p.life - 0.5 ? (p.life - p.age) / 0.5 : 1;
      g.globalAlpha = a;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.r);
      g.fillStyle = p.c;
      if (p.drop) {
        g.beginPath();
        g.moveTo(0, -p.w * 0.8);
        g.quadraticCurveTo(p.w * 0.6, 0, 0, p.w * 0.5);
        g.quadraticCurveTo(-p.w * 0.6, 0, 0, -p.w * 0.8);
        g.fillStyle = '#7fe8ff';
        g.fill();
      } else {
        g.scale(1, Math.cos(p.age * 9 + p.r));
        g.fillRect(-p.w / 2, -p.hgt / 2, p.w, p.hgt);
      }
      g.restore();
    }
    g.globalAlpha = 1;
  }
}
