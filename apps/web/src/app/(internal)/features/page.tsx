import { formAction } from "@/lib/utils";
import { desc, eq } from "drizzle-orm";
import { db, featureRequests } from "@growengine/db";
import { requireUser } from "@/lib/session";
import { submitFeatureRequest, voteFeatureRequest } from "@/app/actions/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";

export default async function FeaturesPage() {
  const user = await requireUser();
  const rows = await db
    .select()
    .from(featureRequests)
    .where(eq(featureRequests.tenantId, user.tenantId))
    .orderBy(desc(featureRequests.voteCount), desc(featureRequests.createdAt))
    .limit(50);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Feature Requests</h1>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-2 lg:col-span-2">
          {rows.map((fr) => (
            <div key={fr.id} className="flex items-start justify-between rounded-md border bg-card px-4 py-3">
              <div>
                <div className="text-sm font-medium">{fr.title}</div>
                {fr.description && <p className="mt-0.5 text-sm text-muted-foreground">{fr.description}</p>}
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={statusVariant(fr.status)}>{fr.status}</Badge>
                <form action={formAction(voteFeatureRequest.bind(null, fr.id))}>
                  <Button size="sm" variant="outline">▲ {fr.voteCount}</Button>
                </form>
              </div>
            </div>
          ))}
          {rows.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">No feature requests yet.</p>}
        </div>
        <Card className="h-fit">
          <CardHeader><CardTitle>Request a feature</CardTitle></CardHeader>
          <CardContent>
            <form action={formAction(submitFeatureRequest)} className="space-y-3">
              <div>
                <Label>Title</Label>
                <Input name="title" required />
              </div>
              <div>
                <Label>Description</Label>
                <Textarea name="description" rows={4} />
              </div>
              <Button type="submit" className="w-full">Submit</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
