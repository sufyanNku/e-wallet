import { create } from "zustand";
// Nonsensitive, in-memory view preferences only. No persisted secret inputs.
export const useUiState = create<{
  accountsOpen: boolean;
  remoteMedia: boolean;
  setAccountsOpen: (open: boolean) => void;
  setRemoteMedia: (enabled: boolean) => void;
}>((set) => ({
  accountsOpen: false,
  remoteMedia: false,
  setAccountsOpen: (accountsOpen) => set({ accountsOpen }),
  setRemoteMedia: (remoteMedia) => set({ remoteMedia }),
}));
