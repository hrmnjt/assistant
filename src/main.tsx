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
  MoreHorizontal,
  Plus,
  Repeat2,
  Send,
  Settings,
  Sun,
  Sunset,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type {
  CalendarEvent,
  Category,
  Message,
  Mutation,
  Preferences,
  Preview,
  Snapshot,
  Task,
} from './types';
import { CalendarCard, CalendarView, EventForm } from './Calendar';
import './styles.css';

async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Household-Client': '1' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(value.error || 'Unable to reach the household server.'), {
      status: response.status,
    });
  return value;
}

function Modal({
  title,
  close,
  children,
  inactive = false,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
  inactive?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const titleId = React.useId();
  useEffect(() => {
    if (inactive) return;
    const before = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.querySelector<HTMLElement>('input, button, select, textarea')?.focus();
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const focusable = [
        ...element.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, select, textarea, a[href]',
        ),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('keydown', keyboard);
      before?.focus();
    };
  }, [inactive]);
  return (
    <div
      className="scrim"
      style={inactive ? { display: 'none' } : undefined}
      aria-hidden={inactive || undefined}
    >
      <div
        className="dialog"
        ref={dialog}
        role="dialog"
        aria-modal={!inactive}
        aria-labelledby={titleId}
      >
        <div className="dialog-heading">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" onClick={close} aria-label="Close dialog">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function App() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(true);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<'today' | 'tasks' | 'calendar' | 'chat' | 'settings'>('today');
  const [filter, setFilter] = useState<'mine' | 'household' | 'all'>('mine');
  const [taskForm, setTaskForm] = useState<Task | 'new' | null>(null);
  const [eventForm, setEventForm] = useState<CalendarEvent | 'new' | null>(null);
  const [threadForm, setThreadForm] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewRetryable, setPreviewRetryable] = useState(true);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const lastTyping = useRef(0);
  const clientId = useRef(crypto.randomUUID());
  const draftValue = useRef(draft);
  draftValue.current = draft;
  const messageRequest = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const value = await api<Snapshot>('/state');
      setState(value);
      setConnected(true);
    } catch (problem) {
      if ((problem as { status?: number }).status === 401) setState(null);
      else setConnected(false);
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
  const act = useCallback(async (mutation: Mutation) => {
    setBusy(true);
    setError('');
    setPreviewError('');
    setPreviewRetryable(true);
    try {
      setPreview(await api<Preview>('/previews', mutation));
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  const cancelPreview = useCallback(() => {
    if (busy || !preview) return;
    setBusy(true);
    void api(`/previews/${preview.id}`, undefined, 'DELETE')
      .then(() => {
        setPreview(null);
        setPreviewError('');
      })
      .catch((problem) => {
        setPreviewError((problem as Error).message);
        setPreviewRetryable(true);
      })
      .finally(() => setBusy(false));
  }, [preview, busy]);
  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setPreviewError('');
    try {
      const result = await api<{ targetId: string }>(`/previews/${preview.id}/confirm`, {});
      if (threadForm) setThreadId(result.targetId);
      setPreview(null);
      setTaskForm(null);
      setEventForm(null);
      setThreadForm(false);
      await refresh();
    } catch (problem) {
      setPreviewError((problem as Error).message);
      setPreviewRetryable(((problem as { status?: number }).status ?? 500) >= 500);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!state?.me.id) return;
    const active = page === 'chat' ? threadId : null;
    const beat = () =>
      void api('/presence', {
        threadId: document.hidden ? null : active,
        clientId: clientId.current,
        typing: Boolean(draftValue.current) && Date.now() - lastTyping.current < 8000,
      }).catch(() => undefined);
    beat();
    const timer = setInterval(beat, 10_000);
    document.addEventListener('visibilitychange', beat);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', beat);
      void api('/presence', { threadId: null, clientId: clientId.current, typing: false }).catch(
        () => undefined,
      );
    };
  }, [page, threadId, state?.me.id]);
  useEffect(() => {
    setDraft('');
    messageRequest.current = null;
    setMessages([]);
    if (page !== 'chat' || !threadId || !state?.me.id) return;
    let active = true;
    const read = async () => {
      try {
        const value = await api<Message[]>(`/threads/${threadId}/messages`);
        if (active) setMessages(value);
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
  }, [page, threadId, state?.me.id]);

  if (loading)
    return (
      <div className="boot">
        <Leaf size={32} />
        <p>Finding our place…</p>
      </div>
    );
  if (!state) return <Login onLogin={refresh} />;
  const zone = state.preferences.timezone;
  const now = DateTime.now().setZone(zone);
  const person = (id: string) =>
    state.people.find((person) => person.id === id)?.name || 'Household';
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
  const navigation = [
    { id: 'today', title: 'Today', icon: Home },
    { id: 'tasks', title: 'Tasks', icon: ClipboardList },
    { id: 'calendar', title: 'Calendar', icon: CalendarDays },
    { id: 'chat', title: 'Conversations', icon: MessageCircle },
    { id: 'settings', title: 'Settings', icon: Settings },
  ] as const;
  const filters = (
    <div className="segments" aria-label="Task view">
      {(['mine', 'household', 'all'] as const).map((value) => (
        <button
          key={value}
          aria-pressed={filter === value}
          className={filter === value ? 'selected' : ''}
          onClick={() => setFilter(value)}
        >
          {value === 'mine' ? 'For me' : value === 'household' ? 'Household' : 'Everything'}
        </button>
      ))}
    </div>
  );
  const rows = (tasks: Task[]) =>
    tasks.length ? (
      <div className="task-list">
        {tasks.map((task) => (
          <article className="task-row" key={task.id}>
            <button
              className="complete-button"
              disabled={busy || !connected}
              onClick={() =>
                void act({ kind: 'task.complete', id: task.id, revision: task.revision })
              }
              aria-label={`Review completion of ${task.title}`}
            >
              <Circle size={23} />
            </button>
            <div className="task-content">
              <button className="task-title" onClick={() => setTaskForm(task)}>
                {task.title}
              </button>
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
                <details className="missed">
                  <summary>
                    Missed {task.missedDates.length}{' '}
                    {task.missedDates.length === 1 ? 'time' : 'times'}
                  </summary>
                  <ul>
                    {task.missedDates.map((date) => (
                      <li key={date}>
                        {DateTime.fromISO(date).setZone(zone).toFormat('d LLL yyyy, HH:mm')}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <button
              className="icon-button more-task"
              onClick={() => setTaskForm(task)}
              aria-label={`Edit ${task.title}`}
            >
              <MoreHorizontal size={20} />
            </button>
          </article>
        ))}
      </div>
    ) : (
      <Empty
        icon={<CheckCheck size={28} />}
        title="A little breathing room"
        text="Nothing here needs your attention. Add a task whenever something comes to mind."
      />
    );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            setPage('today');
          }}
        >
          <span className="brand-mark">
            <Leaf size={22} />
          </span>
          our day<span className="brand-dot">.</span>
        </a>
        <div className="sidebar-label">A LITTLE LESS TO REMEMBER</div>
        <nav>
          {navigation.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? 'nav-active' : ''}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={19} />
              <span>{item.title}</span>
              {item.id === 'tasks' && <small>{open.length}</small>}
            </button>
          ))}
        </nav>
        <div className="household-note">
          <Users size={19} />
          <strong>Better, together.</strong>
          <p>A shared place for the things that make a home.</p>
          <div className="avatar-stack">
            {state.people.map((p) => (
              <span className={`avatar ${p.id}`} key={p.id} title={p.name}>
                {p.name[0]}
              </span>
            ))}
          </div>
        </div>
        <button className="account" onClick={() => setPage('settings')}>
          <span className={`avatar ${state.me.id}`}>{state.me.name[0]}</span>
          <span>
            {state.me.name}
            <small>Your household</small>
          </span>
          <ChevronRight size={16} />
        </button>
      </aside>
      <main>
        <header className="topbar">
          <span>
            <span className="status-dot" /> Your household
          </span>
          <div>
            <span className="top-date">{now.toFormat('cccc, d LLL')}</span>
            <button
              className="icon-button"
              aria-label="View daily summaries"
              onClick={() => setPage('settings')}
            >
              <Bell size={19} />
            </button>
            <span className={`avatar ${state.me.id}`}>{state.me.name[0]}</span>
          </div>
        </header>
        {!connected && (
          <div className="connection-banner" role="status">
            Connection lost. Showing the last loaded view; reconnect before making changes.
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error">
              <X size={16} />
            </button>
          </div>
        )}
        <div className={`page ${page === 'chat' ? 'chat-page' : ''}`}>
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
                <button
                  className="primary"
                  onClick={() => setTaskForm('new')}
                  disabled={!connected}
                >
                  <Plus size={17} /> Add task
                </button>
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
                <section className="card focus-card">
                  <div className="section-heading">
                    <div>
                      <span className="eyebrow">ONE THING AT A TIME</span>
                      <h2>Your focus today</h2>
                    </div>
                    <button className="text-button" onClick={() => setPage('tasks')}>
                      All tasks <ArrowRight size={15} />
                    </button>
                  </div>
                  {filters}
                  {rows(today)}
                </section>
                <aside className="day-aside">
                  <CalendarCard
                    calendar={state.calendar}
                    zone={zone}
                    open={() => setPage('calendar')}
                  />
                  <section className="summary-card">
                    <Sunset size={24} />
                    <h3>A moment to reset.</h3>
                    <p>
                      {state.preferences.evening.enabled
                        ? `Your evening summary is set for ${state.preferences.evening.time}.`
                        : 'Your evening summary is switched off.'}
                    </p>
                    <button className="text-button" onClick={() => setPage('settings')}>
                      Make it yours <ArrowRight size={14} />
                    </button>
                  </section>
                </aside>
              </div>
              <section className="conversation-strip">
                <MessageCircle size={23} />
                <div>
                  <h3>Keep the conversation going.</h3>
                  <p>Household plans, work, or something just for you. A topic for each.</p>
                </div>
                <button className="secondary" onClick={() => setPage('chat')}>
                  Open conversations <ArrowRight size={15} />
                </button>
              </section>
            </>
          )}
          {page === 'tasks' && (
            <>
              <div className="eyebrow">A PLACE FOR EVERYTHING</div>
              <div className="page-heading">
                <div>
                  <h1>A little less on your mind.</h1>
                  <p>One owner for the follow-up. Either of you can lend a hand.</p>
                </div>
                <button
                  className="primary"
                  onClick={() => setTaskForm('new')}
                  disabled={!connected}
                >
                  <Plus size={17} /> Add task
                </button>
              </div>
              <section className="card full-card">
                <div className="section-heading">
                  <h2>
                    Open tasks <span className="count">{selected.length}</span>
                  </h2>
                  {filters}
                </div>
                {rows(selected)}
              </section>
              {state.tasks.some((t) => t.status === 'completed') && (
                <details className="completed-section">
                  <summary>
                    Completed tasks · {state.tasks.filter((t) => t.status === 'completed').length}
                  </summary>
                  {relevant(state.tasks.filter((t) => t.status === 'completed')).map((task) => (
                    <div className="completed-row" key={task.id}>
                      <Check size={16} />
                      <span>{task.title}</span>
                      <small>{person(task.completedBy || '')}</small>
                    </div>
                  ))}
                </details>
              )}
            </>
          )}
          {page === 'chat' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">ROOM FOR EVERY TOPIC</div>
                  <h1>Conversations.</h1>
                  <p>Shared conversations, with a little space between them.</p>
                </div>
                <button
                  className="primary"
                  onClick={() => setThreadForm(true)}
                  disabled={!connected}
                >
                  <Plus size={17} /> New topic
                </button>
              </div>
              <div className={`conversation-layout ${thread ? 'thread-open' : ''}`}>
                <section className="card thread-list">
                  {state.threads.length ? (
                    state.threads.map((topic) => {
                      const active = state.presence.filter(
                        (p) => p.threadId === topic.id && p.userId !== state.me.id,
                      );
                      return (
                        <button
                          className={`thread-item ${threadId === topic.id ? 'active' : ''}`}
                          key={topic.id}
                          onClick={() => setThreadId(topic.id)}
                        >
                          <MessageCircle size={19} />
                          <div>
                            <strong>{topic.title}</strong>
                            <small>{topic.category}</small>
                          </div>
                          {active.length > 0 && (
                            <span
                              className="presence-indicator"
                              title={active
                                .map(
                                  (p) => `${person(p.userId)} is ${p.typing ? 'typing' : 'here'}`,
                                )
                                .join(', ')}
                              aria-label={active
                                .map(
                                  (p) => `${person(p.userId)} is ${p.typing ? 'typing' : 'here'}`,
                                )
                                .join(', ')}
                            >
                              <span className="status-dot" />
                              <Users size={15} />
                            </span>
                          )}
                        </button>
                      );
                    })
                  ) : (
                    <Empty
                      icon={<MessageCircle size={25} />}
                      title="Start a topic"
                      text="Give household plans or personal projects a place to live."
                    />
                  )}
                </section>
                <section className="card conversation-content">
                  {thread ? (
                    <>
                      <div className="thread-heading">
                        <button
                          className="icon-button mobile-back"
                          onClick={() => setThreadId(null)}
                          aria-label="Back to topics"
                        >
                          <ArrowLeft size={19} />
                        </button>
                        <div>
                          <h2>{thread.title}</h2>
                          <span className="small muted">Shared with your household</span>
                        </div>
                      </div>
                      <div className="ai-status">
                        <span className="status-dot pending" /> AI connection pending. Messages here
                        are shared between you two.
                      </div>
                      <div className="messages" aria-live="polite">
                        {messages.length ? (
                          messages.map((message) => (
                            <article
                              className={`message ${message.authorId === state.me.id ? 'mine' : ''}`}
                              key={message.id}
                            >
                              <div>
                                <strong>{person(message.authorId)}</strong>
                                <time>
                                  {DateTime.fromISO(message.createdAt)
                                    .setZone(zone)
                                    .toFormat('HH:mm')}
                                </time>
                              </div>
                              <p>{message.text}</p>
                            </article>
                          ))
                        ) : (
                          <div className="quiet-message">
                            <Leaf size={26} />
                            <p>
                              A fresh conversation.
                              <br />
                              What’s on your mind?
                            </p>
                          </div>
                        )}
                      </div>
                      <div className="typing-status">
                        {state.presence
                          .filter((p) => p.threadId === thread.id && p.userId !== state.me.id)
                          .map((p) => `${person(p.userId)} is ${p.typing ? 'typing…' : 'here'}`)
                          .join(' · ')}
                      </div>
                      <form
                        className="composer"
                        onSubmit={async (event) => {
                          event.preventDefault();
                          if (!draft.trim() || busy) return;
                          setBusy(true);
                          setError('');
                          try {
                            const requestId = messageRequest.current ?? crypto.randomUUID();
                            messageRequest.current = requestId;
                            await api(`/threads/${thread.id}/messages`, {
                              text: draft.trim(),
                              requestId,
                            });
                            messageRequest.current = null;
                            setDraft('');
                            setMessages(await api<Message[]>(`/threads/${thread.id}/messages`));
                          } catch (problem) {
                            setError((problem as Error).message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        <textarea
                          aria-label="Message"
                          placeholder="Leave a thought…"
                          value={draft}
                          onChange={(event) => {
                            setDraft(event.target.value);
                            lastTyping.current = Date.now();
                            messageRequest.current = null;
                          }}
                          rows={2}
                        />
                        <button
                          className="send-button"
                          type="submit"
                          aria-label="Send message"
                          disabled={busy || !connected || !draft.trim()}
                        >
                          <Send size={18} />
                        </button>
                      </form>
                    </>
                  ) : (
                    <Empty
                      icon={<MessageCircle size={30} />}
                      title="A topic for each part of life"
                      text="Choose a conversation, or start a new one together."
                    />
                  )}
                </section>
              </div>
            </>
          )}
          {page === 'calendar' && (
            <CalendarView
              calendar={state.calendar}
              zone={zone}
              busy={busy || !connected}
              onNew={() => setEventForm('new')}
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
                  <p>These settings are just for {state.me.name}. Your partner sets their own.</p>
                </div>
              </div>
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
              <section className="card settings-card">
                <h2>
                  <Bell size={19} /> Phone notifications
                </h2>
                <p className="muted">
                  Task deadlines and daily summaries, even when the app is closed.
                </p>
                <PushSettings onError={setError} />
                <p className="small muted">
                  Appointment alerts will come from both Apple Calendar and this app after calendar
                  integration.
                </p>
              </section>
              <section className="card settings-card">
                <h2>Recent reminders</h2>
                {state.notices.length ? (
                  state.notices.map((notice) => (
                    <div className="notice" key={notice.id}>
                      <strong>{notice.title}</strong>
                      <p>{notice.body}</p>
                      <time>
                        {DateTime.fromISO(notice.createdAt).setZone(zone).toFormat('d LLL, HH:mm')}
                      </time>
                    </div>
                  ))
                ) : (
                  <p className="muted">Your summaries and deadline reminders will appear here.</p>
                )}
              </section>
              <button
                className="text-button logout"
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
                    await api('/logout', {});
                    setState(null);
                  } catch (problem) {
                    setError((problem as Error).message);
                  }
                }}
              >
                <LogOut size={17} /> Sign out
              </button>
            </>
          )}
        </div>
        <footer className="page-footer">
          <Leaf size={13} /> A little less to remember. A little more together.
        </footer>
      </main>
      <nav className="mobile-nav" aria-label="Main navigation">
        {navigation.map((item) => (
          <button
            className={page === item.id ? 'active' : ''}
            key={item.id}
            onClick={() => setPage(item.id)}
          >
            <item.icon size={21} />
            <span>{item.id === 'chat' ? 'Chat' : item.title}</span>
          </button>
        ))}
      </nav>
      {taskForm && (
        <Modal
          inactive={Boolean(preview)}
          title={taskForm === 'new' ? 'A new task' : 'Edit task'}
          close={() => setTaskForm(null)}
        >
          <TaskForm
            task={taskForm === 'new' ? undefined : taskForm}
            state={state}
            busy={busy || !connected}
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
          <EventForm
            event={eventForm === 'new' ? undefined : eventForm}
            zone={zone}
            busy={busy || !connected || state.calendar.status !== 'connected'}
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
        <Modal inactive={Boolean(preview)} title="A new topic" close={() => setThreadForm(false)}>
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
            <label>
              What’s the topic?
              <input name="title" required maxLength={120} placeholder="Weekend plans" />
            </label>
            <label>
              Space
              <select name="category">
                <option value="household">Household</option>
                <option value="work">Work</option>
                <option value="personal">Personal</option>
              </select>
            </label>
            <p className="small muted">Both of you can see and join this conversation.</p>
            <button className="primary" disabled={busy || !connected}>
              Review topic <ArrowRight size={15} />
            </button>
          </form>
        </Modal>
      )}
      {preview && (
        <Modal title={preview.title} close={cancelPreview}>
          <div className="preview-details">
            {preview.details.map((detail, index) => (
              <div key={index}>
                <span>{detail.label}</span>
                <p>
                  {detail.before !== undefined && detail.before !== detail.after && (
                    <del>{formatDetail(detail.before, detail.label, zone)}</del>
                  )}
                  <strong>{formatDetail(detail.after, detail.label, zone)}</strong>
                </p>
              </div>
            ))}
          </div>
          {previewError && (
            <p className="field-error" role="alert">
              {previewError}
            </p>
          )}
          <p className="small muted">Nothing changes until you confirm.</p>
          <div className="dialog-actions">
            <button className="secondary" onClick={cancelPreview} disabled={busy}>
              Go back
            </button>
            <button
              className="primary"
              onClick={() => void confirm()}
              disabled={busy || !connected || (Boolean(previewError) && !previewRetryable)}
            >
              <Check size={16} />
              {busy ? 'Saving…' : 'Confirm change'}
            </button>
          </div>
        </Modal>
      )}
    </div>
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

function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
        <span className="small">Made for your household.</span>
      </div>
      <section className="login-form">
        <div className="mobile-brand brand">
          <Leaf size={26} /> our day.
        </div>
        <div className="eyebrow">WELCOME HOME</div>
        <h2>Your day starts here.</h2>
        <p className="muted">Sign in to your household.</p>
        <form
          className="form"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            const data = new FormData(event.currentTarget);
            try {
              await api('/login', {
                username: data.get('username'),
                password: data.get('password'),
              });
              await onLogin();
            } catch (problem) {
              setError((problem as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Username
            <input name="username" autoComplete="username" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Come on in'}
            <ArrowRight size={17} />
          </button>
        </form>
        <p className="small muted login-footnote">Your own view. Your shared household.</p>
      </section>
    </div>
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
      <label>
        What needs doing?
        <input
          name="title"
          required
          maxLength={200}
          defaultValue={task?.title}
          placeholder="Something to take off your mind"
        />
      </label>
      <div className="form-pair">
        <label>
          Follow-up owner
          <select name="ownerId" defaultValue={task?.ownerId ?? state.me.id}>
            {state.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Space
          <select name="category" defaultValue={task?.category ?? 'household'}>
            <option value="household">Household</option>
            <option value="work">Work</option>
            <option value="personal">Personal</option>
          </select>
        </label>
      </div>
      <label>
        Due date & time <span className="optional">optional · {state.preferences.timezone}</span>
        <input
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
      </label>
      <label>
        Repeat
        <select name="schedule" defaultValue={task?.schedule?.frequency ?? 'once'}>
          <option value="once">Just this once</option>
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
        </select>
      </label>
      <label>
        Anything else? <span className="optional">optional</span>
        <textarea name="notes" rows={3} maxLength={5000} defaultValue={task?.notes} />
      </label>
      <p className="small muted">Either of you can help or mark this task complete.</p>
      <div className="dialog-actions">
        {onDelete && (
          <button className="text-button danger" type="button" onClick={onDelete} disabled={busy}>
            <Trash2 size={16} /> Delete
          </button>
        )}
        <button className="primary" disabled={busy}>
          Review {task ? 'changes' : 'task'}
          <ArrowRight size={15} />
        </button>
      </div>
    </form>
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
    <form
      className="card settings-card"
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
          <label className="switch">
            <input
              type="checkbox"
              aria-label={`Enable ${key} summary`}
              checked={value[key].enabled}
              onChange={(event) =>
                setValue({ ...value, [key]: { ...value[key], enabled: event.target.checked } })
              }
            />
            <span />
          </label>
          <input
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
      <label className="timezone-label">
        Your time zone
        <input
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
      </label>
      <div className="settings-actions">
        <span className="small muted">Changes are previewed before saving.</span>
        <button className="primary" disabled={busy || !dirty}>
          Review settings
          <ArrowRight size={15} />
        </button>
      </div>
    </form>
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
      <button
        className="secondary"
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
      </button>
      <p className="small muted" role="status">
        {status ||
          (!enabled
            ? 'On iPhone, add this app to your Home Screen and open it over HTTPS to enable notifications.'
            : 'You’ll be asked for notification permission.')}
      </p>
    </>
  );
}

if ('serviceWorker' in navigator)
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
createRoot(document.getElementById('root')!).render(<App />);
