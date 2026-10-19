import { DAVClient, type DAVCalendar } from 'tsdav';
import { DomainError } from '../../errors.js';

export type CalendarResource = { url: string; etag: string; data: string };
export interface CalendarTransport {
  collection(): Promise<{ name: string; url: string }>;
  list(start: string, end: string): Promise<CalendarResource[]>;
  get(url: string): Promise<CalendarResource | null>;
  put(url: string, data: string, etag: string | null): Promise<void>;
  remove(url: string, etag: string): Promise<void>;
}
function allowedICloudUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !(url.hostname === 'icloud.com' || url.hostname.endsWith('.icloud.com'))
  ) {
    throw new DomainError('The calendar server returned an unsupported address.', 503);
  }
  return url;
}

/** An iCloud account: the Apple ID and an app-specific password, never the account password. */
export type CalendarAccount = { username: string; password: string };
/** One of the account's calendars that holds events. */
export type CalendarChoice = { name: string; url: string };
/** Opens calendar connections; tests can supply a stand-in for iCloud. */
export type CalendarConnector = {
  calendars(account: CalendarAccount): Promise<CalendarChoice[]>;
  open(account: CalendarAccount & { calendarUrl: string }): CalendarTransport;
};
export const iCloud: CalendarConnector = {
  calendars: (account) => new ICloudTransport({ ...account, calendarName: '' }).calendars(),
  open: (account) => new ICloudTransport({ ...account, calendarName: '' }),
};

export class ICloudTransport implements CalendarTransport {
  private client: DAVClient;
  private selected?: DAVCalendar;
  private connecting?: Promise<DAVCalendar>;
  private authorization: string;
  constructor(
    private config: {
      username: string;
      password: string;
      calendarName: string;
      calendarUrl?: string;
    },
  ) {
    this.authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
    const safeFetch: typeof fetch = async (input, init) => {
      let target = allowedICloudUrl(input instanceof Request ? input.url : String(input));
      const signal = init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000);
      for (let redirects = 0; redirects < 5; redirects++) {
        const response = await fetch(target, { ...init, signal, redirect: 'manual' });
        if (![301, 302, 303, 307, 308].includes(response.status)) {
          if ([401, 403].includes(response.status) || response.status >= 500) this.check(response);
          return response;
        }
        const location = response.headers.get('location');
        if (!location) return response;
        target = allowedICloudUrl(new URL(location, target).href);
      }
      throw new DomainError('Calendar connection redirected too many times.', 503);
    };
    this.client = new DAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: { username: config.username, password: config.password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
      fetch: safeFetch,
    });
    this.fetch = safeFetch;
  }
  private fetch: typeof fetch;
  /** The account's calendars that hold events, to choose one. */
  async calendars(): Promise<CalendarChoice[]> {
    await this.client.login({ loadCollections: false, loadObjects: false });
    return (await this.client.fetchCalendars())
      .filter((calendar) => !calendar.components || calendar.components.includes('VEVENT'))
      .map((calendar) => {
        allowedICloudUrl(calendar.url);
        // The exact URL, as connecting later matches it.
        return { name: String(calendar.displayName), url: calendar.url };
      });
  }
  private async calendar() {
    if (this.selected) return this.selected;
    if (!this.connecting)
      this.connecting = (async () => {
        await this.client.login({ loadCollections: false, loadObjects: false });
        const all = await this.client.fetchCalendars();
        const matches = all.filter((calendar) =>
          this.config.calendarUrl
            ? calendar.url === this.config.calendarUrl
            : String(calendar.displayName) === this.config.calendarName,
        );
        if (matches.length !== 1)
          throw new DomainError(
            'The chosen iCloud calendar was not found. Connect the calendar again in Settings.',
            503,
          );
        allowedICloudUrl(matches[0].url);
        this.selected = matches[0];
        return matches[0];
      })().finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }
  async collection() {
    const calendar = await this.calendar();
    return { url: calendar.url, name: String(calendar.displayName) };
  }
  private async scoped(url: string) {
    const calendar = await this.calendar();
    const base = allowedICloudUrl(calendar.url);
    const target = allowedICloudUrl(url);
    if (
      target.origin !== base.origin ||
      !target.pathname.startsWith(
        base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`,
      ) ||
      target.search
    ) {
      throw new DomainError('The appointment is outside the selected shared calendar.', 403);
    }
    return target.href;
  }
  async list(start: string, end: string) {
    const calendar = await this.calendar();
    const timestamp = (value: string) =>
      new Date(value).toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
    const responses = await this.client.calendarQuery({
      url: calendar.url,
      depth: '1',
      props: {
        'd:getetag': {},
        'c:calendar-data': {
          'c:expand': { _attributes: { start: timestamp(start), end: timestamp(end) } },
        },
      },
      filters: [
        {
          'comp-filter': {
            _attributes: { name: 'VCALENDAR' },
            'comp-filter': {
              _attributes: { name: 'VEVENT' },
              'time-range': { _attributes: { start: timestamp(start), end: timestamp(end) } },
            },
          },
        },
      ],
    });
    const resources: CalendarResource[] = [];
    const text = (value: unknown): string =>
      typeof value === 'string'
        ? value
        : value && typeof value === 'object' && '_cdata' in value
          ? String(value._cdata)
          : value && typeof value === 'object' && '_text' in value
            ? String(value._text)
            : '';
    for (const response of responses) {
      if (!response.ok || response.status >= 400)
        throw new DomainError(
          'iCloud could not return the shared calendar. Previously loaded appointments have been retained.',
          503,
        );
      const data = text(response.props?.calendarData);
      if (!data)
        throw new DomainError(
          'iCloud returned an incomplete calendar response. Previously loaded appointments have been retained.',
          503,
        );
      resources.push({
        url: await this.scoped(new URL(response.href || '', calendar.url).href),
        etag: text(response.props?.getetag),
        data,
      });
    }
    return resources;
  }
  async get(url: string) {
    const response = await this.fetch(await this.scoped(url), {
      headers: { Authorization: this.authorization },
      cache: 'no-store',
    });
    if (response.status === 404 || response.status === 410) return null;
    this.check(response);
    return { url, etag: response.headers.get('etag') || '', data: await response.text() };
  }
  async put(url: string, data: string, etag: string | null) {
    const response = await this.fetch(await this.scoped(url), {
      method: 'PUT',
      headers: {
        Authorization: this.authorization,
        'Content-Type': 'text/calendar; charset=utf-8',
        ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }),
      },
      body: data,
    });
    this.check(response);
  }
  async remove(url: string, etag: string) {
    const response = await this.fetch(await this.scoped(url), {
      method: 'DELETE',
      headers: { Authorization: this.authorization, 'If-Match': etag },
    });
    this.check(response);
  }
  private check(response: Response) {
    if (response.ok) return;
    if (response.status === 412 || response.status === 409)
      throw new DomainError(
        'This appointment changed in iCloud. Refresh and review a new preview.',
        409,
      );
    if (response.status === 401 || response.status === 403)
      throw new DomainError(
        'iCloud did not permit this calendar operation. Check the iCloud connection and that it may edit this calendar.',
        503,
      );
    throw new DomainError(
      'iCloud could not complete the calendar request. Please retry later.',
      503,
    );
  }
}
