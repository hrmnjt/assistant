/** Call the app's API: JSON in and out, with the app's own header; errors carry their status. */
export async function api<T>(
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
