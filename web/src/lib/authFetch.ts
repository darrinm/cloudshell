/**
 * Drop-in fetch wrapper that detects 401 responses and dispatches
 * a global event so the app can redirect to the login page.
 */
export function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init).then(res => {
    if (res.status === 401) {
      window.dispatchEvent(new Event('cloudshell:auth-expired'));
    }
    return res;
  });
}
