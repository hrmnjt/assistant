import { useState } from 'react';
import { DateTime } from 'luxon';
import {
  ArrowRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Plus,
  RefreshCw,
  Repeat2,
  Trash2,
} from 'lucide-react';
import type { CalendarEvent, CalendarFields, CalendarSnapshot } from './types';
import { monthDays, eventsForDay } from './calendar-days';

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
  onNew: (day: string) => void;
  onEdit: (event: CalendarEvent) => void;
  onRefresh: () => void;
}) {
  const today = DateTime.now().setZone(zone).toISODate()!;
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState(today);
  const monthDate = DateTime.fromISO(`${month}-01`, { zone });
  const previous = monthDate.minus({ months: 1 }).toFormat('yyyy-MM');
  const next = monthDate.plus({ months: 1 }).toFormat('yyyy-MM');
  const first = calendar.months?.first;
  const last = calendar.months?.last;
  const loaded = !first || !last || (selected.slice(0, 7) >= first && selected.slice(0, 7) <= last);
  const appointments = eventsForDay(calendar.events, selected, zone);
  const move = (value: string) => {
    setMonth(value);
    setSelected(`${value}-01`);
  };
  return (
    <>
      <div className="page-heading calendar-page-heading">
        <div>
          <div className="eyebrow">PLANS, TOGETHER</div>
          <h1>Calendar</h1>
        </div>
        <button
          className="primary"
          disabled={busy || calendar.status !== 'connected'}
          onClick={() => onNew(selected)}
        >
          <Plus size={17} /> Add
        </button>
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
        <button
          className="text-button"
          onClick={onRefresh}
          disabled={busy || calendar.status === 'not-connected'}
          aria-label="Refresh calendar"
        >
          <RefreshCw size={15} />
        </button>
      </div>
      <section className="card month-card" aria-label="Month calendar">
        <div className="month-heading">
          <h2 aria-live="polite">{monthDate.toFormat('LLLL yyyy')}</h2>
          <div>
            <button
              className="text-button"
              onClick={() => {
                setMonth(today.slice(0, 7));
                setSelected(today);
              }}
            >
              Today
            </button>
            <button
              className="icon-button"
              aria-label="Previous month"
              disabled={Boolean(first && previous < first)}
              onClick={() => move(previous)}
            >
              <ChevronLeft size={20} />
            </button>
            <button
              className="icon-button"
              aria-label="Next month"
              disabled={Boolean(last && next > last)}
              onClick={() => move(next)}
            >
              <ChevronRight size={20} />
            </button>
          </div>
        </div>
        <div className="month-weekdays" aria-hidden="true">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => (
            <span key={index}>{day}</span>
          ))}
        </div>
        <div className="month-grid" role="group" aria-label={monthDate.toFormat('LLLL yyyy')}>
          {monthDays(month, zone).map((day) => {
            const date = day.toISODate()!;
            const count = eventsForDay(calendar.events, date, zone).length;
            return (
              <button
                key={date}
                className={`month-day ${day.month !== monthDate.month ? 'other-month' : ''} ${date === today ? 'is-today' : ''} ${date === selected ? 'is-selected' : ''}`}
                aria-label={`${day.toFormat('cccc, d LLLL yyyy')}${calendar.status === 'not-connected' ? '' : `, ${count} appointment${count === 1 ? '' : 's'}`}`}
                aria-pressed={date === selected}
                aria-current={date === today ? 'date' : undefined}
                disabled={Boolean(
                  first && last && (date.slice(0, 7) < first || date.slice(0, 7) > last),
                )}
                onClick={() => {
                  setSelected(date);
                  if (day.month !== monthDate.month) setMonth(date.slice(0, 7));
                }}
              >
                <span>{day.day}</span>
                <span className="event-dots" aria-hidden="true">
                  {Array.from({ length: Math.min(3, count) }, (_, index) => (
                    <i key={index} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      {calendar.error && (
        <p className="calendar-warning" role="status">
          {calendar.error} Previously loaded appointments remain visible.
        </p>
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
          <span className="soft-badge">
            {calendar.status === 'not-connected' ? '—' : appointments.length}
          </span>
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
              <button className="card agenda-event" key={event.id} onClick={() => onEdit(event)}>
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
