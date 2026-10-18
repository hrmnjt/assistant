import type { Extension } from '@earendil-works/pi-durable';
import type { z } from 'zod';
import type { Row, Store } from './database.js';
import type { AssistantKit } from './assistant-tools.js';
import type { Household } from './household.js';
import type { Notices } from './notices.js';
import type { ConfirmationResult, Person, Preview, Snapshot } from '../src/types.js';

/** Previews and applies the change kinds one plugin owns. Nothing applies without a confirmation. */
export interface ChangeOwner {
  readonly kinds: readonly string[];
  /** Accepted input, shared by the app's requests and the assistant's prepare tool. */
  readonly schema: z.ZodType;
  preview(actorId: string, input: unknown): Promise<Preview>;
  confirm(actorId: string, previewId: string): Promise<ConfirmationResult>;
  cancel(actorId: string, previewId: string): Promise<void>;
  /** Only for changes whose outcome can be uncertain, such as remote writes. */
  dismiss?(actorId: string, previewId: string): Promise<void>;
}

/** A plugin's part of the app snapshot; integration statuses merge with the others'. */
export type SnapshotPart = Partial<Omit<Snapshot, 'integrations'>> & {
  integrations?: Partial<Snapshot['integrations']>;
};

/**
 * Whether a pending notice should still be pushed, only kept in Updates, or
 * retried later for a named reason (a dependency is unavailable).
 */
export type NoticeStatus = 'send' | 'inbox' | { defer: string };

export type ApiRoute = {
  method: string;
  path: RegExp;
  handle(request: Request, me: Person, params: string[]): Promise<Response>;
};

/**
 * A feature of the household assistant. The conversation is the core; tasks,
 * the shared calendar, the dashboard and later features are plugins. Each one
 * brings its own Pi extension (the assistant's tools and instructions), the
 * changes it owns, its part of the app's data, and its background work.
 */
export interface Plugin {
  readonly id: string;
  /** The assistant's tools and instructions for this feature. */
  readonly extension?: Extension;
  readonly changes?: ChangeOwner;
  /** This feature's part of the app snapshot. */
  snapshot?(me: Person): Promise<SnapshotPart>;
  /** Background work on the household's single schedule: refreshes and planned notices. */
  tick?(now: Date): Promise<void>;
  /** When this feature next has background work, if ever. */
  nextWake?(now: Date): Promise<number | null>;
  /** Notices this feature plans (by id prefix), and whether a pending one still applies. */
  readonly notices?: {
    readonly prefixes: readonly string[];
    status(notice: Row): Promise<NoticeStatus>;
  };
  readonly routes?: readonly ApiRoute[];
}

/** What the core gives each plugin. */
export type PluginHost = {
  db: Store;
  clock: () => Date;
  household: Household;
  notices: Notices;
  assistant: AssistantKit;
};
