/**
 * Lightweight app store — React context over useState (no redux). Owns the
 * API client, WS subscription, cached responses, toasts, and the client-local
 * story progress (persisted per profile in localStorage until the service
 * exposes story progress writes — see SPEC-7).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createClient, type ApiClient, ApiError } from "./api/client";
import { useServiceSocket, type WsStatus } from "./api/ws";
import type {
  AcquisitionPlan,
  ForesightWarning,
  GoalsResponse,
  HealthResponse,
  PlanResponse,
  PositionPayload,
  SourceStatusRow,
  StateResponse,
  StoryResponse,
} from "./api/types";
import {
  normalizePlanResponse,
  normalizeStoryResponse,
  readPlayerState,
  readSourceStatusRow,
  type NormalizedPlayerState,
} from "./lib/normalize";
import type { DecisionsMade, StageProgress } from "./lib/story";

// ---------- toasts ----------

export interface Toast {
  id: number;
  kind: "info" | "warning" | "error";
  title?: string;
  message: string;
}

// ---------- raid banner ----------

export interface RaidBanner {
  kind: "started" | "ended";
  map?: string;
  outcome?: string;
  at: number;
}

// ---------- localStorage helpers (guarded — never crash on privacy modes) ----------

function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveLocal(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable — story progress just won't persist
  }
}

// ---------- context shape ----------

export interface AppStore {
  api: ApiClient;
  wsStatus: WsStatus;
  health: HealthResponse | null;
  profileKey: string;

  player: NormalizedPlayerState;
  stateRaw: StateResponse | null;
  plan: PlanResponse | null;
  planFetchedAt: number | null;
  planStale: boolean;
  quartermaster: AcquisitionPlan | null;
  story: StoryResponse | null;
  goals: GoalsResponse | null;
  foresight: ForesightWarning[];
  positions: PositionPayload[];
  raidBanner: RaidBanner | null;
  /** Live per-source status pushed over WS (§5.7); merged over the fetched rows by the Sources view. */
  liveSourceStatus: Record<string, SourceStatusRow>;

  horizon: number;
  setHorizon(h: number): void;

  toasts: Toast[];
  pushToast(kind: Toast["kind"], message: string, title?: string): void;
  dismissToast(id: number): void;

  refreshState(): Promise<void>;
  refreshPlan(): Promise<void>;
  refreshStory(): Promise<void>;
  refreshGoals(): Promise<void>;
  refreshAll(): Promise<void>;

  // story progress (client-local, merged with server playerStatus)
  storyProgress: StageProgress;
  storyDecisions: DecisionsMade;
  setStageDone(stageId: string, done: boolean): void;
  setDecision(decisionId: string, optionId: string): void;
  resetStory(): void;

  onboardingOpen: boolean;
  setOnboardingOpen(open: boolean): void;
}

const Ctx = createContext<AppStore | null>(null);

export function useApp(): AppStore {
  const store = useContext(Ctx);
  if (!store) throw new Error("useApp outside AppProvider");
  return store;
}

let toastSeq = 1;

export function AppProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const lastToastRef = useRef<{ message: string; at: number }>({ message: "", at: 0 });

  const pushToast = useCallback((kind: Toast["kind"], message: string, title?: string) => {
    // dedupe identical messages within 5s (reconnect storms, repeated fetch errors)
    const now = Date.now();
    if (lastToastRef.current.message === message && now - lastToastRef.current.at < 5000) return;
    lastToastRef.current = { message, at: now };
    const id = toastSeq++;
    setToasts((t) => [...t.slice(-4), { id, kind, message, ...(title ? { title } : {}) }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 8000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const api = useMemo(
    () =>
      createClient({
        onError: (err: ApiError) => {
          // 409 (game running) is handled inline by the Environment view
          if (!err.isConflict) pushToast("error", err.message);
        },
      }),
    [pushToast],
  );

  // ---------- cached responses ----------

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [stateRaw, setStateRaw] = useState<StateResponse | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [planFetchedAt, setPlanFetchedAt] = useState<number | null>(null);
  const [planStale, setPlanStale] = useState(false);
  const [quartermaster, setQuartermaster] = useState<AcquisitionPlan | null>(null);
  const [story, setStory] = useState<StoryResponse | null>(null);
  const [goals, setGoals] = useState<GoalsResponse | null>(null);
  const [foresight, setForesight] = useState<ForesightWarning[]>([]);
  const [positions, setPositions] = useState<PositionPayload[]>([]);
  const [raidBanner, setRaidBanner] = useState<RaidBanner | null>(null);
  const [liveSourceStatus, setLiveSourceStatus] = useState<Record<string, SourceStatusRow>>({});
  const [onboardingOpen, setOnboardingOpen] = useState(false);

  const [horizon, setHorizonState] = useState<number>(() => loadLocal("tac-horizon", 5));
  const setHorizon = useCallback((h: number) => {
    const clamped = Math.max(1, Math.min(20, Math.round(h)));
    setHorizonState(clamped);
    saveLocal("tac-horizon", clamped);
  }, []);

  const player = useMemo(() => readPlayerState(stateRaw), [stateRaw]);
  const profileKey = health?.profileKey ?? "";

  // ---------- fetchers (each degrades independently) ----------

  const refreshState = useCallback(async () => {
    try {
      setStateRaw(await api.get<StateResponse>("/api/state"));
    } catch {
      /* toast already pushed by client */
    }
  }, [api]);

  const refreshPlan = useCallback(async () => {
    try {
      const [planRes, qmRes] = await Promise.all([
        api.get<unknown>("/api/plan", { horizon }),
        api.get<AcquisitionPlan>("/api/quartermaster", { raids: horizon }),
      ]);
      setPlan(normalizePlanResponse(planRes));
      setQuartermaster(qmRes);
      setPlanFetchedAt(Date.now());
      setPlanStale(false);
    } catch {
      /* keep the last good plan on screen */
    }
  }, [api, horizon]);

  const refreshStory = useCallback(async () => {
    try {
      setStory(normalizeStoryResponse(await api.get<unknown>("/api/story")));
    } catch {
      /* story view shows its empty state */
    }
  }, [api]);

  const refreshGoals = useCallback(async () => {
    try {
      setGoals(await api.get<GoalsResponse>("/api/goals"));
    } catch {
      /* goals view shows defaults */
    }
    try {
      const res = await api.get<ForesightWarning[] | { warnings: ForesightWarning[] }>("/api/foresight");
      setForesight(Array.isArray(res) ? res : (res?.warnings ?? []));
    } catch {
      /* optional payload */
    }
  }, [api]);

  const refreshAll = useCallback(async () => {
    try {
      setHealth(await api.get<HealthResponse>("/api/health"));
    } catch {
      /* status bar shows offline */
    }
    await Promise.all([refreshState(), refreshPlan(), refreshStory(), refreshGoals()]);
  }, [api, refreshState, refreshPlan, refreshStory, refreshGoals]);

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // refetch plan when horizon changes (after initial load)
  const firstHorizon = useRef(true);
  useEffect(() => {
    if (firstHorizon.current) {
      firstHorizon.current = false;
      return;
    }
    void refreshPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horizon]);

  // onboarding trigger: untouched profile
  useEffect(() => {
    if (stateRaw !== null && player.empty && !loadLocal("tac-onboarding-dismissed", false)) {
      setOnboardingOpen(true);
    }
  }, [stateRaw, player.empty]);

  // ---------- WS ----------

  const wsStatus = useServiceSocket({
    onPlanUpdated: () => {
      void refreshPlan();
    },
    onRaid: (kind, payload) => {
      if (kind === "started") {
        setRaidBanner({ kind: "started", at: Date.now(), ...(payload.map ? { map: payload.map } : {}) });
      } else if (kind === "ended") {
        setRaidBanner({
          kind: "ended",
          at: Date.now(),
          ...(payload.map ? { map: payload.map } : {}),
          ...(payload.outcome ? { outcome: payload.outcome } : {}),
        });
        setPlanStale(true); // until plan.updated arrives
        void refreshState();
      }
    },
    onQuestChanged: () => {
      void refreshState();
    },
    onStateChanged: () => {
      void refreshState();
    },
    onPosition: (payload) => {
      setPositions((prev) => [payload, ...prev].slice(0, 100));
    },
    onNotice: (payload) => {
      const msg = payload.message ?? "";
      if (msg) pushToast(payload.level ?? "info", msg, payload.title);
    },
    onPatchDetected: (payload) => {
      pushToast("warning", `New game version detected${payload.version ? `: ${payload.version}` : ""} — snapshot refresh needed.`, "Patch detected");
    },
    onSourceStatus: (payload) => {
      const row = readSourceStatusRow(payload);
      if (row) setLiveSourceStatus((prev) => ({ ...prev, [row.id]: row }));
    },
  });

  // ---------- client-local story progress ----------

  const storageKey = (name: string): string => `tac-story-${name}:${profileKey || "default"}`;
  const [storyProgressLocal, setStoryProgressLocal] = useState<StageProgress>({});
  const [storyDecisionsLocal, setStoryDecisionsLocal] = useState<DecisionsMade>({});

  // reload persisted progress when the profile becomes known/changes
  useEffect(() => {
    setStoryProgressLocal(loadLocal<StageProgress>(storageKey("progress"), {}));
    setStoryDecisionsLocal(loadLocal<DecisionsMade>(storageKey("decisions"), {}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileKey]);

  const setStageDone = useCallback(
    (stageId: string, done: boolean) => {
      setStoryProgressLocal((prev) => {
        const next = { ...prev, [stageId]: done };
        saveLocal(storageKey("progress"), next);
        return next;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profileKey],
  );

  const setDecision = useCallback(
    (decisionId: string, optionId: string) => {
      setStoryDecisionsLocal((prev) => {
        const next = { ...prev, [decisionId]: optionId };
        saveLocal(storageKey("decisions"), next);
        return next;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profileKey],
  );

  const resetStory = useCallback(() => {
    setStoryProgressLocal({});
    setStoryDecisionsLocal({});
    saveLocal(storageKey("progress"), {});
    saveLocal(storageKey("decisions"), {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileKey]);

  // server playerStatus (when provided) merges over local
  const storyProgress = useMemo(
    () => ({ ...storyProgressLocal, ...(story?.playerStatus?.stages ?? {}) }),
    [storyProgressLocal, story],
  );
  const storyDecisions = useMemo(
    () => ({ ...storyDecisionsLocal, ...(story?.playerStatus?.decisions ?? {}) }),
    [storyDecisionsLocal, story],
  );

  const setOnboarding = useCallback((open: boolean) => {
    setOnboardingOpen(open);
    if (!open) saveLocal("tac-onboarding-dismissed", true);
  }, []);

  const store: AppStore = {
    api,
    wsStatus,
    health,
    profileKey,
    player,
    stateRaw,
    plan,
    planFetchedAt,
    planStale,
    quartermaster,
    story,
    goals,
    foresight,
    positions,
    raidBanner,
    liveSourceStatus,
    horizon,
    setHorizon,
    toasts,
    pushToast,
    dismissToast,
    refreshState,
    refreshPlan,
    refreshStory,
    refreshGoals,
    refreshAll,
    storyProgress,
    storyDecisions,
    setStageDone,
    setDecision,
    resetStory,
    onboardingOpen,
    setOnboardingOpen: setOnboarding,
  };

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
