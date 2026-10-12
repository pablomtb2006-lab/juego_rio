import { Storage } from './Storage.js';
import { Economy } from './Economy.js';
import { Ads } from './Ads.js';
import { Analytics } from './Analytics.js';
import { Settings } from './Settings.js';
import { PauseControl } from './Pause.js';
import { CONFIG } from './config.js';

/**
 * ctx.services = { storage, economy, ads, analytics, settings, pause, config }
 * Created first in Engine.init (before game/audio exist): anything touching other subsystems
 * reads them lazily from ctx.
 */
export function createServices(ctx) {
  const storage = new Storage('rioroyale');
  const analytics = new Analytics(ctx, storage);
  const settings = new Settings(storage);
  const economy = new Economy(ctx, storage, analytics);
  const pause = new PauseControl(ctx);
  const ads = new Ads(ctx, analytics, pause, storage);
  analytics.attach(ctx.bus, () => ctx.game);
  return { storage, economy, ads, analytics, settings, pause, config: CONFIG };
}
