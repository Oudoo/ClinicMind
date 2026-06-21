import { getActingContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { Card, SectionTitle, Badge, EmptyState } from "@/components/ui/primitives";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const CHANNEL_TONE: Record<string, "default" | "accent" | "success"> = {
  WHATSAPP: "success",
  VOICE: "accent",
  WEB_CHAT: "default",
  SMS: "default",
  IN_PERSON: "default",
};

export default async function ConversationsPage() {
  const ctx = await getActingContext();
  const conversations = ctx
    ? await db.conversation
        .findMany({
          where: { tenantId: ctx.tenantId },
          orderBy: { updatedAt: "desc" },
          take: 50,
          include: {
            patient: { select: { fullName: true } },
            _count: { select: { messages: true } },
          },
        })
        .catch(() => [])
    : [];

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Conversations"
        description="AI receptionist (WhatsApp) and voice agent threads — Arabic, Egyptian Arabic & English."
        action={<Badge tone="accent">{conversations.length} threads</Badge>}
      />

      {conversations.length ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {conversations.map((c) => (
            <Card key={c.id} className="space-y-2">
              <div className="flex items-center justify-between">
                <Badge tone={CHANNEL_TONE[c.channel] ?? "default"}>{c.channel}</Badge>
                <span className="font-mono text-xs text-muted-foreground">{c.locale}</span>
              </div>
              <p className="text-sm font-medium">{c.patient?.fullName ?? "Unknown contact"}</p>
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {c.summary ?? "No summary yet."}
              </p>
              <div className="flex items-center justify-between pt-1">
                <span className="font-mono text-[10px] text-muted-foreground">
                  {c._count.messages} messages
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {formatDate(c.updatedAt)}
                </span>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            title="No conversations yet"
            hint="WhatsApp and voice threads appear here once the channels are connected."
          />
        </Card>
      )}
    </div>
  );
}
