/** Fetch a management path with a Bearer operator or connection token. */
export async function authorizedFetch(
  routerUrl: string,
  secret: string,
  path: string,
  init: RequestInit
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${secret}`);
  return fetch(`${routerUrl}${path}`, { ...init, headers });
}
