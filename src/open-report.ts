import { promises as fs } from "node:fs";
import path from "node:path";
import type { DoctorReport, ProjectContext } from "./types.js";

export async function writeOpenReport(ctx: ProjectContext, report: DoctorReport): Promise<string> {
  const outputPath = path.join(ctx.cwd, ".flarecel", "report.html");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, renderHtml(report), "utf8");
  return outputPath;
}

function renderHtml(report: DoctorReport): string {
  const issues = report.issues.map((issue) => `
    <li>
      <strong>${escapeHtml(issue.title)}</strong>
      <span>${escapeHtml(issue.severity)}</span>
      <p>${escapeHtml(issue.message)}</p>
      ${issue.recommendedCommand ? `<code>${escapeHtml(issue.recommendedCommand)}</code>` : ""}
    </li>
  `).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Flarecel Report</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; color: #111827; background: #f9fafb; }
    main { max-width: 900px; margin: 0 auto; background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 28px; }
    h1 { margin-top: 0; }
    .score { font-size: 42px; font-weight: 800; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 24px 0; }
    .meta div, li { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; background: #fff; }
    ul { list-style: none; padding: 0; display: grid; gap: 12px; }
    code { display: inline-block; background: #111827; color: white; padding: 6px 8px; border-radius: 6px; }
    span { color: #6b7280; font-size: 13px; margin-left: 8px; }
  </style>
</head>
<body>
  <main>
    <h1>Flarecel</h1>
    <p>Agent-friendly Cloudflare readiness report.</p>
    <div class="score">${report.readinessScore}/100</div>
    <div class="meta">
      <div><strong>Project</strong><br>${escapeHtml(report.project.name ?? "unknown")}</div>
      <div><strong>Framework</strong><br>${escapeHtml(report.project.framework)}</div>
      <div><strong>Status</strong><br>${escapeHtml(report.status)}</div>
      <div><strong>Wrangler</strong><br>${escapeHtml(report.project.wranglerConfig ?? "missing")}</div>
    </div>
    <h2>Issues</h2>
    <ul>${issues || "<li>No issues found.</li>"}</ul>
  </main>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

