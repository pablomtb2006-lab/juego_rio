/**
 * Thin WebGL2 layer for the fluid solver: float render targets, multi-output passes, point
 * scatters and GPU timers. It owns NO three.js state: when the solver shares a context with a
 * three.js renderer, the caller must call `renderer.resetState()` after a solver step.
 *
 * Every pass sets the state it needs (program, framebuffer, viewport, blend, masks) instead of
 * assuming anything about what ran before it.
 */
export const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export class GPU {
  constructor(gl) {
    this.gl = gl;
    const need = (name) => {
      const ext = gl.getExtension(name);
      if (!ext) throw new Error(`Río Vivo needs WebGL2 + ${name}; this device does not provide it.`);
      return ext;
    };
    need('EXT_color_buffer_float');
    this.floatBlend = !!gl.getExtension('EXT_float_blend');
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.vao = gl.createVertexArray(); // attribute-less draws (fullscreen triangle, point scatters)
    this.programs = [];
    this.timers = new Map(); // label -> { pending: [query], ms }
  }

  compile(type, src, label) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      const lines = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
      throw new Error(`[fluid] shader "${label}" failed:\n${log}\n${lines}`);
    }
    return s;
  }

  /** Link a program and index its uniforms (name -> { loc, type, unit }). */
  program(label, fs, vs = FULLSCREEN_VS) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this.compile(gl.VERTEX_SHADER, vs, `${label}.vs`));
    gl.attachShader(p, this.compile(gl.FRAGMENT_SHADER, fs, `${label}.fs`));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`[fluid] link "${label}": ${gl.getProgramInfoLog(p)}`);
    const uniforms = {};
    let unit = 0;
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      const sampler = info.type === gl.SAMPLER_2D || info.type === gl.INT_SAMPLER_2D;
      uniforms[name] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size, unit: sampler ? unit++ : -1 };
    }
    const prog = { label, p, uniforms };
    this.programs.push(prog);
    return prog;
  }

  /** Bind a program and set uniforms from a plain object (textures, numbers, arrays). */
  use(prog, values = {}) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    for (const [name, v] of Object.entries(values)) {
      const u = prog.uniforms[name];
      if (!u) continue; // optimised away by the compiler: harmless
      if (u.unit >= 0) {
        gl.activeTexture(gl.TEXTURE0 + u.unit);
        gl.bindTexture(gl.TEXTURE_2D, v);
        gl.uniform1i(u.loc, u.unit);
        continue;
      }
      switch (u.type) {
        case gl.FLOAT:
          if (u.size > 1) gl.uniform1fv(u.loc, v);
          else gl.uniform1f(u.loc, v);
          break;
        case gl.INT:
        case gl.BOOL:
          gl.uniform1i(u.loc, v);
          break;
        case gl.FLOAT_VEC2:
          gl.uniform2fv(u.loc, v);
          break;
        case gl.FLOAT_VEC3:
          gl.uniform3fv(u.loc, v);
          break;
        case gl.FLOAT_VEC4:
          gl.uniform4fv(u.loc, v);
          break;
        case gl.INT_VEC3:
          gl.uniform3iv(u.loc, v);
          break;
        case gl.FLOAT_MAT3:
          gl.uniformMatrix3fv(u.loc, false, v);
          break;
        case gl.FLOAT_MAT4:
          gl.uniformMatrix4fv(u.loc, false, v);
          break;
        default:
          throw new Error(`[fluid] uniform type 0x${u.type.toString(16)} (${name}) not handled`);
      }
    }
  }

  /** RGBA32F texture, nearest, clamped — the format of every solver buffer. */
  texture(w, h, data = null) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    t.w = w;
    t.h = h;
    return t;
  }

  upload(tex, data, x = 0, y = 0, w = tex.w, h = tex.h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.FLOAT, data);
  }

  /** Framebuffer writing to one or more textures (MRT). Cached per texture tuple. */
  target(textures) {
    const gl = this.gl;
    const key = textures.map((t) => (t.__id ??= Math.random().toString(36).slice(2))).join('|');
    this._fbos ??= new Map();
    let f = this._fbos.get(key);
    if (f) return f;
    f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    textures.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`[fluid] framebuffer incomplete 0x${status.toString(16)}`);
    f.w = textures[0].w;
    f.h = textures[0].h;
    this._fbos.set(key, f);
    return f;
  }

  /** Neutral state for a solver pass. */
  begin(fbo) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, fbo.w, fbo.h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.depthMask(false);
    gl.bindVertexArray(this.vao);
  }

  /** One fullscreen pass: every texel of the target runs the fragment shader once. */
  pass(prog, targets, uniforms) {
    const gl = this.gl;
    this.begin(this.target(targets));
    this.use(prog, uniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  clear(targets, r = 0, g = 0, b = 0, a = 0) {
    const gl = this.gl;
    this.begin(this.target(targets));
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Read a whole float texture back to the CPU (synchronous: diagnostics and tests only). */
  read(tex, out = new Float32Array(tex.w * tex.h * 4)) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target([tex]));
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, tex.w, tex.h, gl.RGBA, gl.FLOAT, out);
    return out;
  }

  // --- GPU timers (EXT_disjoint_timer_query_webgl2): asynchronous, reported a few frames late ---

  timeBegin(label) {
    if (!this.timerExt || !this.timing || this._open) return;
    const gl = this.gl;
    const q = gl.createQuery();
    gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, q);
    this._open = { label, q };
  }

  timeEnd() {
    if (!this._open) return;
    const gl = this.gl;
    gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
    const { label, q } = this._open;
    this._open = null;
    let t = this.timers.get(label);
    if (!t) this.timers.set(label, (t = { pending: [], ms: NaN }));
    t.pending.push(q);
  }

  /** Collect finished timer queries. Returns { label: ms } (latest known values). */
  pollTimers() {
    const gl = this.gl;
    const out = {};
    if (!this.timerExt) return out;
    const disjoint = gl.getParameter(this.timerExt.GPU_DISJOINT_EXT);
    for (const [label, t] of this.timers) {
      while (t.pending.length && gl.getQueryParameter(t.pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = t.pending.shift();
        if (!disjoint) t.ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(q);
      }
      out[label] = t.ms;
    }
    return out;
  }
}
