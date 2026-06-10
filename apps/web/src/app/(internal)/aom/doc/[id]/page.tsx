import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, knowledgeDocuments } from "@growengine/db";
import { requireTeamUser } from "@/lib/session";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireTeamUser();
  const [doc] = await db
    .select()
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.tenantId, user.tenantId)));
  if (!doc) notFound();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl">{doc.title}</CardTitle>
          <Badge variant="outline">{doc.type}</Badge>
        </div>
        <CardDescription>{doc.createdAt.toISOString().slice(0, 10)}</CardDescription>
      </CardHeader>
      <CardContent>
        <Markdown content={doc.contentMarkdown} />
      </CardContent>
    </Card>
  );
}
