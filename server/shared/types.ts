// Shared between the Worker, the device page and the Mac editor.

export type WidgetType =
  | 'clock' | 'weather' | 'agents' | 'quotas' | 'calendar' | 'tasks' | 'memo'
  | 'markets' | 'deadlines' | 'github' | 'text' | 'nav' | 'status' | 'focus' | 'header' | 'stat' | 'ai' | 'plan' | 'mail' | 'inbox' | 'doing' | 'money';

export interface Widget {
  id: string;
  type: WidgetType;
  x: number; y: number; w: number; h: number;   // grid units
  props: Record<string, any>;
  title?: string;        // optional label override
  hideTitle?: boolean;
}

export interface Page { id: string; name: string; widgets: Widget[] }

export interface DeviceSettings {
  pollSec: number;          // normal polling interval
  activePollSec: number;    // when an agent is running / waiting
  fullRefreshMin: number;   // periodic full e-ink refresh, 0 = off
  partialLimit: number;     // driver auto-full after N partial updates, 0 = driver default
  returnHomeSec: number;    // go back to page 1 after inactivity, 0 = never
  brightness: number;       // front light 0-255, -1 = leave alone
  timezone: string;
  night: { enabled: boolean; start: string; end: string };  // "HH:MM"
  light: LightSettings;
  contrast: number;         // stock e-ink contrast level 0-5, -1 = leave alone
  battery: { care: boolean; upper: number; lower: number };  // keep the battery between lower..upper % while plugged in
}

export interface LightWindow { from: string; to: string; brightness: number; warmth: number }
export interface LightSettings {
  mode: 'system' | 'off' | 'fixed' | 'schedule';
  brightness: number;       // 0-100
  warmth: number;           // 0-100
  schedule: LightWindow[];  // used when mode = schedule; outside every window the light is off
}

export type Orientation = 'landscape' | 'reverseLandscape' | 'portrait' | 'reversePortrait';

/** Who uses this board. Fills the AI prompts and the shared ledger. */
export interface Profile {
  about: string;     // one or two sentences the assistant should know about you
  city: string;      // shown to the AI, e.g. "上海"
  currency: string;  // base currency of the ledger (ISO code, e.g. CNY)
  me: string;        // your name on the ledger
  partner: string;   // the other person on the ledger
}

export interface Layout {
  version: number;
  updatedAt: string;
  orientation: Orientation;
  grid: { cols: number; rows: number; gap: number; padding: number };
  theme: { fontScale: number; titleStyle: 'tab' | 'rule' | 'plain'; clockWeight: number; cards: boolean; displayFont: 'smiley' | 'inter' };
  location?: { lat: number; lon: number; name: string; accuracy?: number; updatedAt?: string };
  device: DeviceSettings;
  profile: Profile;
  pages: Page[];
}

export interface Task { id: string; title: string; notes?: string; due?: string | null; done: boolean; source: 'local' | 'google'; list?: string; sort: number; updatedAt: string }
export interface Memo { id: string; body: string; pinned: boolean; updatedAt: string }

export type AgentState = 'running' | 'waiting' | 'idle' | 'done' | 'stale';
export interface AgentSession {
  id: string; tool: 'claude' | 'codex' | 'dsh'; host: string; project: string; branch?: string;
  title?: string; state: AgentState; step?: string; message?: string;
  toolCalls: number; turnStartedAt?: string; startedAt: string; updatedAt: string; lastTurnSec?: number;
}

export interface QuotaWindow { name: string; label: string; usedPct: number | null; used?: number | null; limit?: number | null; resetsAt?: string | null; pace?: { willLast?: boolean; etaSec?: number; expectedPct?: number } }
export interface QuotaProvider { provider: string; label: string; plan?: string; windows: QuotaWindow[]; credits?: string | null; balance?: string; today?: string; capturedAt: string; error?: string }
export interface Balance { id: string; label: string; value: string; sub?: string; capturedAt: string; error?: string }

export interface DeviceCommand { id: string; cmd: 'reload' | 'fullRefresh' | 'launch' | 'menu' | 'update' | 'reboot' | 'page' | 'focus'; arg?: string; ts: string }

export interface DeviceStatus {
  battery?: number; charging?: boolean; ssid?: string; rssi?: number; wifiLevel?: number; app?: string; webview?: string;
  einkApi?: boolean; timezone?: string; uptimeMin?: number; heapMb?: number; page?: string; seenAt?: string;
}

export interface StatePayload {
  serverTime: string;
  layout: Layout;
  data: Record<string, any>;           // keyed by widget id
  agentsActive: boolean;
  commands: DeviceCommand[];
  device?: DeviceStatus;
}

export interface UsageDay { date: string; tokens: number; cost: number }
export interface UsageProvider { provider: string; label: string; today: UsageDay | null; daily: UsageDay[]; last30Tokens: number; last30Cost: number; capturedAt: string }
