"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Markdown } from "@/components/markdown";

/**
 * Interactive Business Audit Lead Magnet — public, embeddable widget.
 * Embed with: <iframe src="https://your-domain/audit?tenant=your-workspace" />
 */
export default function PublicAuditPage() {
  const [tenantSlug, setTenantSlug] = useState("");
  const [auditId, setAuditId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setTenantSlug(params.get("tenant") ?? "");
  }, []);

  useEffect(() => {
    if (!auditId || status === "completed" || status === "failed") return;
    const interval = setInterval(async () => {
      const res = await fetch(`/api/public/lead-audit?id=${auditId}`);
      if (!res.ok) return;
      const data = await res.json();
      setStatus(data.status);
      if (data.status === "completed") {
        setReport(data.report);
        setScore(data.score);
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [auditId, status]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await fetch("/api/public/lead-audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantSlug,
        companyName: form.get("companyName"),
        contactName: form.get("contactName"),
        contactEmail: form.get("contactEmail"),
        websiteUrl: form.get("websiteUrl"),
        industry: form.get("industry") || undefined,
        monthlyAdBudget: form.get("monthlyAdBudget") || undefined,
        primaryGoal: form.get("primaryGoal") || undefined,
        responses: {
          biggestChallenge: String(form.get("biggestChallenge") ?? ""),
          currentChannels: String(form.get("currentChannels") ?? ""),
        },
      }),
    });
    setLoading(false);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Submission failed");
      return;
    }
    setAuditId(data.auditId);
    setStatus("processing");
  }

  return (
    <main className="mx-auto max-w-2xl p-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Free Growth Audit</CardTitle>
          <CardDescription>
            We analyze your website and answers with live data and send back a
            scored, actionable growth-readiness audit in minutes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!auditId && (
            <form onSubmit={onSubmit} className="space-y-4">
              {!tenantSlug && (
                <div>
                  <Label htmlFor="tenant">Agency workspace</Label>
                  <Input
                    id="tenant"
                    value={tenantSlug}
                    onChange={(e) => setTenantSlug(e.target.value)}
                    placeholder="agency-workspace"
                    required
                  />
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="companyName">Company</Label>
                  <Input id="companyName" name="companyName" required />
                </div>
                <div>
                  <Label htmlFor="industry">Industry</Label>
                  <Input id="industry" name="industry" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="contactName">Your name</Label>
                  <Input id="contactName" name="contactName" required />
                </div>
                <div>
                  <Label htmlFor="contactEmail">Work email</Label>
                  <Input id="contactEmail" name="contactEmail" type="email" required />
                </div>
              </div>
              <div>
                <Label htmlFor="websiteUrl">Website URL</Label>
                <Input id="websiteUrl" name="websiteUrl" type="url" placeholder="https://" required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="monthlyAdBudget">Monthly ad budget</Label>
                  <Select id="monthlyAdBudget" name="monthlyAdBudget">
                    <option value="">Select…</option>
                    <option>Under $5k</option>
                    <option>$5k – $25k</option>
                    <option>$25k – $100k</option>
                    <option>Over $100k</option>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="primaryGoal">Primary goal</Label>
                  <Select id="primaryGoal" name="primaryGoal">
                    <option value="">Select…</option>
                    <option>More leads</option>
                    <option>More revenue</option>
                    <option>Lower acquisition cost</option>
                    <option>Brand awareness</option>
                  </Select>
                </div>
              </div>
              <div>
                <Label htmlFor="currentChannels">Current marketing channels</Label>
                <Input id="currentChannels" name="currentChannels" placeholder="Meta, Google Ads, SEO…" />
              </div>
              <div>
                <Label htmlFor="biggestChallenge">Biggest growth challenge right now</Label>
                <Textarea id="biggestChallenge" name="biggestChallenge" rows={3} />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Submitting…" : "Get my free audit"}
              </Button>
            </form>
          )}

          {auditId && status !== "completed" && status !== "failed" && (
            <div className="py-12 text-center">
              <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <p className="font-medium">Analyzing your website with live data…</p>
              <p className="text-sm text-muted-foreground">
                We are crawling your site and evaluating it. This usually takes 1–3 minutes.
              </p>
            </div>
          )}

          {status === "completed" && report && (
            <div>
              {score !== null && (
                <div className="mb-4 rounded-lg bg-accent p-4 text-center">
                  <div className="text-4xl font-bold text-accent-foreground">{Math.round(score)}/100</div>
                  <div className="text-sm text-muted-foreground">Growth readiness score</div>
                </div>
              )}
              <Markdown content={report} />
            </div>
          )}

          {status === "failed" && (
            <p className="py-8 text-center text-destructive">
              We could not complete the audit automatically — our team has been notified and will
              reach out by email.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
