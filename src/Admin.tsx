import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, CalendarDays, LogOut, MessageCircle, ShieldCheck, Users } from 'lucide-react';
import { api } from './api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';

type Session = { signedIn: boolean; development: boolean; unavailable: string | null };
type AdminState = {
  people: { id: string; name: string; email: string }[];
  /** The email Cloudflare Access verified for this request, if any. */
  access: string | null;
  ai: { connected: boolean; model: string | null };
  calendar: { status: string; name: string | null; account: string | null; error: string | null };
};

/** Run one admin action, showing its error in place. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    void work()
      .catch((problem) => setError((problem as Error).message))
      .finally(() => setBusy(false));
  };
  const message = error && (
    <p className="field-error" role="alert">
      {error}
    </p>
  );
  return { busy, run, message };
}

/**
 * The admin page at /admin: its own sign-in with the ADMIN_TOKEN Worker
 * secret, then the settings the admin makes for both people.
 */
export function AdminApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const current = await api<Session>('/admin/session');
      setSession(current);
      setState(current.signedIn ? await api<AdminState>('/admin/state') : null);
      setError('');
    } catch (problem) {
      setError((problem as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <main className="admin-page">
      <header className="admin-header">
        <h1>
          <ShieldCheck size={22} /> Admin
        </h1>
        <a href="/">
          Open the app <ArrowRight size={16} />
        </a>
      </header>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {!session ? (
        !error && <p role="status">Loading…</p>
      ) : !session.signedIn ? (
        <AdminSignIn session={session} onSignedIn={refresh} />
      ) : (
        state && (
          <>
            {!session.development && <AccessCheck state={state} />}
            <PeopleSettings state={state} onSaved={refresh} />
            <CalendarSettings state={state} onChanged={refresh} />
            <AssistantSettings state={state} onChanged={refresh} />
            {!session.development && (
              <Button
                variant="ghost"
                className="logout"
                onClick={() => void api('/admin/session', undefined, 'DELETE').then(refresh)}
              >
                <LogOut size={16} /> Sign out of admin
              </Button>
            )}
          </>
        )
      )}
    </main>
  );
}

function AdminSignIn({ session, onSignedIn }: { session: Session; onSignedIn: () => void }) {
  const { busy, run, message } = useAction();
  return (
    <Card className="settings-card">
      <h2>Sign in as the admin</h2>
      {session.unavailable ? (
        <p className="muted" role="alert">
          {session.unavailable}
        </p>
      ) : (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            const token = String(new FormData(event.currentTarget).get('token'));
            run(async () => {
              await api('/admin/session', { token });
              onSignedIn();
            });
          }}
        >
          <Label>
            Admin token
            <Input name="token" type="password" autoComplete="current-password" required />
          </Label>
          <p className="small muted">The ADMIN_TOKEN secret on the Worker.</p>
          {message}
          <Button type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      )}
    </Card>
  );
}

/** Whether Cloudflare Access reached the app on this request, and as whom. */
function AccessCheck({ state }: { state: AdminState }) {
  const known = state.people.some((person) => person.email === state.access);
  return (
    <Card className="settings-card">
      <h2>
        <ShieldCheck size={19} /> Cloudflare Access
      </h2>
      <p className="muted">
        {!state.access
          ? 'No Access sign-in reached the app on this request, so the app turns everyone away. Check that Access is on for this Worker (Settings → Domains & Routes).'
          : known
            ? `Access signed you in as ${state.access}.`
            : `Access signed you in as ${state.access}, which is not one of the two people’s emails below, so the app turns it away.`}
      </p>
    </Card>
  );
}

/** Both people's names and the emails Cloudflare Access lets in. */
function PeopleSettings({ state, onSaved }: { state: AdminState; onSaved: () => void }) {
  const { busy, run, message } = useAction();
  const blank = { name: '', email: '' };
  const [people, setPeople] = useState(() =>
    [0, 1].map((index) => {
      const person = state.people[index];
      return person ? { name: person.name, email: person.email } : blank;
    }),
  );
  const update = (index: number, value: Partial<typeof blank>) =>
    setPeople(people.map((person, at) => (at === index ? { ...person, ...value } : person)));
  return (
    <Card className="settings-card">
      <h2>
        <Users size={19} /> The two of you
      </h2>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          run(async () => {
            await api(
              '/admin/people',
              {
                people: people.map((person) => ({
                  name: person.name,
                  ...(person.email.trim() ? { email: person.email } : {}),
                })),
              },
              'PUT',
            );
            onSaved();
          });
        }}
      >
        {people.map((person, index) => (
          <fieldset key={index} className="form">
            <legend>{index === 0 ? 'First person' : 'Second person'}</legend>
            <Label>
              Name
              <Input
                value={person.name}
                onChange={(event) => update(index, { name: event.target.value })}
                required
                maxLength={60}
                autoComplete="off"
              />
            </Label>
            <Label>
              Email
              <Input
                type="email"
                value={person.email}
                onChange={(event) => update(index, { email: event.target.value })}
                autoComplete="off"
              />
            </Label>
          </fieldset>
        ))}
        <p className="small muted">
          Each person signs in with this email, which Cloudflare Access must allow too. Changing a
          name or email keeps that person’s tasks and messages.
        </p>
        {message}
        <Button type="submit" variant="outline" disabled={busy}>
          Save the two of you
        </Button>
      </form>
    </Card>
  );
}

/**
 * The shared iCloud calendar: an Apple ID and an app-specific password, then
 * one of the account's calendars. The password is sent once and never shown.
 */
function CalendarSettings({ state, onChanged }: { state: AdminState; onChanged: () => void }) {
  const { busy, run, message } = useAction();
  const [account, setAccount] = useState({ username: '', password: '' });
  const [calendars, setCalendars] = useState<{ name: string; url: string }[] | null>(null);
  const [chosen, setChosen] = useState('');
  const { calendar } = state;
  return (
    <Card className="settings-card">
      <h2>
        <CalendarDays size={19} /> Shared calendar
      </h2>
      {calendar.account ? (
        <>
          <p className="muted">
            Connected to {calendar.name} as {calendar.account}.
            {calendar.status === 'error' && calendar.error ? ` ${calendar.error}` : ''}
          </p>
          {message}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api('/admin/calendar', undefined, 'DELETE');
                onChanged();
              })
            }
          >
            Disconnect
          </Button>
        </>
      ) : (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              if (!calendars) {
                const found = await api<{ calendars: { name: string; url: string }[] }>(
                  '/admin/calendar',
                  account,
                );
                setCalendars(found.calendars);
                setChosen(
                  (found.calendars.find((item) => item.name === 'Household') ?? found.calendars[0])
                    ?.url ?? '',
                );
                return;
              }
              await api('/admin/calendar', { ...account, calendarUrl: chosen });
              setAccount({ username: '', password: '' });
              setCalendars(null);
              onChanged();
            });
          }}
        >
          <p className="muted">
            Sign in with the Apple ID that shares your calendar and an{' '}
            <a href="https://account.apple.com/account/manage" target="_blank" rel="noreferrer">
              app-specific password
            </a>
            , never the Apple ID password.
          </p>
          <Label>
            Apple ID
            <Input
              type="email"
              autoComplete="off"
              required
              value={account.username}
              disabled={Boolean(calendars)}
              onChange={(event) => setAccount({ ...account, username: event.target.value })}
            />
          </Label>
          <Label>
            App-specific password
            <Input
              type="password"
              autoComplete="off"
              required
              value={account.password}
              disabled={Boolean(calendars)}
              onChange={(event) => setAccount({ ...account, password: event.target.value })}
            />
          </Label>
          {calendars && (
            <Label>
              Calendar
              <NativeSelect value={chosen} onChange={(event) => setChosen(event.target.value)}>
                {calendars.map((item) => (
                  <option key={item.url} value={item.url}>
                    {item.name}
                  </option>
                ))}
              </NativeSelect>
            </Label>
          )}
          {message}
          <Button type="submit" disabled={busy || (calendars !== null && !chosen)}>
            {calendars ? 'Connect calendar' : 'Find calendars'}
          </Button>
        </form>
      )}
    </Card>
  );
}

/** The ChatGPT connection and the model the assistant uses. */
function AssistantSettings({ state, onChanged }: { state: AdminState; onChanged: () => void }) {
  return (
    <Card className="settings-card">
      <h2>
        <MessageCircle size={19} /> Assistant
      </h2>
      {state.ai.connected ? (
        <>
          <p className="muted">
            ChatGPT is connected.{' '}
            {state.ai.model ? `The assistant uses ${state.ai.model}.` : 'Choose its model.'}
          </p>
          <ModelChooser current={state.ai.model} onSaved={onChanged} />
        </>
      ) : (
        <p className="muted">
          Connect ChatGPT from the Mac: run npm run ai:connect -- --production, then npm run
          secrets.
        </p>
      )}
    </Card>
  );
}

/** Pick the assistant's model from the connected account's catalog. */
function ModelChooser({ current, onSaved }: { current: string | null; onSaved: () => void }) {
  const { busy, run, message } = useAction();
  const [models, setModels] = useState<{ id: string; name: string }[] | null>(null);
  const [chosen, setChosen] = useState(current ?? '');
  return (
    <div className="form">
      {models ? (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              await api('/admin/model', { id: chosen });
              onSaved();
            });
          }}
        >
          <Label>
            Model
            <NativeSelect value={chosen} onChange={(event) => setChosen(event.target.value)}>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </NativeSelect>
          </Label>
          <Button type="submit" variant="outline" disabled={busy || chosen === current}>
            Use this model
          </Button>
        </form>
      ) : (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const catalog = await api<{
                current: string | null;
                models: { id: string; name: string }[];
              }>('/admin/models');
              setModels(catalog.models);
              setChosen(catalog.current ?? catalog.models[0]?.id ?? '');
            })
          }
        >
          {current ? 'Change the model' : 'Choose the model'}
        </Button>
      )}
      {message}
    </div>
  );
}
