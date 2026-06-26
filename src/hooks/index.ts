/**
 * Barrel file for the hooks surface.
 *
 * Hooks are intentionally exported one-per-file so tree-shaking can
 * drop unused hooks. This barrel is for the public re-export from
 * `../index.tsx` only.
 */

export { useDeepLink } from './useDeepLink';
export type { UseDeepLinkReturn } from './useDeepLink';

export { useIdentify } from './useIdentify';
export type { UseIdentifyOptions, UseIdentifyReturn } from './useIdentify';

export { usePushClicked } from './usePushClicked';

export { usePushPermission } from './usePushPermission';
export type { UsePushPermissionReturn } from './usePushPermission';

export { usePushReceived } from './usePushReceived';

export { useSynapse } from './useSynapse';
export type { UseSynapseReturn } from './useSynapse';
