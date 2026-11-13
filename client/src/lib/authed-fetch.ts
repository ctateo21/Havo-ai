// Fetch wrapper that attaches the current Supabase access token as a
// Bearer header so the backend can verify the user via
// supabaseAdmin.auth.getUser(). Mirrors the pattern used by the
// dashboard alert bell.
export async function authedFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  // Browser sessions are unavailable in Node's component-test/SSR runtime.
  // Lazy loading keeps that runtime from instantiating the browser auth client.
  if (import.meta.env) {
    const { supabase } = await import("./supabase");
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(path, { ...init, credentials: "include", headers });
}
