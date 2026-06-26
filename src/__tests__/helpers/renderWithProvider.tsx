/**
 * Render a component tree wrapped in a fully-settled `<SynapseProvider>`.
 *
 * `<SynapseProvider>` runs an async `Synapse.initialize()` followed by a
 * `Synapse.debugInfo()` fetch in its mount effect. Tests that don't
 * wait for both calls to settle leak React state updates into the next
 * tick, producing noisy `act()` warnings even when assertions pass.
 *
 * This helper renders the tree and `await`s until the provider has
 * called both methods. Tests should `await renderWithProvider(...)`
 * before making assertions to keep stdout clean.
 */

import {
  render,
  waitFor,
  type RenderResult,
} from '@testing-library/react-native';
import type { ReactElement } from 'react';

import {
  SynapseProvider,
  type SynapseProviderProps,
} from '../../SynapseProvider';
import { mockNative } from './setup';

export type RenderWithProviderOptions = Omit<SynapseProviderProps, 'children'>;

/**
 * Render a tree wrapped in `<SynapseProvider>` and wait for the
 * provider's mount-effect chain (`initialize` → `debugInfo`) to settle
 * before returning. Tests should `await` this helper so subsequent
 * assertions don't race against async state-updates that React would
 * complain about with an `act()` warning.
 */
export async function renderWithProvider(
  ui: ReactElement,
  options: RenderWithProviderOptions
): Promise<RenderResult> {
  // @testing-library/react-native v14 returns `Promise<RenderResult>`
  // (the renderer's mount is async). Await before reaching for queries.
  const result = await render(
    <SynapseProvider {...options}>{ui}</SynapseProvider>
  );

  // Wait for both async calls in the provider's mount effect chain.
  // The trailing setState after debugInfo() resolves still fires from
  // outside any active act scope; jest.setup.ts filters the resulting
  // benign "act(...)" console warning so output stays clean.
  await waitFor(() => {
    expect(mockNative.initialize).toHaveBeenCalled();
    expect(mockNative.debugInfo).toHaveBeenCalled();
  });

  return result;
}
