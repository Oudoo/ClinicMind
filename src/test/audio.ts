/** Multipart request builder for the transcribe route tests (the JSON helper cannot carry files). */
export function audioRequest(cookie: string | null, fields: Record<string, string>, audio?: { bytes: number; type: string }): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (audio) form.append("audio", new Blob([new Uint8Array(audio.bytes)], { type: audio.type }), "dictation.webm");
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return new Request("http://localhost:3000/api/consultations/transcribe", { method: "POST", headers, body: form });
}
