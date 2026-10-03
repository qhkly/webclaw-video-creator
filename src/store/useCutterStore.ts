import { create } from 'zustand';
import { retimeWords, type CutMap, type CutSource, type Transcript } from '../lib/cut-plan';

interface Snapshot {
  cuts: CutMap;
  transcript: Transcript | null;
}

const HISTORY_LIMIT = 200;

interface CutterStore {
  videoPath: string;
  transcript: Transcript | null;
  cuts: CutMap;
  past: Snapshot[];
  future: Snapshot[];
  loadVideo: (path: string) => void;
  setTranscript: (transcript: Transcript) => void;
  /** Mark units as cut. If every given unit is already cut, restore them instead (toggle semantics). */
  toggleCuts: (ids: string[], source?: CutSource) => void;
  cutUnits: (ids: string[], source: CutSource) => void;
  restoreUnits: (ids: string[]) => void;
  revertAi: () => void;
  editSegmentText: (segmentId: string, text: string) => void;
  undo: () => void;
  redo: () => void;
}

export const useCutterStore = create<CutterStore>((set) => {
  /** Apply a change while recording the previous state for undo. */
  const commit = (update: (state: CutterStore) => Partial<Snapshot> | null) =>
    set((state) => {
      const patch = update(state);
      if (!patch) {
        return state;
      }
      return {
        ...patch,
        past: [...state.past, { cuts: state.cuts, transcript: state.transcript }].slice(-HISTORY_LIMIT),
        future: [],
      };
    });

  return {
    videoPath: '',
    transcript: null,
    cuts: {},
    past: [],
    future: [],
    loadVideo: (videoPath) => set({ videoPath, transcript: null, cuts: {}, past: [], future: [] }),
    setTranscript: (transcript) => set({ transcript, cuts: {}, past: [], future: [] }),
    toggleCuts: (ids, source = 'user') =>
      commit((state) => {
        if (ids.length === 0) {
          return null;
        }
        const cuts = { ...state.cuts };
        const restore = ids.every((id) => cuts[id]);
        ids.forEach((id) => {
          if (restore) {
            delete cuts[id];
          } else {
            cuts[id] = cuts[id] ?? source;
          }
        });
        return { cuts };
      }),
    cutUnits: (ids, source) =>
      commit((state) => {
        const fresh = ids.filter((id) => !state.cuts[id]);
        if (fresh.length === 0) {
          return null;
        }
        const cuts = { ...state.cuts };
        fresh.forEach((id) => (cuts[id] = source));
        return { cuts };
      }),
    restoreUnits: (ids) =>
      commit((state) => {
        const present = ids.filter((id) => state.cuts[id]);
        if (present.length === 0) {
          return null;
        }
        const cuts = { ...state.cuts };
        present.forEach((id) => delete cuts[id]);
        return { cuts };
      }),
    revertAi: () =>
      commit((state) => {
        const entries = Object.entries(state.cuts);
        if (!entries.some(([, source]) => source === 'ai')) {
          return null;
        }
        return { cuts: Object.fromEntries(entries.filter(([, source]) => source !== 'ai')) };
      }),
    editSegmentText: (segmentId, text) =>
      commit((state) => {
        const transcript = state.transcript;
        const segment = transcript?.segments.find((item) => item.id === segmentId);
        if (!transcript || !segment || segment.text === text) {
          return null;
        }
        const words = retimeWords(segment, text);
        const cuts = { ...state.cuts };
        // Re-timed words get new ids; drop cuts that pointed at the old ones.
        segment.words?.forEach((word) => delete cuts[word.id]);
        return {
          cuts,
          transcript: {
            ...transcript,
            segments: transcript.segments.map((item) => (item.id === segmentId ? { ...item, text, ...(words ? { words } : {}) } : item)),
          },
        };
      }),
    undo: () =>
      set((state) => {
        const previous = state.past[state.past.length - 1];
        if (!previous) {
          return state;
        }
        return {
          ...previous,
          past: state.past.slice(0, -1),
          future: [{ cuts: state.cuts, transcript: state.transcript }, ...state.future],
        };
      }),
    redo: () =>
      set((state) => {
        const [next, ...future] = state.future;
        if (!next) {
          return state;
        }
        return {
          ...next,
          past: [...state.past, { cuts: state.cuts, transcript: state.transcript }],
          future,
        };
      }),
  };
});
