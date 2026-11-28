import { checkAiPrompt, DEFINITION_CHECK_IDS, explainCheck, explainProvisioningFailure, INSTANCE_CHECK_IDS, PIPELINE_CHECK_IDS, PROVISIONING_FAILURE_IDS } from "../explanations.js";
import type { ExplanationLanguage, LocalizedText } from "../explanations.js";
import { RULES } from "../rules.js";
import { GROUP_ORDER } from "../types.js";
import type { GroupId } from "../types.js";

/** Group titles in plain words, as the failure catalogue and the portal show them. */
export const CATALOGUE_GROUP_TITLES: Record<GroupId, LocalizedText> = {
  manifest: { en: "The app's settings (platform.yaml)", cs: "Nastavení aplikace (platform.yaml)" },
  dockerfile: { en: "The Dockerfile", cs: "Dockerfile" },
  secrets: { en: "Secrets in the code", cs: "Tajné hodnoty v kódu" },
  "forbidden-files": { en: "Files that don't belong in the repository", cs: "Soubory, které do repozitáře nepatří" },
  docs: { en: "README and CHANGELOG", cs: "README a CHANGELOG" },
  access: { en: "Who may do what in the app, and the signed-in user", cs: "Kdo co v aplikaci smí a přihlášený uživatel" },
  "agent-files": { en: "Instructions for AI agents", cs: "Instrukce pro AI agenty" },
  runtime: { en: "The container test (build, start, health)", cs: "Test kontejneru (sestavení, start, zdraví)" },
};

const WORDS = {
  en: {
    error: "error",
    warning: "warning",
    note: "note",
    severity: "Result",
    fix: "What to do",
    prompt: "Prompt for your AI agent",
    pipeline: "Checks of the delivery pipeline",
    pipelineLead: "These aren't rules of `platform check`: the delivery pipeline runs them after the build.",
    definition: "Checks of the app definition",
    definitionLead: "These check the app's definition in platform-config (apps/<slug>/app.yaml, and the deleted apps' definitions in apps-deleted/), not its repository: `platform validate app`, `platform validate archive`, the pull request's build validation and the portal's forms report them.",
    instance: "Checks of the instance configuration",
    instanceLead: "These check instance.yaml in platform-config, not an app: `platform validate instance`, the pull request's build validation and the portal's Settings report them.",
    provisioning: "Failures of provisioning",
    provisioningLead: "These aren't checks: the provisioning pipeline reports them when it couldn't set an app up, with the code in the run's report and on the app's request and page in the portal. The platform team acts on them; there is no prompt for an AI agent.",
    runbook: "Runbook",
  },
  cs: {
    error: "chyba",
    warning: "upozornění",
    note: "poznámka",
    severity: "Výsledek",
    fix: "Co dělat",
    prompt: "Prompt pro tvého AI agenta",
    pipeline: "Kontroly delivery pipeline",
    pipelineLead: "Nejsou to pravidla `platform check`: delivery pipeline je spouští po sestavení.",
    definition: "Kontroly definice aplikace",
    definitionLead: "Kontrolují definici aplikace v platform-config (apps/<slug>/app.yaml a definice smazaných aplikací v apps-deleted/), ne její repozitář: hlásí je `platform validate app`, `platform validate archive`, kontrola pull requestu a formuláře portálu.",
    instance: "Kontroly konfigurace instance",
    instanceLead: "Kontrolují instance.yaml v platform-config, ne aplikaci: hlásí je `platform validate instance`, kontrola pull requestu a Nastavení v portálu.",
    provisioning: "Selhání nastavování (provisioning)",
    provisioningLead: "Nejsou to kontroly: provisioning pipeline je hlásí, když aplikaci nedokázala nastavit, a kód uvidíš v reportu běhu i u požadavku a na stránce aplikace v portálu. Řeší je platform tým, prompt pro AI agenta k nim není.",
    runbook: "Runbook",
  },
} as const;

export const CATALOGUE_TITLE: LocalizedText = { en: "What the platform's checks mean", cs: "Co znamenají kontroly platformy" };
export const CATALOGUE_LEAD: LocalizedText = {
  en: "Every check of `platform check`, of the delivery pipeline, of an app definition and of the instance configuration, in plain words: what it found, what to do, and a prompt you can copy to your AI agent. The portal shows the same text next to a failed check. The failure codes of provisioning (PE001 and up) are at the end.",
  cs: "Každá kontrola `platform check`, delivery pipeline, definice aplikace i konfigurace instance lidsky: co našla, co dělat a prompt, který můžeš zkopírovat svému AI agentovi. Stejný text ukáže portál u neprošlé kontroly. Kódy selhání nastavování (PE001 a další) jsou na konci.",
};

/** One check, or one provisioning failure code (no prompt), as plain text for `platform rules --explain <id>`. undefined for an unknown ID. */
export function formatExplanation(id: string, lang: ExplanationLanguage): string | undefined {
  const failure = explainProvisioningFailure(id);
  if (failure) {
    const w = WORDS[lang];
    return [`${id}  ${failure.title[lang]}`, "", failure.text[lang], "", `${w.fix}: ${failure.fix[lang]}`, ...(failure.runbook ? ["", `${w.runbook}: docs/runbooks/${failure.runbook}.md`] : []), ""].join("\n");
  }
  const e = explainCheck(id);
  const prompt = checkAiPrompt(id, lang);
  if (!e || !prompt) return undefined;
  const w = WORDS[lang];
  return [`${id}  ${e.title[lang]}`, "", e.text[lang], "", `${w.fix}: ${e.fix[lang]}`, "", `${w.prompt}:`, ...prompt.split("\n").map((l) => `  ${l}`), ""].join("\n");
}

/**
 * The failure catalogue as Markdown (docs/user-guide/check-catalogue.{en,cs}.md are this text,
 * test/explanations.test.ts compares them): the rules by group, then the pipeline's own checks, the
 * checks of an app definition and of the instance, and the provisioning failure codes (ADR-0064).
 */
export function catalogueMarkdown(lang: ExplanationLanguage): string {
  const w = WORDS[lang];
  const out: string[] = [
    `# ${CATALOGUE_TITLE[lang]}`,
    "",
    `<!-- Generated by \`platform rules --explain all --lang ${lang} --format markdown\` from tools/platform-cli/src/explanations.ts. Don't edit by hand. -->`,
    "",
    CATALOGUE_LEAD[lang],
    "",
  ];
  const section = (id: string, result?: string): void => {
    const e = explainCheck(id)!;
    out.push(`### ${id}: ${e.title[lang]}`, "", ...(result ? [`${w.severity}: ${result}`, ""] : []), e.text[lang], "", `**${w.fix}:** ${e.fix[lang]}`, "", `**${w.prompt}:**`, "", "```text", checkAiPrompt(id, lang)!, "```", "");
  };
  for (const group of GROUP_ORDER) {
    out.push(`## ${CATALOGUE_GROUP_TITLES[group][lang]}`, "");
    // PC063 is an error for a configured readiness path and a warning for a 503 (rules.ts).
    for (const r of RULES.filter((x) => x.group === group)) section(r.id, r.id === "PC063" ? `${w.error} / ${w.warning}` : w[r.severity]);
  }
  out.push(`## ${w.pipeline}`, "", w.pipelineLead, "");
  for (const id of PIPELINE_CHECK_IDS) section(id);
  out.push(`## ${w.definition}`, "", w.definitionLead, "");
  for (const id of DEFINITION_CHECK_IDS) section(id);
  out.push(`## ${w.instance}`, "", w.instanceLead, "");
  for (const id of INSTANCE_CHECK_IDS) section(id);
  out.push(`## ${w.provisioning}`, "", w.provisioningLead, "");
  for (const id of PROVISIONING_FAILURE_IDS) {
    const f = explainProvisioningFailure(id)!;
    out.push(`### ${id}: ${f.title[lang]}`, "", f.text[lang], "", `**${w.fix}:** ${f.fix[lang]}`, "", ...(f.runbook ? [`**${w.runbook}:** \`docs/runbooks/${f.runbook}.md\``, ""] : []));
  }
  return `${out.join("\n").trimEnd()}\n`;
}
