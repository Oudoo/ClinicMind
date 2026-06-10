import { formAction } from "@/lib/utils";
import { notFound } from "next/navigation";
import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db, meetings, transcripts, sowDocuments, prerequisiteForms, clients } from "@growengine/db";
import { requireTeamUser } from "@/lib/session";
import { uploadRecording, reanalyzeMeeting, generateSow, savePrerequisiteResponses } from "@/app/actions/meetings";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, statusVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Markdown } from "@/components/markdown";
import { ConfidenceBadge } from "@/components/ui/progress";

export default async function MeetingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireTeamUser();

  const [meeting] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, id), eq(meetings.tenantId, user.tenantId)));
  if (!meeting) notFound();

  const [client] = await db.select().from(clients).where(eq(clients.id, meeting.clientId));
  const [transcript] = await db.select().from(transcripts).where(eq(transcripts.meetingId, id));
  const sows = await db
    .select()
    .from(sowDocuments)
    .where(and(eq(sowDocuments.meetingId, id), eq(sowDocuments.tenantId, user.tenantId)))
    .orderBy(desc(sowDocuments.createdAt));
  const [form] = meeting.prerequisiteFormId
    ? await db.select().from(prerequisiteForms).where(eq(prerequisiteForms.id, meeting.prerequisiteFormId))
    : [];

  const requirements = meeting.extractedRequirements as { text: string; priority: string; evidenceQuote: string }[];
  const challenges = meeting.extractedChallenges as { text: string; severity: string; evidenceQuote: string }[];
  const actionItems = meeting.actionItems as { text: string; owner: string; due: string | null }[];
  const prereqResponses = meeting.prerequisiteResponses as Record<string, string>;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{meeting.title}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <Badge variant={statusVariant(meeting.status)}>{meeting.status.replace(/_/g, " ")}</Badge>
            <Link href={`/clients/${meeting.clientId}`} className="text-primary underline">{client?.name}</Link>
            {meeting.analysisConfidence && (
              <ConfidenceBadge score={meeting.analysisConfidence} />
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {meeting.status === "analyzed" && (
            <>
              <form action={formAction(generateSow.bind(null, meeting.id))}>
                <Button size="sm">Generate SOW</Button>
              </form>
              <form action={formAction(reanalyzeMeeting.bind(null, meeting.id))}>
                <Button size="sm" variant="outline">Re-analyze</Button>
              </form>
            </>
          )}
        </div>
      </div>

      {form && meeting.status === "awaiting_prereqs" && (
        <Card>
          <CardHeader>
            <CardTitle>Pre-meeting prerequisites — {form.name}</CardTitle>
            <CardDescription>Captured before the meeting; feeds the AI analysis.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={formAction(savePrerequisiteResponses.bind(null, meeting.id))} className="space-y-3">
              {(form.fields as { key: string; label: string; type: string; required?: boolean }[]).map((f) => (
                <div key={f.key}>
                  <Label>{f.label}</Label>
                  {f.type === "textarea" ? (
                    <Textarea name={`field_${f.key}`} rows={3} required={f.required} />
                  ) : (
                    <Input name={`field_${f.key}`} required={f.required} />
                  )}
                </div>
              ))}
              <Button type="submit">Save responses</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {Object.keys(prereqResponses).length > 0 && (
        <Card>
          <CardHeader><CardTitle>Prerequisite responses</CardTitle></CardHeader>
          <CardContent className="grid gap-2 text-sm md:grid-cols-2">
            {Object.entries(prereqResponses).map(([k, v]) => (
              <div key={k} className="rounded-md bg-muted/50 p-2">
                <div className="text-xs font-semibold text-muted-foreground">{k}</div>
                <div>{v}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {!meeting.recordingStorageKey && meeting.status !== "awaiting_prereqs" && (
        <Card>
          <CardHeader>
            <CardTitle>Upload recording</CardTitle>
            <CardDescription>
              Transcription runs in the AI worker — local whisper.cpp when configured, OpenAI
              Whisper otherwise. Then requirements, challenges and the Expectation Baseline are extracted.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={formAction(uploadRecording.bind(null, meeting.id))} className="flex items-center gap-3">
              <input type="file" name="recording" accept="audio/*,video/*" required className="text-sm" />
              <Button type="submit">Upload & analyze</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {["transcribing", "analyzing", "recorded"].includes(meeting.status) && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          The pipeline is running in the background ({meeting.status}). Refresh to see progress.
        </div>
      )}

      {meeting.status === "analyzed" && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader><CardTitle>Requirements ({requirements.length})</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {requirements.map((r, i) => (
                <div key={i} className="rounded-md border p-2 text-sm">
                  <Badge variant={r.priority === "must" ? "destructive" : r.priority === "should" ? "warning" : "secondary"}>{r.priority}</Badge>
                  <p className="mt-1">{r.text}</p>
                  <p className="mt-1 text-xs italic text-muted-foreground">&ldquo;{r.evidenceQuote}&rdquo;</p>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Challenges ({challenges.length})</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {challenges.map((c, i) => (
                <div key={i} className="rounded-md border p-2 text-sm">
                  <Badge variant={c.severity === "high" ? "destructive" : c.severity === "medium" ? "warning" : "secondary"}>{c.severity}</Badge>
                  <p className="mt-1">{c.text}</p>
                  <p className="mt-1 text-xs italic text-muted-foreground">&ldquo;{c.evidenceQuote}&rdquo;</p>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Action items ({actionItems.length})</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {actionItems.map((a, i) => (
                <div key={i} className="rounded-md border p-2 text-sm">
                  <p>{a.text}</p>
                  <p className="text-xs text-muted-foreground">{a.owner}{a.due ? ` · due ${a.due}` : ""}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      {meeting.expectationBaseline && (
        <Card>
          <CardHeader><CardTitle>Expectation Baseline</CardTitle></CardHeader>
          <CardContent><Markdown content={meeting.expectationBaseline} /></CardContent>
        </Card>
      )}

      {sows.map((sow) => (
        <Card key={sow.id}>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>{sow.title}</CardTitle>
            <div className="flex items-center gap-2">
              <ConfidenceBadge score={sow.generationConfidence} />
              <Badge variant={statusVariant(sow.status)}>{sow.status}</Badge>
            </div>
          </CardHeader>
          <CardContent>
            {sow.documentMarkdown ? (
              <Markdown content={sow.documentMarkdown} />
            ) : (
              <p className="text-sm text-muted-foreground">SOW generation in progress…</p>
            )}
          </CardContent>
        </Card>
      ))}

      {transcript && (
        <Card>
          <CardHeader>
            <CardTitle>Transcript</CardTitle>
            <CardDescription>
              {transcript.engine} · {transcript.wordCount} words · {transcript.language ?? "auto"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-96 space-y-1.5 overflow-y-auto text-sm">
              {(transcript.segments as { start: number; end: number; text: string }[]).map((s, i) => (
                <div key={i} className="flex gap-3">
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {Math.floor(s.start / 60)}:{String(Math.floor(s.start % 60)).padStart(2, "0")}
                  </span>
                  <span>{s.text}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
