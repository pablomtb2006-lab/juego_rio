// ad-hoc experiments: node tools/dev/fluid-exp.mjs '<test>' '<json opts>' ...
import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${server.resolvedUrls.local[0]}lab/agua/tests.html`);
await page.waitForFunction(() => window.__READY);
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const name = args[i], opts = JSON.parse(args[i + 1] ?? '{}');
  const r = await page.evaluate(([n, o]) => window.__fluid.run(n, o), [name, opts]);
  const keep = ['pressureSlope', 'pressureSlopeError', 'surfaceHeight', 'kineticEnd', 'speedMeanEnd', 'densityErrorMean', 'gateRatio', 'frontRatio', 'massRelError', 'lostParticles'];
  console.log(name, JSON.stringify(opts), r.pass ? 'PASA' : 'FALLA', JSON.stringify(Object.fromEntries(Object.entries(r.metrics).filter(([k]) => keep.includes(k)).map(([k, v]) => [k, +(+v).toPrecision(4)]))));
}
await browser.close(); await server.close();
