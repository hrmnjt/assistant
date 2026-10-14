import { useState } from 'react';
import { DateTime } from 'luxon';
import { ArrowRight, CalendarDays, MapPin, Plus, RefreshCw, Repeat2, Trash2 } from 'lucide-react';
import type { CalendarEvent, CalendarFields, CalendarSnapshot } from './types';

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
    <section className="card calendar-card">
      <div className="section-heading">
        <h2>
          <CalendarDays size={18} /> Shared calendar
        </h2>
        <span className="soft-badge">iCloud</span>
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
            <p className="calendar-warning">Calendar is out of date. Refresh before editing.</p>
          )}
          <button className="text-button" onClick={open}>
            Open calendar <ArrowRight size={14} />
          </button>
        </>
      )}
    </section>
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
  onNew: () => void;
  onEdit: (event: CalendarEvent) => void;
  onRefresh: () => void;
}) {
  const now = DateTime.now().setZone(zone).startOf('day');
  const events = calendar.events.filter((event) => DateTime.fromISO(event.end, { zone }) >= now);
  const days = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const day = DateTime.fromISO(event.start, { zone }).setZone(zone).toISODate()!;
    days.set(day, [...(days.get(day) || []), event]);
  }
  return (
    <>
      <div className="eyebrow">PLANS, TOGETHER</div>
      <div className="page-heading">
        <div>
          <h1>Your shared calendar.</h1>
          <p>The same appointments in iCloud and here.</p>
        </div>
        <button
          className="primary"
          disabled={busy || calendar.status !== 'connected'}
          onClick={onNew}
        >
          <Plus size={17} /> Add appointment
        </button>
      </div>
      <div className="calendar-status">
        <span className={`status-dot ${calendar.status !== 'connected' ? 'pending' : ''}`} />
        <span>
          {calendar.name}
          {calendar.syncedAt
            ? ` · Updated ${DateTime.fromISO(calendar.syncedAt).setZone(zone).toFormat('HH:mm')}`
            : ' · Not connected'}
        </span>
        <button
          className="text-button"
          onClick={onRefresh}
          disabled={busy || calendar.status === 'not-connected'}
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>
      {calendar.status === 'not-connected' ? (
        <section className="card calendar-empty">
          <CalendarDays size={32} />
          <h2>A shared place for your plans.</h2>
          <p>
            The owner needs to connect your shared iCloud calendar. Once connected, either of you
            can add or update appointments here, with a confirmation before every change.
          </p>
        </section>
      ) : (
        <>
          {calendar.error && (
            <p className="calendar-warning" role="status">
              {calendar.error} Previously loaded appointments are shown below.
            </p>
          )}
          <p className="small muted agenda-range">Upcoming appointments · next 90 days · {zone}</p>
          {events.length ? (
            <div className="agenda">
              {[...days.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([day, appointments]) => {
                  const date = DateTime.fromISO(day, { zone });
                  return (
                    <section className="agenda-day" key={day}>
                      <div className="agenda-date">
                        <strong>{date.day}</strong>
                        <span>
                          {date.toFormat('ccc')}
                          <small>{date.toFormat('LLL')}</small>
                        </span>
                      </div>
                      <div className="agenda-items">
                        {appointments.map((event) => (
                          <button
                            className="card agenda-event"
                            key={event.id}
                            onClick={() => onEdit(event)}
                          >
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
                          </button>
                        ))}
                      </div>
                    </section>
                  );
                })}
            </div>
          ) : (
            <section className="card calendar-empty">
              <CalendarDays size={30} />
              <h2>Room for something good.</h2>
              <p>No upcoming appointments in the loaded calendar window.</p>
            </section>
          )}
        </>
      )}
    </>
  );
}

export function EventForm({
  event,
  zone,
  busy,
  onSubmit,
  onDelete,
}: {
  event?: CalendarEvent;
  zone: string;
  busy: boolean;
  onSubmit: (fields: CalendarFields) => void;
  onDelete?: () => void;
}) {
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const readOnly = Boolean(event?.readOnlyReason);
  const local = (value: string | undefined, end = false) => {
    if (!value && allDay) return DateTime.now().setZone(zone).toISODate()!;
    if (value && allDay && end)
      return DateTime.fromISO(value, { zone }).minus({ days: 1 }).toISODate()!;
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
      {event?.readOnlyReason && <p className="calendar-warning">{event.readOnlyReason}</p>}
      <label>
        Appointment
        <input
          name="title"
          required
          maxLength={200}
          defaultValue={event?.title}
          disabled={readOnly}
        />
      </label>
      <label className="all-day-check">
        <input
          type="checkbox"
          checked={allDay}
          disabled={readOnly}
          onChange={(value) => setAllDay(value.target.checked)}
        />
        All day
      </label>
      <div className="form-pair" key={String(allDay)}>
        <label>
          Starts
          <input
            name="start"
            type={allDay ? 'date' : 'datetime-local'}
            required
            disabled={readOnly}
            defaultValue={local(event?.start)}
          />
        </label>
        <label>
          {allDay ? 'Last day' : 'Ends'}
          <input
            name="end"
            type={allDay ? 'date' : 'datetime-local'}
            required
            disabled={readOnly}
            defaultValue={local(event?.end, true)}
          />
        </label>
      </div>
      <p className="small muted">
        {zone}
        {allDay ? ' · All-day appointments cover every selected day.' : ''}
      </p>
      <label>
        Location <span className="optional">optional</span>
        <input
          name="location"
          maxLength={1000}
          defaultValue={event?.location}
          disabled={readOnly}
        />
      </label>
      <label>
        Reminder
        <select
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
        </select>
      </label>
      <label>
        Notes <span className="optional">optional</span>
        <textarea
          name="notes"
          maxLength={5000}
          rows={3}
          defaultValue={event?.notes}
          disabled={readOnly}
        />
      </label>
      {!readOnly && (
        <div className="dialog-actions">
          {onDelete && (
            <button type="button" className="text-button danger" disabled={busy} onClick={onDelete}>
              <Trash2 size={16} />
              Delete
            </button>
          )}
          <button className="primary" disabled={busy}>
            Review appointment <ArrowRight size={15} />
          </button>
        </div>
      )}
    </form>
  );
}
