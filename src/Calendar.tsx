import { lazy, Suspense, useState } from 'react';
import { DateTime } from 'luxon';
import { ArrowRight, CalendarDays, MapPin, Plus, RefreshCw, Repeat2, Trash2 } from 'lucide-react';
import type { CalendarEvent, CalendarFields, CalendarSnapshot } from './types';
import { eventsForDay } from './calendar-days';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/native-select';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

const MonthCalendar = lazy(() => import('./MonthCalendar'));

export function CalendarCard({
  calendar,
  zone,
  open,
}: {
  calendar: CalendarSnapshot;
  zone: string;
  open: () => void;
}) {
  const now = DateTime.now().setZone(zone);
  const next = calendar.events.find((event) => DateTime.fromISO(event.end, { zone }) >= now);
  return (
    <Card className="calendar-card">
      <div className="section-heading">
        <h2>
          <CalendarDays size={18} /> Shared calendar
        </h2>
        <Badge variant="secondary">iCloud</Badge>
      </div>
      <div className="calendar-date">
        <strong>{now.day}</strong>
        <span>
          {now.toFormat('LLLL')}
          <small>{now.toFormat('cccc')}</small>
        </span>
      </div>
      {calendar.status === 'not-connected' ? (
        <>
          <p className="muted">Waiting for the iCloud connection.</p>
          <p className="small">
            Your household appointments will appear here once the owner finishes setup.
          </p>
        </>
      ) : (
        <>
          <p className="calendar-next-title">{next?.title ?? 'A little space in the calendar.'}</p>
          {next && <p className="small">{eventTime(next, zone)}</p>}
          {calendar.status === 'error' && (
            <Alert className="calendar-warning">
              <AlertDescription>Calendar is out of date. Refresh before editing.</AlertDescription>
            </Alert>
          )}
          <Button variant="ghost" onClick={open}>
            Open calendar <ArrowRight size={14} />
          </Button>
        </>
      )}
    </Card>
  );
}

export function eventTime(event: CalendarEvent, zone: string) {
  const start = DateTime.fromISO(event.start, { zone }).setZone(zone);
  return event.allDay
    ? `${start.toFormat('ccc, d LLL')} · All day`
    : start.toFormat('ccc, d LLL · HH:mm');
}

export function CalendarView({
  calendar,
  zone,
  busy,
  onNew,
  onEdit,
  onRefresh,
}: {
  calendar: CalendarSnapshot;
  zone: string;
  busy: boolean;
  onNew: (day: string) => void;
  onEdit: (event: CalendarEvent) => void;
  onRefresh: () => void;
}) {
  const today = DateTime.now().setZone(zone).toISODate()!;
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState(today);
  const first = calendar.months?.first;
  const last = calendar.months?.last;
  const loaded = !first || !last || (selected.slice(0, 7) >= first && selected.slice(0, 7) <= last);
  const appointments = eventsForDay(calendar.events, selected, zone);

  return (
    <>
      <div className="page-heading calendar-page-heading">
        <div>
          <div className="eyebrow">PLANS, TOGETHER</div>
          <h1>Calendar</h1>
        </div>
        <Button
          variant="default"

          disabled={busy || calendar.status !== 'connected'}
          onClick={() => onNew(selected)}
        >
          <Plus size={17} /> Add
        </Button>
      </div>
      <div className="calendar-status">
        <span className={`status-dot ${calendar.status !== 'connected' ? 'pending' : ''}`} />
        <span>
          {calendar.name} ·{' '}
          {calendar.status === 'not-connected'
            ? 'Not connected'
            : calendar.status === 'error'
              ? 'Needs refresh'
              : 'Synced'}
        </span>
        <Button
          variant="ghost"

          onClick={onRefresh}
          disabled={busy || calendar.status === 'not-connected'}
          aria-label="Refresh calendar"
        >
          <RefreshCw size={15} />
        </Button>
      </div>
      <Suspense
        fallback={
          <Skeleton className="h-96 w-full" aria-label="Loading month calendar" role="status" />
        }
      >
        <MonthCalendar
          calendar={calendar}
          zone={zone}
          month={month}
          selected={selected}
          setMonth={setMonth}
          setSelected={setSelected}
        />
      </Suspense>
      {calendar.error && (
        <Alert className="calendar-warning" role="status">
          <AlertDescription>
            {calendar.error} Previously loaded appointments remain visible.
          </AlertDescription>
        </Alert>
      )}
      <section className="day-agenda" aria-label="Selected day appointments" aria-live="polite">
        <div className="section-heading">
          <div>
            <h2>
              {selected === today ? 'Today' : DateTime.fromISO(selected, { zone }).toFormat('cccc')}
            </h2>
            <p className="small muted">
              {DateTime.fromISO(selected, { zone }).toFormat('d LLLL')} · {zone}
            </p>
          </div>
          <Badge variant="secondary">
            {calendar.status === 'not-connected' ? '—' : appointments.length}
          </Badge>
        </div>
        {calendar.status === 'not-connected' ? (
          <div className="day-empty">
            <CalendarDays size={24} />
            <h3>Connect your shared calendar</h3>
            <p>
              Once iCloud is connected, days with plans get a dot. Tap a day to see its appointments
              here.
            </p>
          </div>
        ) : !loaded ? (
          <p className="day-empty">
            This date is outside the loaded calendar range. Refresh to load the current months.
          </p>
        ) : appointments.length ? (
          <div className="agenda-items">
            {appointments.map((event) => (
              <Card className="gap-0 py-0" key={event.id}>
                <Button variant="ghost" className="agenda-event" onClick={() => onEdit(event)}>
                  <div className="agenda-time">
                    {event.allDay
                      ? 'All day'
                      : DateTime.fromISO(event.start).setZone(zone).toFormat('HH:mm')}
                    <small>
                      {event.allDay
                        ? ''
                        : DateTime.fromISO(event.end).setZone(zone).toFormat('HH:mm')}
                    </small>
                  </div>
                  <div>
                    <strong>{event.title}</strong>
                    {event.location && (
                      <span className="agenda-location">
                        <MapPin size={11} />
                        {event.location}
                      </span>
                    )}
                    {event.recurring && (
                      <span className="agenda-location">
                        <Repeat2 size={11} /> Recurring
                      </span>
                    )}
                  </div>
                  <ArrowRight size={16} />
                </Button>
              </Card>
            ))}
          </div>
        ) : (
          <div className="day-empty">
            <p>
              {calendar.status === 'error'
                ? 'No appointments in the last loaded calendar for this day.'
                : 'No appointments planned for this day.'}
            </p>
          </div>
        )}
      </section>
    </>
  );
}

export function EventForm({
  event,
  zone,
  busy,
  onSubmit,
  onDelete,
  defaultDate,
}: {
  event?: CalendarEvent;
  defaultDate?: string;
  zone: string;
  busy: boolean;
  onSubmit: (fields: CalendarFields) => void;
  onDelete?: () => void;
}) {
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const readOnly = Boolean(event?.readOnlyReason);
  const local = (value: string | undefined, end = false) => {
    if (!value && allDay) return defaultDate ?? DateTime.now().setZone(zone).toISODate()!;
    if (value && allDay && end)
      return DateTime.fromISO(value, { zone }).minus({ days: 1 }).toISODate()!;
    if (!value && defaultDate)
      return DateTime.fromISO(defaultDate, { zone })
        .set({ hour: end ? 10 : 9 })
        .toFormat(allDay ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm");
    if (!value)
      return DateTime.now()
        .setZone(zone)
        .plus({ hours: end ? 2 : 1 })
        .startOf('hour')
        .toFormat(allDay ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm");
    return DateTime.fromISO(value, { zone })
      .setZone(zone)
      .toFormat(allDay ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm");
  };
  return (
    <form
      className="form"
      onSubmit={(form) => {
        form.preventDefault();
        const data = new FormData(form.currentTarget);
        const start = String(data.get('start'));
        const end = String(data.get('end'));
        onSubmit({
          title: String(data.get('title')),
          notes: String(data.get('notes')),
          location: String(data.get('location')),
          allDay,
          start: allDay ? start : DateTime.fromISO(start, { zone }).toUTC().toISO() || '',
          end: allDay
            ? DateTime.fromISO(end, { zone: 'UTC' }).plus({ days: 1 }).toISODate() || ''
            : DateTime.fromISO(end, { zone }).toUTC().toISO() || '',
          reminderMinutes: data.get('reminder') === 'none' ? null : Number(data.get('reminder')),
        });
      }}
    >
      {event?.readOnlyReason && (
        <Alert className="calendar-warning">
          <AlertDescription>{event.readOnlyReason}</AlertDescription>
        </Alert>
      )}
      <Label>
        Appointment
        <Input
          name="title"
          required
          maxLength={200}
          defaultValue={event?.title}
          disabled={readOnly}
        />
      </Label>
      <Label className="all-day-check">
        <Switch checked={allDay} disabled={readOnly} onCheckedChange={setAllDay} />
        All day
      </Label>
      <div className="form-pair" key={String(allDay)}>
        <Label>
          Starts
          <Input
            name="start"
            type={allDay ? 'date' : 'datetime-local'}
            required
            disabled={readOnly}
            defaultValue={local(event?.start)}
          />
        </Label>
        <Label>
          {allDay ? 'Last day' : 'Ends'}
          <Input
            name="end"
            type={allDay ? 'date' : 'datetime-local'}
            required
            disabled={readOnly}
            defaultValue={local(event?.end, true)}
          />
        </Label>
      </div>
      <p className="small muted">
        {zone}
        {allDay ? ' · All-day appointments cover every selected day.' : ''}
      </p>
      <Label>
        Location <span className="optional">optional</span>
        <Input
          name="location"
          maxLength={1000}
          defaultValue={event?.location}
          disabled={readOnly}
        />
      </Label>
      <Label>
        Reminder
        <NativeSelect
          name="reminder"
          disabled={readOnly}
          defaultValue={event ? (event.reminderMinutes ?? 'none') : 30}
        >
          <option value="none">No relative reminder</option>
          <option value="0">At the start</option>
          <option value="15">15 minutes before</option>
          <option value="30">30 minutes before</option>
          <option value="60">1 hour before</option>
          <option value="1440">1 day before</option>
          {event?.reminderMinutes !== null &&
            event?.reminderMinutes !== undefined &&
            ![0, 15, 30, 60, 1440].includes(event.reminderMinutes) && (
              <option value={event.reminderMinutes}>{event.reminderMinutes} minutes before</option>
            )}
        </NativeSelect>
      </Label>
      <Label>
        Notes <span className="optional">optional</span>
        <Textarea
          name="notes"
          maxLength={5000}
          rows={3}
          defaultValue={event?.notes}
          disabled={readOnly}
        />
      </Label>
      {!readOnly && (
        <div className="dialog-actions">
          {onDelete && (
            <Button
              variant="ghost"
              type="button"
              className="text-destructive"
              disabled={busy}
              onClick={onDelete}
            >
              <Trash2 size={16} />
              Delete
            </Button>
          )}
          <Button variant="default" disabled={busy}>
            Review appointment <ArrowRight size={15} />
          </Button>
        </div>
      )}
    </form>
  );
}
