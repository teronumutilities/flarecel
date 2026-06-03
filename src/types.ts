export type Framework =
  | "nextjs"
  | "vite"
  | "astro"
  | "remix"
  | "sveltekit"
  | "hono"
  | "tanstack-start"
  | "unknown";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export type Severity = "info" | "warning" | "high" | "blocking";

export type Status = "ready" | "warning" | "blocking" | "unsupported" | "secrets-missing";

export interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface WranglerInfo {
  path: string | null;
  format: "jsonc" | "toml" | "none";
  rawText: string | null;
  data: Record<string, unknown> | null;
  parseError: string | null;
}

export interface SourceRisk {
  file: string;
  kind: "node-api-import" | "edge-runtime" | "next-on-pages-import" | "next-image-import";
  value: string;
}

export interface ProjectContext {
  cwd: string;
  packageJsonPath: string | null;
  packageJsonRaw: string | null;
  packageJson: PackageJson | null;
  packageJsonParseError: string | null;
  allDependencies: Record<string, string>;
  packageManager: PackageManager;
  framework: Framework;
  wrangler: WranglerInfo;
  hasVercelConfig: boolean;
  hasOpenNext: boolean;
  hasNextOnPages: boolean;
  sourceRisks: SourceRisk[];
}

export interface Issue {
  id: string;
  severity: Severity;
  title: string;
  message: string;
  file?: string;
  fixable: boolean;
  recipe?: string;
  recommendedCommand?: string;
}

export interface DoctorReport {
  status: Status;
  readinessScore: number;
  project: {
    cwd: string;
    name: string | null;
    framework: Framework;
    packageManager: PackageManager;
    cloudflareReady: boolean;
    wranglerConfig: string | null;
  };
  issues: Issue[];
  nextActions: string[];
}

export interface PlanStep {
  id: string;
  title: string;
  command?: string;
  reason: string;
  status: "todo" | "done" | "manual";
}

export interface PlanReport {
  status: Status;
  project: DoctorReport["project"];
  steps: PlanStep[];
  nextActions: string[];
}

export interface PlannedChange {
  path: string;
  before: string | null;
  after: string;
  reason: string;
}

export interface ChangeSet {
  status: "planned" | "applied" | "empty" | "error";
  title: string;
  changes: PlannedChange[];
  warnings: string[];
  nextActions: string[];
}

export interface VerifyCheck {
  id: string;
  status: "passed" | "warning" | "failed";
  message: string;
}

export interface VerifyReport {
  status: Status;
  project: DoctorReport["project"];
  checks: VerifyCheck[];
  nextActions: string[];
}

