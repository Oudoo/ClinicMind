/**
 * Browser side of signing in and out (audit finding: signing out left the
 * last person's assistant chat and unsaved edits on screen). Signing out
 * reloads the whole page, so nothing held in memory survives; these helpers
 * also clear what the browser stored and tell the clinic's other open tabs.
 * The server adds `Clear-Site-Data` to the sign-out response as well.
 */

const CHANNEL = "clinicmind-auth";

export type AuthChange = "signed-out" | "signed-in";

/** Set once this tab has announced a change and is navigating away itself. */
let leaving = false;

/** Drop everything this site keeps in the browser (drafts, preferences). */
export function clearBrowserState(): void {
  try {
    sessionStorage.clear();
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
  try {
    localStorage.clear();
  } catch {
    // As above.
  }
}

/** Tell the other tabs of this site that the person signed in or out. */
export function announceAuthChange(change: AuthChange): void {
  // BroadcastChannel also reaches this tab's own listeners; they must not
  // reload over the navigation the announcing code starts next.
  leaving = true;
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ change, at: Date.now() });
    channel.close();
  } catch {
    // BroadcastChannel is missing in very old browsers; those tabs re-check on their next request.
  }
}

/** Run `handler` when another tab signs in or out. Returns the unsubscribe function. */
export function onAuthChange(handler: (change: AuthChange) => void): () => void {
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<{ change?: unknown }>) => {
      const change = event.data?.change;
      if (leaving) return;
      if (change === "signed-out" || change === "signed-in") handler(change);
    };
  } catch {
    channel = null;
  }
  return () => channel?.close();
}
