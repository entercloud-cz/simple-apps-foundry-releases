/**
 * The onboarding plan (ADR-0072), browser-safe: package.json exports "./onboarding" (the portal's setup wizard reads
 * the same steps as instance.sh plan|status and the AI guide). Keep Node imports out of this folder.
 */
export * from "./plan.js";
export * from "./render.js";
export * from "./status.js";
export { AI_GUIDE_FILES, aiGuideFiles } from "./agent-files.js";
