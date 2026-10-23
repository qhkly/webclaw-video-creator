import { create } from 'zustand';
import type { SupportAvailability } from '../lib/support';

interface SupportStore {
  availability: SupportAvailability;
  unread: number;
  open: () => void;
  setAvailability: (availability: SupportAvailability) => void;
  setUnread: (unread: number) => void;
  setOpener: (open: () => void) => void;
}

/** Bridge between the widget host (App) and the Settings entry. */
export const useSupportStore = create<SupportStore>((set) => ({
  availability: 'checking',
  unread: 0,
  open: () => {},
  setAvailability: (availability) => set({ availability }),
  setUnread: (unread) => set({ unread }),
  setOpener: (open) => set({ open }),
}));
