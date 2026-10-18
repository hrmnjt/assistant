export type Category = 'household' | 'work' | 'personal';
/** One of the two people; `username` is the email they sign in with (or their id in development). */
export type Person = { id: string; name: string; username: string };
/** Before the household is set up: who signed in (no one, in development). */
export type SetupNeeded = { email: string | null; development: boolean };
export type Schedule = { frequency: 'daily' | 'weekly'; timezone: string };
export type Task = {
  id: string;
  title: string;
  notes: string;
  category: Category;
  ownerId: string;
  dueAt: string | null;
  schedule: Schedule | null;
  status: 'open' | 'completed';
  revision: number;
  completedBy: string | null;
  completedAt: string | null;
  missedDates: string[];
};
export type TaskOccurrence = {
  dueAt: string | null;
  outcome: 'completed' | 'missed';
  completedBy: string | null;
  /** Null for misses and for completions recorded before completion times were stored. */
  completedAt: string | null;
};
export type SummarySetting = { enabled: boolean; time: string };
export type Preferences = {
  timezone: string;
  morning: SummarySetting;
  evening: SummarySetting;
  revision: number;
};
export type Thread = {
  id: string;
  title: string;
  category: Category;
  createdAt: string;
  assistantFor?: string | null;
};
export type Message = {
  id: string;
  threadId: string;
  authorId: string;
  text: string;
  createdAt: string;
};
export type Presence = { userId: string; threadId: string; typing: boolean };
export type Notice = {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  readAt?: string | null;
  targetKind?: 'task' | 'calendar' | null;
  targetId?: string | null;
};
export type HouseholdMutation =
  | {
      kind: 'task.create';
      task: {
        title: string;
        notes: string;
        category: Category;
        ownerId: string;
        dueAt: string | null;
        schedule: Schedule | null;
      };
    }
  | {
      kind: 'task.update';
      id: string;
      revision: number;
      task: {
        title: string;
        notes: string;
        category: Category;
        ownerId: string;
        dueAt: string | null;
        schedule: Schedule | null;
      };
    }
  | { kind: 'task.complete'; id: string; revision: number }
  | { kind: 'task.delete'; id: string; revision: number }
  | { kind: 'preferences.update'; revision: number; preferences: Omit<Preferences, 'revision'> }
  | { kind: 'thread.create'; title: string; category: Category };
export type CalendarFields = {
  title: string;
  notes: string;
  location: string;
  start: string;
  end: string;
  allDay: boolean;
  reminderMinutes: number | null;
};
export type CalendarEvent = CalendarFields & {
  id: string;
  uid: string;
  etag: string;
  recurring: boolean;
  readOnlyReason: string | null;
};
export type CalendarSnapshot = {
  status: 'not-connected' | 'connected' | 'error';
  name: string;
  syncedAt: string | null;
  error: string | null;
  events: CalendarEvent[];
  months?: { first: string; last: string };
};
export type CalendarMutation =
  | { kind: 'calendar.create'; event: CalendarFields }
  | { kind: 'calendar.update'; id: string; etag: string; event: CalendarFields }
  | { kind: 'calendar.delete'; id: string; etag: string };
export type Mutation = HouseholdMutation | CalendarMutation;
export type CalendarOutcome = {
  status: 'applied' | 'conflicted' | 'failed' | 'unknown';
  message: string;
};
export type ConfirmationResult = {
  ok: boolean;
  targetId: string;
  calendarOutcome?: CalendarOutcome;
  dismissedAt?: string;
};
export type Preview = {
  calendarOutcome?: CalendarOutcome;
  id: string;
  title: string;
  details: { label: string; before?: string; after: string }[];
  expiresAt: string;
};
export type ChatStatus = {
  running: boolean;
  error: string | null;
  previews: { actorId: string; preview: Preview }[];
  queued?: number;
};
export type Snapshot = {
  me: Person;
  /** Cloudflare Access signs people in to a deployment; a development server has no sign-in. */
  signIn: 'cloudflare-access' | 'development';
  people: Person[];
  tasks: Task[];
  previews: Preview[];
  preferences: Preferences;
  threads: Thread[];
  presence: Presence[];
  notices: Notice[];
  integrations: {
    calendar: CalendarSnapshot['status'];
    /** `needs-model`: ChatGPT is connected and whoever set up still chooses a model. */
    ai: 'not-connected' | 'needs-model' | 'configured';
  };
  calendar: CalendarSnapshot;
  /** For whoever set up the household: the Apple ID the calendar connection uses. */
  calendarAccount?: string;
};
