export type Category = 'household' | 'work' | 'personal';
export type Person = { id: string; name: string; username: string };
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
export type SummarySetting = { enabled: boolean; time: string };
export type Preferences = {
  timezone: string;
  morning: SummarySetting;
  evening: SummarySetting;
  revision: number;
};
export type Thread = { id: string; title: string; category: Category; createdAt: string };
export type Message = {
  id: string;
  threadId: string;
  authorId: string;
  text: string;
  createdAt: string;
};
export type Presence = { userId: string; threadId: string; typing: boolean };
export type Notice = { id: string; title: string; body: string; createdAt: string };
export type Mutation =
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
export type Preview = {
  id: string;
  title: string;
  details: { label: string; before?: string; after: string }[];
  expiresAt: string;
};
export type Snapshot = {
  me: Person;
  people: Person[];
  tasks: Task[];
  preferences: Preferences;
  threads: Thread[];
  presence: Presence[];
  notices: Notice[];
  integrations: { calendar: 'not-connected'; ai: 'not-connected' };
};
