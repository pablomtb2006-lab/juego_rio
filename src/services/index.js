import { Storage } from './Storage.js';
import { Economy } from './Economy.js';
import { Ads } from './Ads.js';
import { Analytics } from './Analytics.js';

/** ctx.services = { storage, economy, ads, analytics } */
export function createServices(ctx) {
  const storage = new Storage('rioroyale');
  const analytics = new Analytics(ctx);
  const economy = new Economy(ctx, storage, analytics);
  const ads = new Ads(ctx, analytics);
  return { storage, economy, ads, analytics };
}
