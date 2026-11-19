/**
 * Azure DevOps REST API versions used by `platform ado`, pinned in one place. Each is the version
 * the sandbox calls were made with (ADO-2, 4, 6, 10, 12, 20; docs/runbooks/sandbox-verification.md).
 */
export const API = {
  projects: "7.1",
  git: "7.1",
  identities: "7.1",
  serviceEndpoints: "7.1",
  environments: "7.1",
  checks: "7.1-preview.1",
  pipelines: "7.1",
  pipelinePermissions: "7.1-preview.1",
  accessControl: "7.1",
  /** Permissions - Remove (one bit of one ACE, allow and deny; the sandbox's tag protection, ADO-23). */
  permissions: "7.1",
  securityRoles: "7.1-preview.1",
  buildGeneralSettings: "7.1",
  buildDefinitions: "7.1",
  securityNamespaces: "7.1",
  /** Agent queues of a project (sandbox GET, 2026-10-29). */
  queues: "7.1-preview.1",
  /** Graph (vssps) and member entitlements (vsaex) are preview-only in 7.1 (sandbox GETs, 2026-10-29). */
  graph: "7.1-preview.1",
  memberEntitlements: "7.1-preview.1",
  /** Branch policies (Policy Configurations, Microsoft Learn 7.1). */
  policy: "7.1",
  /**
   * `_apis/connectionData` (who the token belongs to) exists only as a preview.
   * TODO(verify) ADO-25: this version, and that authenticatedUser.id is the caller's identity ID.
   */
  connectionData: "7.1-preview.1",
} as const;

/**
 * The Microsoft-hosted agent queue every platform pipeline runs on (its jobs name this pool too,
 * pipelines/azure-devops rule T16). A pipeline created through the REST API by an identity that
 * can't use any queue gets no default queue, and then doesn't load ("No pool was specified").
 */
export const HOSTED_QUEUE = "Azure Pipelines";

/** Security namespaces (Microsoft Learn, "Security namespace and permission reference"). */
export const NAMESPACE = {
  gitRepositories: "2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87",
  project: "52d39943-cb85-4d7f-8fa8-c6baac873819",
  build: "33344d9c-fc72-4d6f-aba5-fa317101a7e9",
  serviceEndpoints: "49b48001-ca20-4adc-8111-5b60c903a50c",
} as const;

/**
 * Permission bits: Git Repositories Read = 2, Project GENERIC_READ (view) = 1, Build QueueBuilds = 128.
 * `platform ado bootstrap` reads every bit it needs by action name from
 * `GET _apis/securitynamespaces/{id}` at run time instead.
 */
export const BIT = {
  gitRead: 2,
  projectView: 1,
  queueBuilds: 128,
} as const;

/** Check types (ids from the sandbox's GET of checks created through the UI and the API, ADO-12). */
export const CHECK_TYPE = {
  extends: { id: "4020e66e-b0f3-47e1-bc88-48f3cc59b5f3", name: "ExtendsCheck" },
  exclusiveLock: { id: "2ef31ad6-baa0-403a-8b45-2cbc9b4e5563", name: "ExclusiveLock" },
  approval: { id: "8c6f20a7-a545-4486-9777-f762fafe0d4d", name: "Approval" },
  task: { id: "fe1de3ee-a436-41b4-bb20-f6eb4cb879a7", name: "Task Check" },
} as const;

/** The Branch control task check ("evaluatebranchProtection"). */
export const BRANCH_CONTROL = { id: "86b05a0c-73e6-4f7d-b3cf-e38f3b39a75b", name: "evaluatebranchProtection", version: "0.0.1" } as const;

/** Branch policy types (Microsoft Learn, Policy Configurations - Create, 7.1 samples). */
export const POLICY_TYPE = {
  minimumReviewers: "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd",
  requiredReviewers: "fd2167ab-b0be-447a-8ec8-39368250530e",
  build: "0609b952-1397-4640-95ec-e00a01b2c241",
} as const;
