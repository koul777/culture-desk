import { createContext, useContext } from 'react';
import type { Bootstrap, Performance } from '../shared/types';
import type { View } from './lib/hooks';

export interface ItemPatch { item: Performance; seq: number }

/** Shared app state and actions used by every view. */
export interface Desk {
  boot: Bootstrap;
  refresh: () => Promise<Bootstrap | undefined>;
  run: <T>(key: string, task: () => Promise<T>) => Promise<T | undefined>;
  isBusy: (key: string) => boolean;
  openDetail: (id: number) => void;
  publish: (item: Performance) => void;
  reloadConfig: () => Promise<void>;
  backup: () => Promise<void>;
  shutdown: () => Promise<void>;
  patch: ItemPatch | null;
  go: (view: View) => void;
  /** Changes whenever collected data or collection progress changes; views refetch on it. */
  signature: string;
}

export const DeskContext = createContext<Desk | null>(null);
export function useDesk(): Desk {
  const desk = useContext(DeskContext);
  if (!desk) throw new Error('DeskContext가 없습니다.');
  return desk;
}
