import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DateTime } from 'luxon';
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronRight,
  Circle,
  ClipboardList,
  Home,
  Leaf,
  LogOut,
  MessageCircle,
  Menu,
  Hash,
  MoreHorizontal,
  Plus,
  Repeat2,
  Send,
  Settings,
  Sun,
  SunMoon,
  Sunset,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type {
  CalendarEvent,
  CalendarOutcome,
  ConfirmationResult,
  ChatStatus,
  Category,
  Message,
  Mutation,
  Preferences,
  Preview,
  Snapshot,
  Task,
  TaskOccurrence,
} from './types';
import { CalendarCard, CalendarView, EventForm } from './Calendar';
import { mentionsAssistant } from './mentions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/native-select';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Modal,
  Disclosure,
  ConfirmationDetails,
  rememberOverlayOpener,
  TaskCollection,
} from '@/components/app-patterns';
import { followSystemAppearance, saveAppearance, savedAppearance, type Appearance } from './theme';
import './styles.css';

async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    method,
    credentials: 'same-origin',
    // Cloudflare Access redirects requests to its sign-in page once a sign-in ends.
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'X-Household-Client': '1' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.type === 'opaqueredirect')
    throw Object.assign(new Error('Your sign-in has ended. Sign in again to continue.'), {
      status: 401,
    });
  // An error can come from Cloudflare rather than the app, without a JSON body.
  const value = response.ok ? await response.json() : await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(
      new Error(
        value.error ||
          (response.status === 401
            ? 'Your sign-in has ended. Sign in again to continue.'
            : 'Unable to reach the assistant.'),
      ),
      {
        status: response.status,
        calendarOutcome: value.calendarOutcome,
      },
    );
  return value;
}

function App() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(true);
  const [signedOut, setSignedOut] = useState({
    status: 0,
    message: 'The assistant can’t be reached right now. Try again in a moment.',
  });
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<'today' | 'tasks' | 'calendar' | 'chat' | 'settings'>('chat');
  const [filter, setFilter] = useState<'mine' | 'household' | 'all'>('mine');
  const [taskForm, setTaskForm] = useState<Task | 'new' | null>(null);
  const [eventForm, setEventForm] = useState<CalendarEvent | 'new' | null>(null);
  const [threadForm, setThreadForm] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [showNotices, setShowNotices] = useState(
    new URLSearchParams(location.search).has('updates'),
  );
  const [askChannelAssistant, setAskChannelAssistant] = useState(false);
  const [eventDate, setEventDate] = useState<string | undefined>();
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const messagesPanel = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const followMessages = useRef(true);
  const activeLogin = useRef<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  // Set when the open editor's record changed underneath it; edits are kept.
  const [editorNotice, setEditorNotice] = useState<{ text: string; gone: boolean } | null>(null);
  const [editorVersion, setEditorVersion] = useState(0);
  const editing = useRef<{ task: Task | null; event: CalendarEvent | null }>({
    task: null,
    event: null,
  });
  editing.current = {
    task: taskForm && taskForm !== 'new' ? taskForm : null,
    event: eventForm && eventForm !== 'new' ? eventForm : null,
  };
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewRetryable, setPreviewRetryable] = useState(true);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatStatus, setChatStatus] = useState<ChatStatus>({
    running: false,
    error: null,
    previews: [],
  });
  const [draft, setDraft] = useState('');
  const [planNotice, setPlanNotice] = useState(false);
  const lastTyping = useRef(0);
  const clientId = useRef(crypto.randomUUID());
  const draftValue = useRef(draft);
  draftValue.current = draft;
  // The last submitted text keeps its request ID, so retrying after a lost
  // response cannot duplicate it; newer typing never changes that identity.
  const messageRequest = useRef<{ requestId: string; threadId: string; text: string } | null>(null);
  const visibleThread = useRef<string | null>(null);
  visibleThread.current = threadId;
  useEffect(() => {
    const openUpdates = (event: MessageEvent) => {
      if (event.data?.type === 'open-updates') setShowNotices(true);
    };
    navigator.serviceWorker?.addEventListener('message', openUpdates);
    return () => navigator.serviceWorker?.removeEventListener('message', openUpdates);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const value = await api<Snapshot>('/state');
      setState(value);
      setConnected(true);
    } catch (problem) {
      const status = (problem as { status?: number }).status;
      if (status === 401 || status === 403) {
        setState(null);
        setSignedOut({ status, message: (problem as Error).message });
      } else {
        setConnected(false);
        // Before the first load, say why: a missing Worker variable, say.
        if (status === 503) setSignedOut({ status, message: (problem as Error).message });
      }
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!state?.me.id) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [state?.me.id, refresh]);
  useEffect(() => {
    if (state?.integrations.ai !== 'configured') return;
    try {
      setPlanNotice(!localStorage.getItem(`chatgpt-plan-notice:${state.me.id}`));
    } catch {
      setPlanNotice(true);
    }
  }, [state?.me.id, state?.integrations.ai]);
  useEffect(() => {
    if (!state) {
      activeLogin.current = null;
      setPreview(null);
      setRecoveryOpen(false);
      setTaskForm(null);
      setEventForm(null);
      setThreadForm(false);
      return;
    }
    if (activeLogin.current !== state.me.id) {
      activeLogin.current = state.me.id;
      setPreview(null);
      setRecoveryOpen(state.previews.length > 0);
      setPreviewError('');
      setBusy(false);
      setPage('chat');
      setThreadId(state.threads.find((thread) => thread.assistantFor === state.me.id)?.id ?? null);
      setChannelsOpen(false);
      setActivityOpen(false);
    }
    setThreadId((current) =>
      state.threads.some(
        (thread) =>
          thread.id === current && (!thread.assistantFor || thread.assistantFor === state.me.id),
      )
        ? current
        : (state.threads.find((thread) => thread.assistantFor === state.me.id)?.id ?? null),
    );
  }, [state?.me.id, state?.threads]);
  useEffect(() => {
    const resize = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${height}px`);
      setKeyboardOpen(window.innerHeight - height > 150);
    };
    resize();
    window.visualViewport?.addEventListener('resize', resize);
    window.addEventListener('resize', resize);
    return () => {
      window.visualViewport?.removeEventListener('resize', resize);
      window.removeEventListener('resize', resize);
    };
  }, []);
  useEffect(() => {
    if (!state || !showNotices) return;
    const ids = state.notices.filter((notice) => !notice.readAt).map((notice) => notice.id);
    if (ids.length)
      void api('/notices/read', { ids })
        .then(() => refresh())
        .catch(() => undefined);
  }, [showNotices, state?.notices, refresh]);
  useEffect(() => {
    if (followMessages.current && messagesPanel.current)
      messagesPanel.current.scrollTop = messagesPanel.current.scrollHeight;
  }, [messages, chatStatus.previews, threadId]);
  const editorTarget =
    (taskForm && (taskForm === 'new' ? 'new-task' : taskForm.id)) ||
    (eventForm && (eventForm === 'new' ? 'new-event' : eventForm.id)) ||
    null;
  useEffect(() => setEditorNotice(null), [editorTarget]);
  const reviewPreview = (proposal: Preview) => {
    setRecoveryOpen(false);
    setTaskForm(null);
    setEventForm(null);
    setThreadForm(false);
    setPreviewError('');
    setPreviewRetryable(!proposal.calendarOutcome || proposal.calendarOutcome.status === 'unknown');
    setPreview(proposal);
  };
  /**
   * After a stale-version conflict, load the authoritative record into the open
   * editor. Its inputs keep the person's edits, and the next review compares
   * them with the latest saved version using its current revision or ETag.
   * Returns whether the editor now explains the change.
   */
  const reloadEditor = useCallback(async () => {
    const { task, event } = editing.current;
    if (!task && !event) return false;
    const actorId = activeLogin.current;
    try {
      if (event) await api('/calendar/refresh', {});
      const value = await api<Snapshot>('/state');
      if (activeLogin.current !== actorId) return false;
      setState(value);
      const latest = task
        ? value.tasks.find((item) => item.id === task.id)
        : value.calendar.events.find((item) => item.id === event!.id);
      // Other errors, such as an unavailable preview, leave an unchanged record alone.
      if (
        latest &&
        (task
          ? (latest as Task).revision === task.revision
          : (latest as CalendarEvent).etag === event!.etag)
      )
        return false;
      const label = task ? 'task' : 'appointment';
      if (latest && task) setTaskForm(latest as Task);
      else if (latest) setEventForm(latest as CalendarEvent);
      setEditorNotice(
        latest
          ? {
              gone: false,
              text: `This ${label} changed while you were editing. Your edits are still here; review again to compare them with the latest version.`,
            }
          : {
              gone: true,
              text: `This ${label} was deleted while you were editing, so these edits cannot be saved.`,
            },
      );
      return true;
    } catch {
      // The conflict message stays the guidance.
      return false;
    }
  }, []);
  const act = useCallback(
    async (mutation: Mutation) => {
      const actorId = activeLogin.current;
      setBusy(true);
      setError('');
      setPreviewError('');
      setPreviewRetryable(true);
      try {
        const proposal = await api<Preview>('/previews', mutation);
        if (activeLogin.current === actorId) setPreview(proposal);
      } catch (problem) {
        if (activeLogin.current !== actorId) return;
        // A conflict on the open editor's record is explained inside the editor.
        const handled =
          [404, 409].includes((problem as { status?: number }).status ?? 0) &&
          'id' in mutation &&
          [editing.current.task?.id, editing.current.event?.id].includes(mutation.id) &&
          (await reloadEditor());
        if (!handled && activeLogin.current === actorId) setError((problem as Error).message);
      } finally {
        if (activeLogin.current === actorId) setBusy(false);
      }
    },
    [reloadEditor],
  );
  const cancelPreview = useCallback(() => {
    if (busy || !preview) return;
    const actorId = activeLogin.current;
    setBusy(true);
    void api(`/previews/${preview.id}`, undefined, 'DELETE')
      .then(() => {
        if (activeLogin.current !== actorId) return;
        setPreview(null);
        setPreviewError('');
        void refresh();
      })
      .catch((problem) => {
        if (activeLogin.current !== actorId) return;
        const outcome = (problem as { calendarOutcome?: CalendarOutcome }).calendarOutcome;
        if (outcome) setPreview({ ...preview, calendarOutcome: outcome });
        setPreviewError(outcome ? '' : (problem as Error).message);
        setPreviewRetryable(!outcome || outcome.status === 'unknown');
      })
      .finally(() => {
        if (activeLogin.current === actorId) setBusy(false);
      });
  }, [preview, busy, refresh]);
  async function dismissPreview() {
    if (!preview || busy) return;
    const actorId = activeLogin.current;
    setBusy(true);
    try {
      await api(`/previews/${preview.id}/dismiss`, { acknowledgeUncertain: true });
      if (activeLogin.current !== actorId) return;
      setPreview(null);
      setPreviewError('');
      await refresh();
    } catch (problem) {
      if (activeLogin.current === actorId) setPreviewError((problem as Error).message);
    } finally {
      if (activeLogin.current === actorId) setBusy(false);
    }
  }
  async function confirm() {
    if (!preview) return;
    const actorId = activeLogin.current;
    setBusy(true);
    setPreviewError('');
    try {
      const result = await api<ConfirmationResult>(`/previews/${preview.id}/confirm`, {});
      if (activeLogin.current !== actorId) return;
      if (!result.ok && result.calendarOutcome) {
        setPreview({ ...preview, calendarOutcome: result.calendarOutcome });
        setPreviewRetryable(result.calendarOutcome.status === 'unknown');
        if (result.calendarOutcome.status === 'conflicted') await reloadEditor();
        else await refresh();
        return;
      }
      if (threadForm) setThreadId(result.targetId);
      setPreview(null);
      setTaskForm(null);
      setEventForm(null);
      setThreadForm(false);
      await refresh();
    } catch (problem) {
      if (activeLogin.current !== actorId) return;
      const outcome = (problem as { calendarOutcome?: CalendarOutcome }).calendarOutcome;
      if (outcome) setPreview({ ...preview, calendarOutcome: outcome });
      setPreviewError(outcome ? '' : (problem as Error).message);
      setPreviewRetryable(
        outcome
          ? outcome.status === 'unknown'
          : ((problem as { status?: number }).status ?? 500) >= 500,
      );
      // A preview reviewed from an open editor belongs to that editor's record.
      if (
        outcome
          ? outcome.status === 'conflicted'
          : [404, 409].includes((problem as { status?: number }).status ?? 0)
      )
        await reloadEditor();
    } finally {
      if (activeLogin.current === actorId) setBusy(false);
    }
  }
  useEffect(() => {
    if (!state?.me.id) return;
    const active = page === 'chat' ? threadId : null;
    // Keepalive lets the "left" update finish when the page is hidden or unloads.
    const beat = () =>
      void api(
        '/presence',
        {
          threadId: document.hidden ? null : active,
          clientId: clientId.current,
          typing: Boolean(draftValue.current) && Date.now() - lastTyping.current < 8000,
        },
        'POST',
        { keepalive: true },
      ).catch(() => undefined);
    beat();
    const timer = setInterval(beat, 10_000);
    document.addEventListener('visibilitychange', beat);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', beat);
      void api('/presence', { threadId: null, clientId: clientId.current, typing: false }, 'POST', {
        keepalive: true,
      }).catch(() => undefined);
    };
  }, [page, threadId, state?.me.id]);
  useEffect(() => {
    setDraft('');
    setAskChannelAssistant(false);
    followMessages.current = true;
    messageRequest.current = null;
    setMessages([]);
    setChatStatus({ running: false, error: null, previews: [] });
    if (!threadId || !state?.me.id) return;
    let active = true;
    const read = async () => {
      try {
        const [value, assistant] = await Promise.all([
          api<Message[]>(`/threads/${threadId}/messages`),
          api<ChatStatus>(`/threads/${threadId}/assistant`),
        ]);
        if (active) {
          setMessages(value);
          setChatStatus(assistant);
        }
      } catch (problem) {
        if (active) setError((problem as Error).message);
      }
    };
    void read();
    const timer = setInterval(() => void read(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [threadId, state?.me.id]);

  if (loading)
    return (
      <div className="boot" role="status">
        <Leaf size={32} />
        <p>Finding our place…</p>
      </div>
    );
  if (!state) return <SignedOut {...signedOut} />;
  const other = state.people.find((person) => person.id !== state.me.id);
  const otherName = other?.name ?? 'the other person';
  const zone = state.preferences.timezone;
  const now = DateTime.now().setZone(zone);
  const person = (id: string) =>
    id === 'assistant'
      ? 'Our day'
      : state.people.find((person) => person.id === id)?.name || 'Household';
  const due = (task: Task) => (task.dueAt ? DateTime.fromISO(task.dueAt).setZone(zone) : null);
  const overdue = (task: Task) =>
    task.status === 'open' && task.dueAt !== null && Date.parse(task.dueAt) < Date.now();
  const open = state.tasks.filter((task) => task.status === 'open');
  const relevant = (tasks: Task[]) =>
    tasks.filter(
      (task) =>
        filter === 'all' ||
        (filter === 'mine' ? task.ownerId === state.me.id : task.category === 'household'),
    );
  const selected = relevant(open).sort(
    (a, b) =>
      (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity),
  );
  const today = selected.filter((task) => overdue(task) || due(task)?.hasSame(now, 'day'));
  const thread = state.threads.find((thread) => thread.id === threadId);
  // Views open beside (or, on phones, over) the conversation; the chat is always the app.
  const views = [
    { id: 'today', title: 'Today', icon: Home },
    { id: 'tasks', title: 'Tasks', icon: ClipboardList },
    { id: 'calendar', title: 'Calendar', icon: CalendarDays },
  ] as const;
  const openView = (id: typeof page) => {
    setPage(id);
    setChannelsOpen(false);
  };
  const isAssistant = Boolean(thread?.assistantFor);
  const chatTitle = isAssistant ? 'Our day' : thread ? `# ${thread.title}` : 'Our day';
  const chatActivity = chatStatus.running
    ? `Thinking${chatStatus.queued ? ` · ${chatStatus.queued} queued` : '…'}`
    : chatStatus.queued
      ? `${chatStatus.queued} messages waiting`
      : state.integrations.ai === 'configured'
        ? 'Here to help'
        : 'Assistant setup pending';
  const chooseThread = (id: string) => {
    setThreadId(id);
    setPage('chat');
    setChannelsOpen(false);
  };
  const startsGroup = (index: number) => {
    const message = messages[index],
      previous = messages[index - 1];
    return (
      !previous ||
      previous.authorId !== message.authorId ||
      previous.createdAt.slice(0, 10) !== message.createdAt.slice(0, 10) ||
      Date.parse(message.createdAt) - Date.parse(previous.createdAt) > 5 * 60_000
    );
  };
  const savedChangesButton = state.previews.length > 0 && (
    <Button
      variant="ghost"
      size="icon"
      className="relative"
      aria-label={`Review saved changes (${state.previews.length})`}
      onClick={() => setRecoveryOpen(true)}
      disabled={busy}
    >
      <ClipboardList size={19} />
      <span className="unread-dot" />
    </Button>
  );
  const channelNavigation = (
    <>
      <nav className="view-nav" aria-label="Main navigation">
        {[...views, { id: 'settings', title: 'Settings', icon: Settings } as const].map((item) => (
          <Button
            variant="ghost"
            key={item.id}
            className={`thread-item view-item ${page === item.id ? 'active' : ''}`}
            aria-current={page === item.id ? 'page' : undefined}
            onClick={() => openView(item.id)}
          >
            <item.icon size={19} />
            <div>
              <strong>{item.title}</strong>
            </div>
          </Button>
        ))}
      </nav>
      <p className="channel-section-label">YOUR ASSISTANT</p>
      {state.threads
        .filter((item) => item.assistantFor === state.me.id)
        .map((item) => (
          <Button
            variant="ghost"
            key={item.id}
            className={`thread-item ${threadId === item.id ? 'active' : ''}`}
            onClick={() => chooseThread(item.id)}
            disabled={busy}
          >
            <span className="assistant-mark">
              <Leaf size={21} />
            </span>
            <div>
              <strong>Our day</strong>
              <small>Your everyday assistant</small>
            </div>
          </Button>
        ))}
      <div className="channel-section-heading">
        <p className="channel-section-label">SHARED CHANNELS</p>
        <Button
          variant="ghost"
          size="icon"

          aria-label="Add shared channel"
          onClick={() => {
            setChannelsOpen(false);
            setThreadForm(true);
          }}
        >
          <Plus size={17} />
        </Button>
      </div>
      {state.threads
        .filter((item) => !item.assistantFor)
        .map((item) => {
          const active = state.presence.filter(
            (p) => p.threadId === item.id && p.userId !== state.me.id,
          );
          return (
            <Button
              variant="ghost"
              key={item.id}
              className={`thread-item ${threadId === item.id ? 'active' : ''}`}
              disabled={busy}
              onClick={() => chooseThread(item.id)}
            >
              <Hash size={18} />
              <div>
                <strong>{item.title}</strong>
                <small>
                  {active.length
                    ? active
                        .map((p) => `${person(p.userId)} ${p.typing ? 'is typing…' : 'is here'}`)
                        .join(' · ')
                    : 'Both of you + Our day'}
                </small>
              </div>
              {active.length > 0 && (
                <span className="status-dot" aria-label={`${otherName} active`} />
              )}
            </Button>
          );
        })}
      <p className="channel-hint">
        Your chats stay separate. Tasks and appointments bring everything together.
      </p>
    </>
  );
  const notifications = (
    <>
      {state.notices.length ? (
        state.notices.map((notice) => (
          <Card className="notice" key={notice.id}>
            <strong>{notice.title}</strong>
            <p>{notice.body}</p>
            <time>{DateTime.fromISO(notice.createdAt).setZone(zone).toFormat('d LLL, HH:mm')}</time>
            {notice.targetKind && (
              <Button
                variant="ghost"
                className="notice-link"
                onClick={() => {
                  setShowNotices(false);
                  if (notice.targetKind === 'task') {
                    setPage('tasks');
                    const task = state.tasks.find((task) => task.id === notice.targetId);
                    if (task) setTaskForm(task);
                  } else {
                    setPage('calendar');
                    const event = state.calendar.events.find(
                      (event) => event.id === notice.targetId,
                    );
                    if (event) setEventForm(event);
                  }
                }}
              >
                View {notice.targetKind === 'task' ? 'task' : 'calendar'} <ArrowRight size={14} />
              </Button>
            )}
          </Card>
        ))
      ) : (
        <div className="day-empty">
          <Bell size={28} />
          <h3>You’re all caught up</h3>
          <p>{otherName}’s changes, your reminders, and summaries will appear here.</p>
        </div>
      )}
    </>
  );
  const rows = (tasks: Task[]) =>
    tasks.length ? (
      <div className="task-list">
        {tasks.map((task) => (
          <Card className="task-row" key={task.id}>
            <Button
              variant="ghost"
              size="icon"
              className="complete-button"
              disabled={busy || !connected}
              onClick={() =>
                void act({ kind: 'task.complete', id: task.id, revision: task.revision })
              }
              aria-label={`Review completion of ${task.title}`}
            >
              <Circle size={23} />
            </Button>
            <div className="task-content">
              <Button variant="ghost" className="task-title" onClick={() => setTaskForm(task)}>
                {task.title}
              </Button>
              <div className="task-meta">
                <span className={`category-dot ${task.category}`} />
                <span>{person(task.ownerId)}</span>
                {task.dueAt && (
                  <>
                    <span>·</span>
                    <span className={overdue(task) ? 'overdue' : ''}>
                      {due(task)!.toFormat(
                        due(task)!.hasSame(now, 'day') ? "'Today,' HH:mm" : 'd LLL, HH:mm',
                      )}
                    </span>
                  </>
                )}
                {task.schedule && (
                  <Repeat2 size={12} aria-label={`Repeats ${task.schedule.frequency}`} />
                )}
              </div>
              {task.missedDates.length > 0 && (
                <Disclosure
                  className="missed"
                  title={
                    <>
                      Missed {task.missedDates.length}{' '}
                      {task.missedDates.length === 1 ? 'time' : 'times'}
                    </>
                  }
                >
                  <ul>
                    {task.missedDates.map((date) => (
                      <li key={date}>
                        {DateTime.fromISO(date).setZone(zone).toFormat('d LLL yyyy, HH:mm')}
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Actions for ${task.title}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setTaskForm(task)}>Edit task</DropdownMenuItem>
                <DropdownMenuItem
                  disabled={busy || !connected}
                  onSelect={() =>
                    void act({ kind: 'task.complete', id: task.id, revision: task.revision })
                  }
                >
                  Review completion
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </Card>
        ))}
      </div>
    ) : (
      <Empty
        icon={<CheckCheck size={28} />}
        title="A little breathing room"
        text="Nothing here needs your attention. Add a task whenever something comes to mind."
      />
    );

  const banners = (
    <>
      {!connected && (
        <Alert className="connection-banner" role="status">
          <AlertDescription>
            Connection lost. Showing the last loaded view; reconnect before making changes.
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert className="error-banner" role="alert">
          <AlertDescription>
            {error}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setError('')}
              aria-label="Dismiss error"
            >
              <X size={16} />
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </>
  );
  return (
    <div
      className={`app-shell ${page === 'chat' ? '' : 'view-open'} ${keyboardOpen ? 'keyboard-open' : ''}`}
      onClickCapture={rememberOverlayOpener}
    >
      <aside className="sidebar" aria-label="Your spaces">
        {channelNavigation}
      </aside>
      <main className="chat-pane">
        {banners}
        {thread ? (
          <>
            <div className="thread-heading">
              <Button
                variant="ghost"
                size="icon"
                className="channels-toggle"
                onClick={() => setChannelsOpen(true)}
                aria-label="Open menu"
              >
                <Menu size={22} />
              </Button>
              <Button
                variant="ghost"
                className="assistant-avatar"
                onClick={() => setActivityOpen(true)}
                aria-label="Assistant activity"
              >
                <Leaf size={24} />
              </Button>
              <div className="chat-heading-copy">
                <h1>{chatTitle}</h1>
                <Button
                  variant="ghost"
                  className="chat-activity"
                  onClick={() => setActivityOpen(true)}
                >
                  {isAssistant ? chatActivity : `You, ${otherName} & Our day`}
                  {!isAssistant && <Users size={12} />}
                </Button>
              </div>
              {savedChangesButton}
              <Button
                variant="ghost"
                size="icon"
                className="chat-glance"
                aria-label="Open your day"
                onClick={() => openView('today')}
              >
                <CalendarDays size={20} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="chat-updates"
                aria-label="Open updates"
                onClick={() => setShowNotices(true)}
              >
                <Bell size={20} />
                {state.notices.some((notice) => !notice.readAt) && <span className="unread-dot" />}
              </Button>
            </div>
            <div
              className="messages"
              role="log"
              aria-label="Conversation messages"
              ref={messagesPanel}
              aria-live="polite"
              onScroll={() => {
                const element = messagesPanel.current;
                if (element)
                  followMessages.current =
                    element.scrollHeight - element.scrollTop - element.clientHeight < 100;
              }}
            >
              {messages.length ? (
                messages.map((message, index) => (
                  <React.Fragment key={message.id}>
                    {(index === 0 ||
                      message.createdAt.slice(0, 10) !==
                        messages[index - 1].createdAt.slice(0, 10)) && (
                      <div className="chat-day">
                        {DateTime.fromISO(message.createdAt).setZone(zone).hasSame(now, 'day')
                          ? 'Today'
                          : DateTime.fromISO(message.createdAt)
                              .setZone(zone)
                              .toFormat('ccc, d LLL')}
                      </div>
                    )}
                    {startsGroup(index) &&
                      message.authorId !== state.me.id &&
                      !(isAssistant && message.authorId === 'assistant') && (
                        <div className="message-author">{person(message.authorId)}</div>
                      )}
                    <article
                      className={`message ${message.authorId === state.me.id ? 'mine' : ''} ${message.authorId === 'assistant' ? 'from-assistant' : ''} ${startsGroup(index) ? 'group-start' : ''}`}
                    >
                      <p>
                        <span className="sr-only">{person(message.authorId)}: </span>
                        {message.text}
                        <time>
                          {DateTime.fromISO(message.createdAt).setZone(zone).toFormat('HH:mm')}
                        </time>
                      </p>
                    </article>
                  </React.Fragment>
                ))
              ) : (
                <div className="chat-welcome">
                  <span className="welcome-mark">
                    <Leaf size={36} />
                  </span>
                  <h2>{isAssistant ? `Hey, ${state.me.name}.` : `# ${thread.title}`}</h2>
                  <p>
                    {isAssistant
                      ? 'A little less to remember. What’s on your mind?'
                      : 'A space for the two of you. Mention @assistant when you want a hand.'}
                  </p>
                  {state.integrations.ai !== 'configured' && (
                    <p className="small muted">
                      ChatGPT isn’t connected yet. Your messages will be saved.
                    </p>
                  )}
                  {isAssistant && (
                    <div className="chat-starters">
                      {[
                        'What’s on today?',
                        'What needs following up?',
                        'Help me add a household task',
                      ].map((prompt) => (
                        <Button
                          variant="outline"
                          key={prompt}
                          onClick={() => {
                            setDraft(prompt);
                            composerInput.current?.focus();
                          }}
                        >
                          {prompt}
                          <ArrowRight size={15} />
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {chatStatus.previews.length > 0 && (
                <div className="chat-proposals">
                  {chatStatus.previews.map(({ actorId, preview: proposal }) => (
                    <Card className="chat-proposal" key={proposal.id}>
                      <div>
                        <strong>{proposal.title}</strong>
                        <p className="small muted">
                          Prepared for {person(actorId)}. Nothing changes until confirmed.
                        </p>
                      </div>
                      <Button
                        variant="outline"

                        disabled={busy || !connected || actorId !== state.me.id}
                        onClick={() =>
                          reviewPreview(
                            state.previews.find((item) => item.id === proposal.id) ?? proposal,
                          )
                        }
                      >
                        Review change
                      </Button>
                    </Card>
                  ))}
                </div>
              )}
            </div>
            {chatStatus.error && (
              <Alert role="status" className="chat-error">
                <AlertDescription>
                  {chatStatus.error}{' '}
                  <a href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noreferrer">
                    Manage usage
                  </a>
                </AlertDescription>
              </Alert>
            )}
            <div className="typing-status">
              {chatStatus.running && 'Our day assistant is thinking… '}
              {state.presence
                .filter((p) => p.threadId === thread.id && p.userId !== state.me.id)
                .map((p) => `${person(p.userId)} is ${p.typing ? 'typing…' : 'here'}`)
                .join(' · ')}
            </div>
            <form
              className="composer"
              aria-busy={busy}
              onSubmit={async (event) => {
                event.preventDefault();
                if (!draft.trim() || busy) return;
                const submitted = draft;
                const text = submitted.trim();
                const target = thread.id;
                const actorId = activeLogin.current;
                const prior = messageRequest.current;
                const requestId =
                  prior?.threadId === target && prior.text === text
                    ? prior.requestId
                    : crypto.randomUUID();
                messageRequest.current = { requestId, threadId: target, text };
                // Results apply only while the same login still shows this thread.
                const current = () =>
                  activeLogin.current === actorId && visibleThread.current === target;
                setBusy(true);
                setError('');
                try {
                  await api(`/threads/${target}/messages`, {
                    text,
                    requestId,
                    askAssistant: isAssistant || askChannelAssistant || mentionsAssistant(text),
                  });
                  if (messageRequest.current?.requestId === requestId)
                    messageRequest.current = null;
                  if (!current()) return;
                  // Clear only what was sent; keep anything typed while it was sending.
                  setDraft((latest) =>
                    latest === submitted
                      ? ''
                      : latest.startsWith(submitted)
                        ? latest.slice(submitted.length).trimStart()
                        : latest,
                  );
                  if (draftValue.current === submitted && composerInput.current)
                    composerInput.current.style.height = 'auto';
                  followMessages.current = true;
                  const [value, assistant] = await Promise.all([
                    api<Message[]>(`/threads/${target}/messages`),
                    api<ChatStatus>(`/threads/${target}/assistant`),
                  ]);
                  if (!current()) return;
                  setMessages(value);
                  setChatStatus(assistant);
                } catch (problem) {
                  if (current()) setError((problem as Error).message);
                } finally {
                  if (activeLogin.current === actorId) setBusy(false);
                }
              }}
            >
              {!isAssistant && (
                <div className="ask-assistant-row">
                  <Label className="ask-assistant-toggle">
                    <Switch
                      checked={askChannelAssistant}
                      onCheckedChange={setAskChannelAssistant}
                    />
                    <span>Ask Our day</span>
                  </Label>
                  <span className="small muted" role="status">
                    {askChannelAssistant || mentionsAssistant(draft)
                      ? `${askChannelAssistant ? '' : '@assistant mentioned · '}Our day will reply`
                      : ''}
                  </span>
                </div>
              )}
              <div className="composer-input-row">
                <Textarea
                  ref={composerInput}
                  aria-label="Message"
                  placeholder={isAssistant ? 'Message Our day…' : `Message #${thread.title}…`}
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    event.target.style.height = 'auto';
                    event.target.style.height = `${Math.min(140, event.target.scrollHeight)}px`;
                    lastTyping.current = Date.now();
                  }}
                  rows={1}
                />
                <Button
                  variant="default"
                  size="icon"
                  className="send-button"
                  type="submit"
                  aria-label="Send message"
                  disabled={busy || !connected || !draft.trim()}
                >
                  <Send size={18} />
                </Button>
              </div>
            </form>
          </>
        ) : (
          <Empty
            icon={<MessageCircle size={30} />}
            title="Opening your assistant…"
            text="Your conversation is being prepared."
          />
        )}
      </main>
      {page !== 'chat' && (
        <section className="view-panel" aria-label={page === 'settings' ? 'Settings' : 'Your day'}>
          <div className="view-header">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Back to chat"
              onClick={() => setPage('chat')}
            >
              <ArrowLeft size={20} />
            </Button>
            <strong className={page === 'settings' ? '' : 'view-title'}>
              {page === 'settings' ? 'Settings' : views.find((item) => item.id === page)?.title}
            </strong>
            {page !== 'settings' && (
              <div className="view-tabs" role="group" aria-label="Views">
                {views.map((item) => (
                  <Button
                    variant="ghost"
                    key={item.id}
                    aria-pressed={page === item.id}
                    onClick={() => setPage(item.id)}
                  >
                    {item.title}
                  </Button>
                ))}
              </div>
            )}
            <div className="panel-actions">
              {savedChangesButton}
              <Button
                variant="ghost"
                size="icon"
                className="chat-updates"
                aria-label="Open updates"
                onClick={() => setShowNotices(true)}
              >
                <Bell size={20} />
                {state.notices.some((notice) => !notice.readAt) && <span className="unread-dot" />}
              </Button>
            </div>
          </div>
          <div className="panel-banners">{banners}</div>
          <div className="page">
            {page === 'today' && (
              <>
                <div className="eyebrow">
                  <Sun size={15} /> {now.toFormat('cccc, d LLLL').toUpperCase()}
                </div>
                <div className="page-heading">
                  <div>
                    <h1>
                      {now.hour < 12
                        ? 'Good morning'
                        : now.hour < 18
                          ? 'Good afternoon'
                          : 'Good evening'}
                      , {state.me.name}.
                    </h1>
                    <p>Make a little room for what matters.</p>
                  </div>
                  <Button
                    variant="default"

                    onClick={() => setTaskForm('new')}
                    disabled={!connected}
                  >
                    <Plus size={17} /> Add task
                  </Button>
                </div>
                <div className="overview">
                  <div>
                    <span className="overview-icon green">
                      <ClipboardList size={20} />
                    </span>
                    <strong>
                      {
                        open.filter((t) => t.ownerId === state.me.id && due(t)?.hasSame(now, 'day'))
                          .length
                      }
                    </strong>
                    <span>Due today</span>
                  </div>
                  <div>
                    <span className="overview-icon peach">
                      <Repeat2 size={20} />
                    </span>
                    <strong>
                      {open.filter((t) => t.ownerId === state.me.id && overdue(t)).length}
                    </strong>
                    <span>Need a follow-up</span>
                  </div>
                  <div>
                    <span className="overview-icon purple">
                      <Users size={20} />
                    </span>
                    <strong>{open.filter((t) => t.category === 'household').length}</strong>
                    <span>Household tasks</span>
                  </div>
                </div>
                <div className="today-grid">
                  <Card className="focus-card">
                    <div className="section-heading">
                      <div>
                        <span className="eyebrow">ONE THING AT A TIME</span>
                        <h2>Your focus today</h2>
                      </div>
                      <Button variant="ghost" onClick={() => setPage('tasks')}>
                        All tasks <ArrowRight size={15} />
                      </Button>
                    </div>
                    <TaskCollection value={filter} onValueChange={setFilter}>
                      {rows(today)}
                    </TaskCollection>
                  </Card>
                  <aside className="day-aside">
                    <CalendarCard
                      calendar={state.calendar}
                      zone={zone}
                      open={() => setPage('calendar')}
                    />
                    <Card className="summary-card">
                      <Sunset size={24} />
                      <h3>A moment to reset.</h3>
                      <p>
                        {state.preferences.evening.enabled
                          ? `Your evening summary is set for ${state.preferences.evening.time}.`
                          : 'Your evening summary is switched off.'}
                      </p>
                      <Button variant="ghost" onClick={() => setPage('settings')}>
                        Make it yours <ArrowRight size={14} />
                      </Button>
                    </Card>
                  </aside>
                </div>
              </>
            )}
            {page === 'tasks' && (
              <>
                <div className="eyebrow">A PLACE FOR EVERYTHING</div>
                <div className="page-heading">
                  <div>
                    <h1>A little less on your mind.</h1>
                    <p>One of you follows up on each. Either of you can lend a hand.</p>
                  </div>
                  <Button
                    variant="default"

                    onClick={() => setTaskForm('new')}
                    disabled={!connected}
                  >
                    <Plus size={17} /> Add task
                  </Button>
                </div>
                <Card className="full-card">
                  <div className="section-heading">
                    <h2>
                      Open tasks <Badge variant="secondary">{selected.length}</Badge>
                    </h2>
                  </div>
                  <TaskCollection value={filter} onValueChange={setFilter}>
                    {rows(selected)}
                  </TaskCollection>
                </Card>
                {state.tasks.some((t) => t.status === 'completed') && (
                  <Disclosure
                    className="completed-section"
                    title={
                      <>
                        Completed tasks ·{' '}
                        {state.tasks.filter((t) => t.status === 'completed').length}
                      </>
                    }
                  >
                    {relevant(state.tasks.filter((t) => t.status === 'completed')).map((task) => (
                      <div className="completed-row" key={task.id}>
                        <Check size={16} />
                        <span>{task.title}</span>
                        <small>{person(task.completedBy || '')}</small>
                      </div>
                    ))}
                  </Disclosure>
                )}
              </>
            )}
            {page === 'calendar' && (
              <CalendarView
                calendar={state.calendar}
                zone={zone}
                busy={busy || !connected}
                onNew={(day) => {
                  setEventDate(day);
                  setEventForm('new');
                }}
                onEdit={setEventForm}
                onRefresh={() => {
                  setBusy(true);
                  void api('/calendar/refresh', {})
                    .then(() => refresh())
                    .catch((problem) => setError((problem as Error).message))
                    .finally(() => setBusy(false));
                }}
              />
            )}
            {page === 'settings' && (
              <>
                <div className="eyebrow">YOUR OWN RHYTHM</div>
                <div className="page-heading">
                  <div>
                    <h1>Make yourself at home.</h1>
                    <p>
                      These settings are just for {state.me.name}. {otherName} sets their own.
                    </p>
                  </div>
                </div>
                <PeopleSettings state={state} />
                <SummarySettings
                  preferences={state.preferences}
                  busy={busy || !connected}
                  onSave={(preferences) =>
                    void act({
                      kind: 'preferences.update',
                      revision: state.preferences.revision,
                      preferences,
                    })
                  }
                />
                <Card className="settings-card">
                  <h2>
                    <Bell size={19} /> Phone notifications
                  </h2>
                  <p className="muted">
                    Task deadlines and daily summaries, even when the app is closed.
                  </p>
                  <PushSettings onError={setError} />
                  <p className="small muted">
                    {otherName}’s confirmed changes appear in Updates and arrive on this device when
                    notifications are enabled. Appointment alerts also come from Apple Calendar.
                  </p>
                </Card>
                <CalendarSettings state={state} />
                <AppearanceSettings />
                <Card className="settings-card">
                  <h2>
                    <MessageCircle size={19} /> Assistant
                  </h2>
                  <p className="muted">
                    {state.integrations.ai === 'configured'
                      ? 'Eligible AI requests use the connected ChatGPT plan. Messages in this topic and the tasks, settings, and appointments the assistant reads are sent to OpenAI. Every proposed change still needs your confirmation.'
                      : state.integrations.ai === 'needs-model'
                        ? 'ChatGPT is connected. Set CHATGPT_MODEL in the Worker’s variables on Cloudflare to one of the account’s models.'
                        : 'Connect ChatGPT from the Mac: run npm run ai:connect -- --production, then npm run secrets. You can keep using shared messages, tasks, and the calendar meanwhile.'}
                  </p>
                  {state.integrations.ai !== 'not-connected' && <ModelList />}
                  <a href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noreferrer">
                    Manage ChatGPT usage
                  </a>
                </Card>
                {state.signIn === 'development' ? (
                  <Card className="settings-card">
                    <h2>Development</h2>
                    <p className="muted">
                      This local server has no sign-in. You’re acting as {state.me.name}.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => {
                        // Development only: try the household as the other person.
                        document.cookie = `household-dev-person=${state.me.id === 'owner' ? 'partner' : 'owner'}; path=/; SameSite=Strict`;
                        location.reload();
                      }}
                    >
                      Act as {state.people.find((person) => person.id !== state.me.id)?.name}
                    </Button>
                  </Card>
                ) : (
                  <Button
                    variant="ghost"
                    className="logout"
                    onClick={async () => {
                      try {
                        const registration = await navigator.serviceWorker?.getRegistration();
                        const subscription = await registration?.pushManager.getSubscription();
                        if (subscription) {
                          await api(
                            '/push/subscription',
                            { endpoint: subscription.endpoint },
                            'DELETE',
                          );
                          await subscription.unsubscribe();
                        }
                      } catch {
                        // Signing out still ends the Cloudflare Access session.
                      }
                      location.href = '/cdn-cgi/access/logout';
                    }}
                  >
                    <LogOut size={17} /> Sign out
                  </Button>
                )}
              </>
            )}
          </div>
        </section>
      )}
      {channelsOpen && (
        <Modal title="Your spaces" drawer close={() => setChannelsOpen(false)}>
          {channelNavigation}
        </Modal>
      )}
      {showNotices && (
        <Modal title="Updates" informational close={() => setShowNotices(false)}>
          <p className="small muted inbox-intro">
            Changes from {otherName}, plus your reminders and summaries.
          </p>
          {notifications}
        </Modal>
      )}
      {activityOpen && (
        <Modal title="Our day activity" informational close={() => setActivityOpen(false)}>
          <p>{chatActivity}</p>
          <p className="small muted">
            {chatStatus.running
              ? 'You can keep messaging. New requests wait their turn in this chat.'
              : 'Ask about your day, update a task, or plan an appointment.'}
          </p>
          <p>{chatStatus.previews.length} changes waiting for your review.</p>
          <p className="small muted">
            {state.integrations.ai === 'configured'
              ? 'Using the connected ChatGPT plan.'
              : 'ChatGPT isn’t connected yet. Your messages will be saved.'}
          </p>
          {state.integrations.ai === 'configured' && (
            <a href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noreferrer">
              Manage ChatGPT usage
            </a>
          )}
          {chatStatus.error && <p className="field-error">{chatStatus.error}</p>}
          <Button
            variant="ghost"

            onClick={() => {
              setActivityOpen(false);
              setPage('today');
            }}
          >
            Today’s overview <ArrowRight size={15} />
          </Button>
          <Button
            variant="ghost"

            onClick={() => {
              setActivityOpen(false);
              setPage('settings');
            }}
          >
            Assistant settings <ArrowRight size={15} />
          </Button>
        </Modal>
      )}
      {planNotice && (
        <Modal
          title="Using the connected ChatGPT plan"
          close={() => {
            try {
              localStorage.setItem(`chatgpt-plan-notice:${state.me.id}`, 'seen');
            } catch {
              /* Storage may be disabled. */
            }
            setPlanNotice(false);
          }}
        >
          <p>
            Eligible assistant requests use the connected ChatGPT plan and share its usage limits.
            Messages in this topic and the information the assistant reads are sent to OpenAI.
          </p>
          <p>Task and calendar changes always need a separate confirmation preview.</p>
          <p>
            <a href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noreferrer">
              Manage ChatGPT usage
            </a>
          </p>
          <Button
            variant="default"

            onClick={() => {
              try {
                localStorage.setItem(`chatgpt-plan-notice:${state.me.id}`, 'seen');
              } catch {
                /* Storage may be disabled. */
              }
              setPlanNotice(false);
            }}
          >
            Got it
          </Button>
        </Modal>
      )}
      {taskForm && (
        <Modal
          inactive={Boolean(preview)}
          title={taskForm === 'new' ? 'A new task' : 'Edit task'}
          close={() => setTaskForm(null)}
        >
          {editorNotice && (
            <EditorNotice
              notice={editorNotice}
              onDiscard={() => {
                setEditorNotice(null);
                setEditorVersion((version) => version + 1);
              }}
            />
          )}
          <TaskForm
            key={editorVersion}
            task={taskForm === 'new' ? undefined : taskForm}
            state={state}
            busy={busy || !connected || Boolean(editorNotice?.gone)}
            onSubmit={(task) =>
              void act(
                taskForm === 'new'
                  ? { kind: 'task.create', task }
                  : { kind: 'task.update', id: taskForm.id, revision: taskForm.revision, task },
              )
            }
            onDelete={
              taskForm === 'new'
                ? undefined
                : () =>
                    void act({ kind: 'task.delete', id: taskForm.id, revision: taskForm.revision })
            }
          />
        </Modal>
      )}
      {eventForm && (
        <Modal
          inactive={Boolean(preview)}
          title={eventForm === 'new' ? 'A shared appointment' : 'Shared appointment'}
          close={() => setEventForm(null)}
        >
          {editorNotice && (
            <EditorNotice
              notice={editorNotice}
              onDiscard={() => {
                setEditorNotice(null);
                setEditorVersion((version) => version + 1);
              }}
            />
          )}
          <EventForm
            key={editorVersion}
            event={eventForm === 'new' ? undefined : eventForm}
            defaultDate={eventForm === 'new' ? eventDate : undefined}
            zone={zone}
            busy={
              busy ||
              !connected ||
              state.calendar.status !== 'connected' ||
              Boolean(editorNotice?.gone)
            }
            onSubmit={(event) =>
              void act(
                eventForm === 'new'
                  ? { kind: 'calendar.create', event }
                  : { kind: 'calendar.update', id: eventForm.id, etag: eventForm.etag, event },
              )
            }
            onDelete={
              eventForm === 'new'
                ? undefined
                : () =>
                    void act({ kind: 'calendar.delete', id: eventForm.id, etag: eventForm.etag })
            }
          />
        </Modal>
      )}
      {threadForm && (
        <Modal
          inactive={Boolean(preview)}
          title="A shared channel"
          close={() => setThreadForm(false)}
        >
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void act({
                kind: 'thread.create',
                title: String(data.get('title')),
                category: String(data.get('category')) as Category,
              });
            }}
          >
            <Label>
              Channel name
              <Input name="title" required maxLength={120} placeholder="Weekend plans" />
            </Label>
            <Label>
              Space
              <NativeSelect name="category">
                <option value="household">Household</option>
                <option value="work">Work</option>
                <option value="personal">Personal</option>
              </NativeSelect>
            </Label>
            <p className="small muted">Both of you can see and join this conversation.</p>
            <Button variant="default" disabled={busy || !connected}>
              Review channel <ArrowRight size={15} />
            </Button>
          </form>
        </Modal>
      )}
      {recoveryOpen && (
        <Modal
          title="Saved changes"
          close={() => setRecoveryOpen(false)}
          inactive={Boolean(preview)}
        >
          <p className="small muted">
            These are your saved previews, including unresolved calendar writes. Nothing new is
            applied by opening them.
          </p>
          <div className="grid max-h-[55dvh] gap-3 overflow-y-auto p-1">
            {state.previews.length === 0 && <p>No saved changes need review.</p>}
            {state.previews.map((proposal) => (
              <Card role="article" className="gap-2 px-4 py-4" key={proposal.id}>
                <strong>{proposal.title}</strong>
                <p>
                  {
                    proposal.details.find((detail) =>
                      ['Task', 'Appointment', 'Channel'].includes(detail.label),
                    )?.after
                  }
                </p>
                <p>
                  {proposal.calendarOutcome?.message ??
                    `Awaiting confirmation · expires ${DateTime.fromISO(proposal.expiresAt).setZone(zone).toFormat('d LLL, HH:mm')}`}
                </p>
                <Button
                  variant="outline"
                  className="self-start"
                  disabled={busy || !connected}
                  onClick={() => reviewPreview(proposal)}
                >
                  Review saved change
                </Button>
              </Card>
            ))}
          </div>
        </Modal>
      )}
      {preview && (
        <Modal
          title={preview.title}
          close={preview.calendarOutcome ? () => setPreview(null) : cancelPreview}
        >
          <ConfirmationDetails
            preview={preview}
            format={(value, label) => formatDetail(value, label, zone)}
          />
          {previewError && (
            <p className="field-error" role="alert">
              {previewError}
            </p>
          )}
          <p className="small muted" role={preview.calendarOutcome ? 'status' : undefined}>
            {preview.calendarOutcome?.message ?? 'Nothing changes until you confirm.'}
          </p>
          {preview.calendarOutcome?.status === 'unknown' && (
            <p className="small muted">
              Dismissal only hides this result; it does not undo a calendar change. You can review
              the calendar and return to this result from Saved changes.
            </p>
          )}
          {preview.calendarOutcome?.status === 'unknown' && (
            <Button
              variant="link"
              className="px-0"
              onClick={() => {
                setPreview(null);
                setRecoveryOpen(false);
                setPage('calendar');
              }}
              disabled={busy}
            >
              Review current calendar
            </Button>
          )}
          <div className="dialog-actions">
            <Button
              variant="outline"
              onClick={preview.calendarOutcome ? () => void dismissPreview() : cancelPreview}
              disabled={busy}
            >
              {preview.calendarOutcome ? 'Dismiss result' : 'Go back'}
            </Button>
            <Button
              onClick={() => void confirm()}
              disabled={busy || !connected || !previewRetryable}
            >
              <Check size={16} />
              {busy
                ? preview.calendarOutcome
                  ? 'Checking…'
                  : 'Saving…'
                : preview.calendarOutcome?.status === 'unknown'
                  ? 'Check result (read only)'
                  : preview.calendarOutcome
                    ? 'New preview required'
                    : 'Confirm change'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function EditorNotice({
  notice,
  onDiscard,
}: {
  notice: { text: string; gone: boolean };
  onDiscard: () => void;
}) {
  const alert = useRef<HTMLDivElement>(null);
  // The editor may be scrolled to its actions; bring the explanation into view.
  // Block body: newer browsers return a Promise, which React would call as cleanup.
  useEffect(() => {
    alert.current?.scrollIntoView({ block: 'nearest' });
  }, [notice.text]);
  return (
    <Alert role="alert" ref={alert}>
      <AlertDescription>
        {notice.text}
        {!notice.gone && (
          <Button variant="link" className="h-auto px-0" type="button" onClick={onDiscard}>
            Discard my edits and show the latest
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

function formatDetail(value: string, label: string, zone: string) {
  if (['Starts', 'Ends', 'Through'].includes(label) && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return DateTime.fromISO(value, { zone }).toFormat('ccc, d LLL yyyy');
  return ['Due', 'Next due', 'Starts', 'Ends'].includes(label) && DateTime.fromISO(value).isValid
    ? DateTime.fromISO(value).setZone(zone).toFormat('ccc, d LLL yyyy · HH:mm ZZZZ')
    : value;
}
function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="empty">
      <span>{icon}</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

/** The welcome layout of the signed-out screen. */
function Welcome({ children }: { children: React.ReactNode }) {
  return (
    <div className="login-page">
      <div className="login-story">
        <a className="brand">
          <span className="brand-mark">
            <Leaf size={24} />
          </span>
          our day<span className="brand-dot">.</span>
        </a>
        <div>
          <div className="eyebrow">A SHARED PLACE TO LAND</div>
          <h1>
            Less to remember.
            <br />
            More room for life.
          </h1>
          <p>
            Small tasks. Shared plans.
            <br />A home for everything on your mind.
          </p>
          <div className="login-art" aria-hidden="true">
            <div className="art-card">
              <Sun size={26} />
              <span>A little more together.</span>
              <div>
                <span />
                <span />
                <span />
              </div>
            </div>
            <div className="art-leaf">
              <Leaf size={90} strokeWidth={1} />
            </div>
          </div>
        </div>
        <span className="small">Made for the two of you.</span>
      </div>
      <section className="login-form">
        <div className="mobile-brand brand">
          <Leaf size={26} /> our day.
        </div>
        {children}
        <p className="small muted login-footnote">Your own view. Shared between you.</p>
      </section>
    </div>
  );
}

/**
 * Cloudflare Access signs people in, so the app shows this only when that
 * sign-in has ended or names another email, when Access is not on, or when a
 * Worker variable the app needs is missing.
 */
function SignedOut({ status, message }: { status: number; message: string }) {
  return (
    <Welcome>
      <div className="eyebrow">WELCOME HOME</div>
      <h2>Your day starts here.</h2>
      <p className="muted" role="alert">
        {message}
      </p>
      <div className="form signed-out-actions">
        <Button variant="default" onClick={() => location.reload()}>
          {status === 401 || status === 403 ? 'Sign in' : 'Try again'}
          <ArrowRight size={17} />
        </Button>
        {status === 401 && <a href="/cdn-cgi/access/logout">Use a different email</a>}
      </div>
    </Welcome>
  );
}

/** Where a Worker variable is set, for the hints below. */
const workerVariables = 'the Worker’s Settings → Variables and Secrets on Cloudflare';

/** The shared iCloud calendar's status; the account comes from the Worker's variables. */
function CalendarSettings({ state }: { state: Snapshot }) {
  return (
    <Card className="settings-card">
      <h2>
        <CalendarDays size={19} /> Shared calendar
      </h2>
      <p className="muted">
        {state.integrations.calendar === 'not-connected'
          ? `To connect the shared iCloud calendar, add ICLOUD_USERNAME (the Apple ID), ICLOUD_APP_PASSWORD (an app-specific password, never the Apple ID password) and ICLOUD_CALENDAR (the calendar’s name) in ${workerVariables}.`
          : state.integrations.calendar === 'connected'
            ? `Connected to ${state.calendar.name}.`
            : (state.calendar.error ?? 'The shared calendar could not be refreshed.')}
      </p>
    </Card>
  );
}

/** The connected ChatGPT account's models, to copy one into CHATGPT_MODEL. */
function ModelList() {
  const [catalog, setCatalog] = useState<{
    current: string | null;
    models: { id: string; name: string }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="form">
      {catalog ? (
        <ul className="model-list">
          {catalog.models.map((model) => (
            <li key={model.id}>
              {model.name} · <code>{model.id}</code>
              {model.id === catalog.current && ' (in use)'}
            </li>
          ))}
        </ul>
      ) : (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError('');
            void api<{ current: string | null; models: { id: string; name: string }[] }>(
              '/assistant/models',
            )
              .then(setCatalog)
              .catch((problem) => setError((problem as Error).message))
              .finally(() => setBusy(false));
          }}
        >
          Show the account’s models
        </Button>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The two people, from the Worker's variables. */
function PeopleSettings({ state }: { state: Snapshot }) {
  return (
    <Card className="settings-card">
      <h2>
        <Users size={19} /> The two of you
      </h2>
      <p className="muted">
        {state.people.map((person) => person.name).join(' and ')}.
        {state.signIn === 'cloudflare-access' && ` You’re signed in as ${state.me.username}.`}
      </p>
      <p className="small muted">
        Names and emails are PERSON_1_NAME, PERSON_1_EMAIL, PERSON_2_NAME and PERSON_2_EMAIL in{' '}
        {workerVariables}. Cloudflare Access must allow both emails.
      </p>
    </Card>
  );
}

function TaskForm({
  task,
  state,
  busy,
  onSubmit,
  onDelete,
}: {
  task?: Task;
  state: Snapshot;
  busy: boolean;
  onSubmit: (task: Extract<Mutation, { kind: 'task.create' }>['task']) => void;
  onDelete?: () => void;
}) {
  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const local = String(form.get('dueAt'));
        const date = local ? DateTime.fromISO(local, { zone: state.preferences.timezone }) : null;
        if (date && !date.isValid) return;
        const recurrence = String(form.get('schedule'));
        onSubmit({
          title: String(form.get('title')),
          notes: String(form.get('notes')),
          ownerId: String(form.get('ownerId')),
          category: String(form.get('category')) as Category,
          dueAt: date?.toUTC().toISO() ?? null,
          schedule:
            recurrence === 'once'
              ? null
              : {
                  frequency: recurrence as 'daily' | 'weekly',
                  timezone: state.preferences.timezone,
                },
        });
      }}
    >
      <Label>
        What needs doing?
        <Input
          name="title"
          required
          maxLength={200}
          defaultValue={task?.title}
          placeholder="Something to take off your mind"
        />
      </Label>
      <div className="form-pair">
        <Label>
          Who follows up
          <NativeSelect name="ownerId" defaultValue={task?.ownerId ?? state.me.id}>
            {state.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        </Label>
        <Label>
          Space
          <NativeSelect name="category" defaultValue={task?.category ?? 'household'}>
            <option value="household">Household</option>
            <option value="work">Work</option>
            <option value="personal">Personal</option>
          </NativeSelect>
        </Label>
      </div>
      <Label>
        Due date & time <span className="optional">optional · {state.preferences.timezone}</span>
        <Input
          name="dueAt"
          type="datetime-local"
          defaultValue={
            task?.dueAt
              ? DateTime.fromISO(task.dueAt)
                  .setZone(state.preferences.timezone)
                  .toFormat("yyyy-MM-dd'T'HH:mm")
              : ''
          }
        />
      </Label>
      <Label>
        Repeat
        <NativeSelect name="schedule" defaultValue={task?.schedule?.frequency ?? 'once'}>
          <option value="once">Just this once</option>
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
        </NativeSelect>
      </Label>
      <Label>
        Anything else? <span className="optional">optional</span>
        <Textarea name="notes" rows={3} maxLength={5000} defaultValue={task?.notes} />
      </Label>
      <p className="small muted">Either of you can help or mark this task complete.</p>
      {task && (
        <Disclosure className="task-history" title="History">
          <TaskHistory task={task} state={state} />
        </Disclosure>
      )}
      <div className="dialog-actions">
        {onDelete && (
          <Button
            variant="ghost"
            className="text-destructive"
            type="button"
            onClick={onDelete}
            disabled={busy}
          >
            <Trash2 size={16} /> Delete
          </Button>
        )}
        <Button variant="default" disabled={busy}>
          Review {task ? 'changes' : 'task'}
          <ArrowRight size={15} />
        </Button>
      </div>
    </form>
  );
}

function TaskHistory({ task, state }: { task: Task; state: Snapshot }) {
  const [history, setHistory] = useState<TaskOccurrence[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    api<TaskOccurrence[]>(`/tasks/${task.id}/history`)
      .then((value) => active && setHistory(value))
      .catch((problem) => active && setError((problem as Error).message));
    return () => {
      active = false;
    };
  }, [task.id, task.revision]);
  const zone = state.preferences.timezone;
  const when = (value: string) =>
    DateTime.fromISO(value).setZone(zone).toFormat('d LLL yyyy, HH:mm');
  const person = (id: string) =>
    state.people.find((person) => person.id === id)?.name ?? 'Household';
  if (error) return <p className="field-error">{error}</p>;
  if (!history) return <p role="status">Loading history…</p>;
  if (!history.length) return <p>Nothing recorded yet.</p>;
  return (
    <ul>
      {history.map((item) => (
        <li key={`${item.dueAt}:${item.outcome}`}>
          {item.dueAt ? `Due ${when(item.dueAt)} · ` : ''}
          {item.outcome === 'missed'
            ? 'Missed'
            : `Completed by ${person(item.completedBy ?? '')}${item.completedAt ? ` on ${when(item.completedAt)}` : ' (time not recorded)'}`}
        </li>
      ))}
    </ul>
  );
}

function SummarySettings({
  preferences,
  busy,
  onSave,
}: {
  preferences: Preferences;
  busy: boolean;
  onSave: (value: Omit<Preferences, 'revision'>) => void;
}) {
  const [value, setValue] = useState(preferences);
  const dirty = JSON.stringify(value) !== JSON.stringify(preferences);
  useEffect(() => {
    setValue(preferences);
  }, [preferences.revision]);
  return (
    <Card className="settings-card">
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          const { revision: _, ...next } = value;
          onSave(next);
        }}
      >
        <h2>A moment, twice a day.</h2>
        <p className="muted">
          Choose when you’d like a little overview. Switch either summary off whenever you like.
        </p>
        {(['morning', 'evening'] as const).map((key) => (
          <div className="summary-setting" key={key}>
            <span className={`overview-icon ${key === 'morning' ? 'peach' : 'purple'}`}>
              {key === 'morning' ? <Sun size={22} /> : <Sunset size={22} />}
            </span>
            <div>
              <strong>{key === 'morning' ? 'Morning summary' : 'Evening summary'}</strong>
              <small>
                {key === 'morning'
                  ? 'What’s ahead, and what needs a follow-up.'
                  : 'A look at what’s still on your plate.'}
              </small>
            </div>
            <Label className="switch-target" htmlFor={`summary-${key}`}>
              <span className="sr-only">Enable {key} summary</span>
              <Switch
                id={`summary-${key}`}
                checked={value[key].enabled}
                onCheckedChange={(enabled) =>
                  setValue({ ...value, [key]: { ...value[key], enabled } })
                }
              />
            </Label>
            <Input
              className="summary-time"
              aria-label={`${key} summary time`}
              type="time"
              required
              value={value[key].time}
              disabled={!value[key].enabled}
              onChange={(event) =>
                setValue({ ...value, [key]: { ...value[key], time: event.target.value } })
              }
            />
          </div>
        ))}
        <Label className="timezone-label">
          Your time zone
          <Input
            value={value.timezone}
            required
            onChange={(event) => setValue({ ...value, timezone: event.target.value })}
            list="timezones"
          />
          <datalist id="timezones">
            <option value="Asia/Dubai" />
            <option value="Europe/London" />
            <option value="Asia/Kolkata" />
            <option value="America/New_York" />
          </datalist>
        </Label>
        <div className="settings-actions">
          <span className="small muted">Changes are previewed before saving.</span>
          <Button variant="default" disabled={busy || !dirty}>
            Review settings
            <ArrowRight size={15} />
          </Button>
        </div>
      </form>
    </Card>
  );
}

function AppearanceSettings() {
  const [appearance, setAppearance] = useState(savedAppearance);
  return (
    <Card className="settings-card">
      <h2>
        <SunMoon size={19} /> Appearance
      </h2>
      <Label className="timezone-label">
        Light or dark
        <NativeSelect
          value={appearance}
          onChange={(event) => {
            const next = event.target.value as Appearance;
            setAppearance(next);
            saveAppearance(next);
          }}
        >
          <option value="system">Match this device</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </NativeSelect>
      </Label>
      <p className="small muted">This choice is saved on this device only.</p>
    </Card>
  );
}

function PushSettings({ onError }: { onError: (message: string) => void }) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const enabled =
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    window.isSecureContext;
  return (
    <>
      <Button
        variant="outline"

        disabled={busy || !enabled}
        onClick={async () => {
          setBusy(true);
          try {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted')
              throw new Error(
                'Notifications were not enabled. You can change this in your device settings.',
              );
            const registration = await navigator.serviceWorker.ready;
            const { publicKey } = await api<{ publicKey: string }>('/push/key');
            const key = Uint8Array.from(
              atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')),
              (c) => c.charCodeAt(0),
            );
            const subscription =
              (await registration.pushManager.getSubscription()) ??
              (await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: key,
              }));
            await api('/push/subscription', subscription.toJSON());
            setStatus('Notifications are enabled on this device.');
          } catch (problem) {
            onError((problem as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Bell size={16} />
        {busy ? 'Enabling…' : 'Enable on this device'}
      </Button>
      <p className="small muted" role="status">
        {status ||
          (!enabled
            ? 'On iPhone, add this app to your Home Screen and open it over HTTPS to enable notifications.'
            : 'You’ll be asked for notification permission.')}
      </p>
    </>
  );
}

followSystemAppearance();
if ('serviceWorker' in navigator)
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
createRoot(document.getElementById('root')!).render(<App />);
