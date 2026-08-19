import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runWorkflow } from "@agreement-lens/agent-core";
import { userContextSchema } from "@agreement-lens/shared";
import { openKnowledge } from "./db.js";
import { repoRoot } from "./config.js";
import { loadSourceGraph } from "./sources.js";

const fixtureSchema = z.object({
  id: z.string(),
  serviceName: z.string(),
  pageUrl: z.string().url(),
  context: userContextSchema,
  sources: z.array(z.object({
    title: z.string(),
    text: z.string()
  })),
  expected: z.object({
    recommendation: z.enum(["continue", "adjust", "pause"]).optional(),
    highImpact: z.array(z.object({
      category: z.enum(["money", "data", "content", "account", "remedies"]),
      quoteContains: z.string()
    }))
  })
});

const roots = process.argv.slice(2).length
  ? process.argv.slice(2).map((entry) => path.resolve(entry))
  : [path.join(repoRoot, "tests", "evaluation", "development")];

const files = roots.flatMap((root) => fs.existsSync(root)
  ? fs.readdirSync(root).filter((file) => file.endsWith(".json")).map((file) => path.join(root, file))
  : []);

if (!process.env.EVAL_USE_MODEL) delete process.env.OPENAI_API_KEY;

let supportedEvidence = 0;
let publishedEvidence = 0;
let expectedHighImpact = 0;
let recalledHighImpact = 0;
let unsupportedHighImpact = 0;
let recommendationMatches = 0;

for (const file of files) {
  const fixture = fixtureSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const sources = await loadSourceGraph(fixture.sources.map((source) => ({
    id: randomUUID(),
    kind: "text" as const,
    title: source.title,
    text: source.text,
    selected: true,
    relation: "primary" as const
  })));
  const result = await runWorkflow({
    analysisId: randomUUID(),
    serviceId: new URL(fixture.pageUrl).hostname,
    serviceName: fixture.serviceName,
    sources,
    context: fixture.context,
    promptDir: path.join(repoRoot, "prompts")
  }, openKnowledge());

  for (const finding of result.findings.filter((item) => item.status === "verified")) {
    for (const evidence of finding.evidence) {
      publishedEvidence++;
      if (evidence.verified) supportedEvidence++;
    }
    if ((finding.severity === "high" || finding.severity === "critical") && finding.evidence.some((evidence) => !evidence.verified)) {
      unsupportedHighImpact++;
    }
  }
  for (const expected of fixture.expected.highImpact) {
    expectedHighImpact++;
    if (result.findings.some((finding) =>
      finding.status === "verified" &&
      finding.category === expected.category &&
      finding.evidence.some((evidence) => evidence.quote.includes(expected.quoteContains))
    )) recalledHighImpact++;
  }
  if (!fixture.expected.recommendation || fixture.expected.recommendation === result.recommendation) recommendationMatches++;
}

const percent = (numerator: number, denominator: number) => denominator ? Number((numerator / denominator * 100).toFixed(1)) : 100;
const report = {
  fixtures: files.length,
  evidenceSupportPercent: percent(supportedEvidence, publishedEvidence),
  highImpactRecallPercent: percent(recalledHighImpact, expectedHighImpact),
  unsupportedPublishedHighImpact: unsupportedHighImpact,
  recommendationMatchPercent: percent(recommendationMatches, files.length),
  targets: {
    evidenceSupportPercent: 95,
    highImpactRecallPercent: 80,
    unsupportedPublishedHighImpact: 0
  }
};

console.log(JSON.stringify(report, null, 2));
if (
  report.evidenceSupportPercent < report.targets.evidenceSupportPercent ||
  report.highImpactRecallPercent < report.targets.highImpactRecallPercent ||
  report.unsupportedPublishedHighImpact > report.targets.unsupportedPublishedHighImpact
) process.exitCode = 1;
