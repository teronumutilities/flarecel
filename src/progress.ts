import { runDoctor } from "./doctor.js";
import { createProvisionPlan } from "./provision.js";
import { runVerify } from "./verify.js";
import type { DoctorReport, ProjectContext, Status } from "./types.js";
import type { LoginStatus } from "./auth-status.js";

export type ProgressStageStatus = "done" | "todo" | "blocked" | "optional";

export interface ProgressStage {
  id: string;
  title: string;
  status: ProgressStageStatus;
  command: string;
  explanation: string;
}

export interface ProgressReport {
  status: Status;
  project: DoctorReport["project"];
  cloudflareAuth: LoginStatus;
  stages: ProgressStage[];
  nextActions: string[];
}

export function createProgress(ctx: ProjectContext): ProgressReport {
  const doctor = runDoctor(ctx);
  const verify = runVerify(ctx);
  const provision = createProvisionPlan(ctx);

  const doctorBlocked = doctor.status === "blocking" || doctor.status === "unsupported";
  const verifyBlocked = verify.status === "blocking" || verify.status === "unsupported";
  const needsAuth = verify.status === "secrets-missing";
  const hasProvisionActions = provision.actions.length > 0;

  const stages: ProgressStage[] = [
    {
      id: "doctor",
      title: "Diagnose",
      status: "done",
      command: "flarecel doctor --json",
      explanation: "Doctor is the scanner. It reads the project, framework, package scripts, Wrangler config, source risks, and secret/auth gaps."
    },
    {
      id: "patch",
      title: "Patch fixes or add-ons",
      status: doctorBlocked ? "todo" : "done",
      command: doctorBlocked ? "flarecel fix --dry-run --format patch" : "flarecel add <add-on> --dry-run --format patch",
      explanation: "Add-ons are the single-feature installers the code may still call recipes internally: D1, R2, KV, auth, queues, rate limits, and similar pieces."
    },
    {
      id: "verify",
      title: "Verify locally",
      status: verifyBlocked ? "blocked" : needsAuth ? "todo" : "done",
      command: "flarecel verify --json",
      explanation: "Verify checks the patched app and includes the Wrangler login gate. If wrangler-auth fails, run wrangler login locally or use CLOUDFLARE_API_TOKEN in CI."
    },
    {
      id: "provision",
      title: "Provision Cloudflare resources",
      status: doctorBlocked ? "blocked" : hasProvisionActions ? "todo" : ctx.wrangler.data ? "done" : "optional",
      command: "flarecel provision --json",
      explanation: "Provisioning turns bindings into real Cloudflare resources. A config binding is wiring; provisioning creates or identifies the R2 bucket, D1 database, KV namespace, queue, or index behind it."
    },
    {
      id: "preview",
      title: "Preview deploy",
      status: doctorBlocked || verifyBlocked || needsAuth ? "blocked" : "todo",
      command: "flarecel deploy --preview --yes",
      explanation: "Preview is Cloudflare's upload/preview path, not a Vercel clone. Flarecel's job is to cross-check the project, then run the correct Cloudflare command."
    },
    {
      id: "production",
      title: "Production deploy",
      status: doctorBlocked || verifyBlocked || needsAuth ? "blocked" : "optional",
      command: "flarecel deploy --production --yes",
      explanation: "Production deploy is intentionally gated. Run cost/provision/verify first, then only ship after explicit approval."
    }
  ];

  return {
    status: progressStatus(doctor.status, verify.status, hasProvisionActions),
    project: doctor.project,
    cloudflareAuth: verify.cloudflareAuth,
    stages,
    nextActions: nextActions(doctor.status, verify.status, hasProvisionActions)
  };
}

function progressStatus(doctorStatus: Status, verifyStatus: Status, hasProvisionActions: boolean): Status {
  if (doctorStatus === "unsupported" || doctorStatus === "blocking") return doctorStatus;
  if (verifyStatus === "unsupported" || verifyStatus === "blocking" || verifyStatus === "secrets-missing") return verifyStatus;
  if (hasProvisionActions) return "warning";
  return verifyStatus;
}

function nextActions(doctorStatus: Status, verifyStatus: Status, hasProvisionActions: boolean): string[] {
  if (doctorStatus === "unsupported" || doctorStatus === "blocking") {
    return ["flarecel doctor --json", "flarecel fix --dry-run --format patch"];
  }
  if (verifyStatus === "secrets-missing") {
    return ["wrangler login", "flarecel verify --json"];
  }
  if (verifyStatus === "unsupported" || verifyStatus === "blocking") {
    return ["flarecel verify --json", "flarecel explain <issue-id>"];
  }
  if (hasProvisionActions) {
    return ["flarecel provision --json", "flarecel cost --json", "flarecel deploy --preview --yes"];
  }
  return ["flarecel cost --json", "flarecel deploy --preview --yes"];
}
