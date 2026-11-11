import { supabase } from "./supabase";

/** Never automatically retry paid analyses. */
export async function analyzeDocument(path: string, body: FormData): Promise<Response> {
  const session = await supabase?.auth.getSession();
  const token = session?.data.session?.access_token;
  if (!token) throw new Error("Sign in before analyzing a document.");
  return fetch(path, { method: "POST", body, headers: { Authorization: `Bearer ${token}` } });
}
