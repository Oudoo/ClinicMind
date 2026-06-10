import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, clients, healthScores } from "@growengine/db";
import { requireTeamUser } from "@/lib/session";
import { createClient } from "@/app/actions/clients";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency , formAction } from "@/lib/utils";

export default async function ClientsPage() {
  const user = await requireTeamUser();
  const rows = await db
    .select()
    .from(clients)
    .where(eq(clients.tenantId, user.tenantId))
    .orderBy(desc(clients.createdAt));

  const scores = await db
    .select()
    .from(healthScores)
    .where(eq(healthScores.tenantId, user.tenantId))
    .orderBy(desc(healthScores.computedAt));
  const latest = new Map<string, number>();
  for (const s of scores) if (!latest.has(s.clientId)) latest.set(s.clientId, Number(s.score));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Clients</h1>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="pt-5">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Health</TableHead>
                  <TableHead>Retainer</TableHead>
                  <TableHead>Portal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((client) => (
                  <TableRow key={client.id}>
                    <TableCell>
                      <Link href={`/clients/${client.id}`} className="font-medium text-primary hover:underline">
                        {client.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">{client.industry ?? "—"}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(client.status)}>{client.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {latest.has(client.id) ? `${latest.get(client.id)!.toFixed(0)}/100` : "—"}
                    </TableCell>
                    <TableCell>
                      {client.monthlyRetainer ? formatCurrency(client.monthlyRetainer) : "—"}
                    </TableCell>
                    <TableCell>
                      <Link href={`/client/${client.slug}`} className="text-xs text-primary underline">
                        /client/{client.slug}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                      No clients yet. Add your first client →
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Add client</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={formAction(createClient)} className="space-y-3">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" required />
              </div>
              <div>
                <Label htmlFor="industry">Industry</Label>
                <Input id="industry" name="industry" />
              </div>
              <div>
                <Label htmlFor="websiteUrl">Website</Label>
                <Input id="websiteUrl" name="websiteUrl" type="url" placeholder="https://" />
              </div>
              <div>
                <Label htmlFor="monthlyRetainer">Monthly retainer (USD)</Label>
                <Input id="monthlyRetainer" name="monthlyRetainer" type="number" min="0" />
              </div>
              <Button type="submit" className="w-full">Create client</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
