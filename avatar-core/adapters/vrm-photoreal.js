import { createAvatarCore } from '../expression-mixer.js';
import { createVrmAdapter } from './vrm.js';

export const SARRA_PHOTOREAL_RIG_SIGNATURE = 'sarra-photoreal-arkit-visemes-v1';

export const SARRA_PHOTOREAL_VISEME_MAPPING = Object.freeze({
  AA: Object.freeze({ aa: 1 }),
  IH: Object.freeze({ ih: 1 }),
  OU: Object.freeze({ ou: 1 }),
  EE: Object.freeze({ E: 1 }),
  OH: Object.freeze({ oh: 1 }),
  P: Object.freeze({ PP: 1 }),
  F: Object.freeze({ FF: 1 }),
});

export function createSarraPhotorealAdapter(options = {}) {
  return createVrmAdapter({
    ...options,
    modelIdentity: {
      ...options.modelIdentity,
      id: 'sarra-photoreal.vrm',
      rigSignature: SARRA_PHOTOREAL_RIG_SIGNATURE,
    },
  });
}

export function createSarraPhotorealAvatarCore({ adapter, ...options } = {}) {
  const core = createAvatarCore({
    ...options,
    adapter: adapter || createSarraPhotorealAdapter(),
  });
  core.setVisemeMapping(SARRA_PHOTOREAL_VISEME_MAPPING);
  return core;
}
