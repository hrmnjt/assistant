import { createContext, useContext, type ComponentProps } from 'react';
import { TZDate } from 'react-day-picker';
import { DateTime } from 'luxon';
import { Calendar, CalendarDayButton } from '@/components/ui/calendar';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { CalendarSnapshot } from './types';
import { eventsForDay } from './calendar-days';

const CalendarContext = createContext<{ calendar: CalendarSnapshot; zone: string } | null>(null);

function EventDayButton(props: ComponentProps<typeof CalendarDayButton>) {
  const { calendar, zone } = useContext(CalendarContext)!;
  const date = DateTime.fromJSDate(props.day.date).setZone(zone).toISODate()!;
  const count = eventsForDay(calendar.events, date, zone).length;
  return (
    <CalendarDayButton
      {...props}
      aria-label={
        props['aria-label'] +
        (calendar.status === 'not-connected'
          ? ''
          : `, ${count} appointment${count === 1 ? '' : 's'}`)
      }
    >
      {props.children}
      <span className="event-dots" aria-hidden="true">
        {Array.from({ length: Math.min(3, count) }, (_, index) => (
          <i key={index} />
        ))}
      </span>
    </CalendarDayButton>
  );
}

export default function MonthCalendar({
  calendar,
  zone,
  month,
  selected,
  setMonth,
  setSelected,
}: {
  calendar: CalendarSnapshot;
  zone: string;
  month: string;
  selected: string;
  setMonth: (value: string) => void;
  setSelected: (value: string) => void;
}) {
  const today = DateTime.now().setZone(zone).toISODate()!;
  const { first, last } = calendar.months ?? {};
  const calendarDate = (date: string) => {
    const [year, month, day] = date.split('-').map(Number);
    return new TZDate(year, month - 1, day, 12, 0, 0, zone);
  };
  return (
    <Card className="month-card" aria-label="Month calendar">
      <div className="flex justify-end">
        <Button
          variant="ghost"
          onClick={() => {
            setMonth(today.slice(0, 7));
            setSelected(today);
          }}
        >
          Today
        </Button>
      </div>
      <CalendarContext.Provider value={{ calendar, zone }}>
        <Calendar
          mode="single"
          required
          timeZone={zone}
          weekStartsOn={1}
          className="w-full bg-transparent p-0"
          month={calendarDate(`${month}-01`)}
          selected={calendarDate(selected)}
          startMonth={first ? calendarDate(`${first}-01`) : undefined}
          endMonth={last ? calendarDate(`${last}-01`) : undefined}
          disabled={(date) => {
            const value = DateTime.fromJSDate(date).setZone(zone).toFormat('yyyy-MM');
            return Boolean(first && last && (value < first || value > last));
          }}
          onMonthChange={(date) => {
            const value = DateTime.fromJSDate(date).setZone(zone).toFormat('yyyy-MM');
            setMonth(value);
            setSelected(`${value}-01`);
          }}
          onSelect={(date) => setSelected(DateTime.fromJSDate(date).setZone(zone).toISODate()!)}
          labels={{ labelNext: () => 'Next month', labelPrevious: () => 'Previous month' }}
          components={{ DayButton: EventDayButton }}
        />
      </CalendarContext.Provider>
    </Card>
  );
}
