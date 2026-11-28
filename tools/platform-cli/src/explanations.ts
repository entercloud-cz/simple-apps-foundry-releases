/**
 * The failure catalogue (US09.05): for every check rule (PC001...PC068, rules.ts) a plain-language
 * explanation in English and Czech and a prompt for the developer's AI agent. The portal shows
 * them next to a failed check and in the failure mail, `platform rules --explain` prints them, and
 * docs/user-guide/check-catalogue.{en,cs}.md is generated from them, so there is one text. The
 * provisioning pipeline's failure codes (PE001...PE010, ADR-0064) are here too, without prompts.
 *
 * Czech follows the portal's rules (ADR-0018): informal "ty", plain words, no Azure jargon where a
 * plain word exists. English is the source language.
 *
 * Browser-safe on purpose (package.json exports "./explanations"): no Node imports, so the portal's
 * SPA bundles it. Keep it that way.
 *
 * The prompts are written for the check, not for one finding: the portal knows a finding's rule,
 * file and line, never its message (a secret finding's message quotes part of the value).
 * checkAiPrompt() puts what the portal knows around the rule's text. The CLI's own per-finding
 * `aiPrompt` (checks/*.ts) stays richer: it has the message.
 */
import { canonicalRuleId } from "./rules.js";

export type ExplanationLanguage = "en" | "cs";
export type LocalizedText = Record<ExplanationLanguage, string>;

export interface CheckExplanation {
  /** What the check is, as a short statement of the problem: "The container would run as root". */
  title: LocalizedText;
  /** What it found and why the platform cares: one to three sentences. */
  text: LocalizedText;
  /** What to do, in plain words. */
  fix: LocalizedText;
  /** The instruction for an AI agent, without the framing checkAiPrompt() adds. */
  prompt: LocalizedText;
}

/** Explanations of the delivery pipeline's own checks (not rules of `platform check`). */
export const PIPELINE_CHECK_IDS = ["scan-gate", "deployment", "capacity-reservation"] as const;
export type PipelineCheckId = (typeof PIPELINE_CHECK_IDS)[number];

/** The rules of `platform check`, by ID. Every ID in RULES has an entry (test/explanations.test.ts). */
export const RULE_EXPLANATIONS: Readonly<Record<string, CheckExplanation>> = {
  PC001: {
    title: { en: "platform.yaml is missing or can't be read", cs: "Soubor platform.yaml chybí nebo ho nejde přečíst" },
    text: {
      en: "The platform reads how your app runs (its port, health paths and settings) from platform.yaml in the repository root. The file is missing or isn't valid YAML, so nothing else can be checked or deployed.",
      cs: "Platforma z platform.yaml v kořeni repozitáře čte, jak aplikace běží (port, adresy kontroly zdraví, nastavení). Soubor chybí nebo to není platné YAML, takže se nedá nic dalšího zkontrolovat ani nasadit.",
    },
    fix: {
      en: "Create or repair platform.yaml in the repository root. The file from the starter template is the best example.",
      cs: "Vytvoř nebo oprav platform.yaml v kořeni repozitáře. Nejlepším vzorem je soubor ze startovací šablony.",
    },
    prompt: {
      en: "Create or repair platform.yaml in the repository root. It must be valid YAML with schemaVersion and the registered app slug, following the platform.yaml schema (see the app-contract-and-docker skill). Change nothing else.",
      cs: "Vytvoř nebo oprav platform.yaml v kořeni repozitáře. Musí to být platné YAML se schemaVersion a zaregistrovanou zkratkou aplikace podle schématu platform.yaml (viz skill app-contract-and-docker). Nic jiného neměň.",
    },
  },
  PC002: {
    title: { en: "A setting in platform.yaml isn't valid", cs: "Nastavení v platform.yaml není platné" },
    text: {
      en: "platform.yaml has a value of the wrong type or outside the allowed range, or a setting the platform doesn't know. The file and line are shown next to the check.",
      cs: "V platform.yaml je hodnota špatného typu nebo mimo povolený rozsah, nebo nastavení, které platforma nezná. Soubor a řádek vidíš u kontroly.",
    },
    fix: {
      en: "Correct that setting. Running `platform check` on your computer prints the exact message.",
      cs: "Nastavení oprav. Přesnou zprávu vypíše `platform check` u tebe v počítači.",
    },
    prompt: {
      en: "Fix the setting in platform.yaml that doesn't match the schema (run `platform check` to see which setting and line). Keep every other setting unchanged.",
      cs: "Oprav nastavení v platform.yaml, které nesedí se schématem (`platform check` ukáže, které nastavení a na jakém řádku). Všechna ostatní nastavení nech beze změny.",
    },
  },
  PC003: {
    title: { en: "The settings in platform.yaml contradict each other", cs: "Nastavení v platform.yaml si odporují" },
    text: {
      en: "The file is valid, but its settings don't fit together. For example a secret is used in env but isn't listed in secrets, the app name is reserved, minReplicas is larger than maxReplicas, or an environment variable appears twice.",
      cs: "Soubor je platný, ale jeho nastavení k sobě nesedí. Třeba tajná hodnota je použitá v env, ale není v seznamu secrets, název aplikace je rezervovaný, minReplicas je větší než maxReplicas, nebo se jedna proměnná prostředí opakuje.",
    },
    fix: {
      en: "Make the settings consistent. `platform check` prints which settings clash.",
      cs: "Uprav nastavení tak, aby si neodporovala. Které se perou, vypíše `platform check`.",
    },
    prompt: {
      en: "platform.yaml is valid but inconsistent (for example a secret used in env but missing from secrets, minReplicas above maxReplicas, a duplicate environment variable). Run `platform check` to see the exact conflict and fix it without changing anything else.",
      cs: "platform.yaml je platný, ale nekonzistentní (například tajná hodnota použitá v env, která chybí v secrets, minReplicas nad maxReplicas, duplicitní proměnná prostředí). `platform check` ukáže přesný rozpor, oprav ho a nic jiného neměň.",
    },
  },
  PC010: {
    title: { en: "The Dockerfile is missing", cs: "Chybí Dockerfile" },
    text: {
      en: "The platform builds your app from a Dockerfile in the repository, or from the path set in build.dockerfile. It wasn't found, or it's empty or outside the repository.",
      cs: "Platforma sestavuje aplikaci z Dockerfile v repozitáři nebo z cesty nastavené v build.dockerfile. Nenašla ho, nebo je prázdný, nebo leží mimo repozitář.",
    },
    fix: {
      en: "Add a Dockerfile (the starter has one), or point build.dockerfile and build.context in platform.yaml to the right place.",
      cs: "Přidej Dockerfile (ve startovací šabloně je) nebo v platform.yaml nasměruj build.dockerfile a build.context na správné místo.",
    },
    prompt: {
      en: "Create or fix the Dockerfile (or the build.dockerfile and build.context settings in platform.yaml) following the app-contract-and-docker skill. The image must build the app and start it listening on the PORT variable.",
      cs: "Vytvoř nebo oprav Dockerfile (nebo nastavení build.dockerfile a build.context v platform.yaml) podle skillu app-contract-and-docker. Image musí aplikaci sestavit a spustit ji tak, aby poslouchala na portu z proměnné PORT.",
    },
  },
  PC011: {
    title: { en: "The base image isn't pinned to an exact version", cs: "Základní image není zafixovaný na přesnou verzi" },
    text: {
      en: "A FROM line in the Dockerfile uses a floating image such as latest, node:22 or no tag at all. Such an image changes without notice, so the same code can build differently tomorrow and a vulnerability can't be traced to a version.",
      cs: "Řádek FROM v Dockerfile používá pohyblivý image, třeba latest, node:22 nebo žádný tag. Takový image se mění bez upozornění, takže se stejný kód zítra může sestavit jinak a zranitelnost nejde dohledat k verzi.",
    },
    fix: {
      en: "Pin every FROM to an exact version such as node:22.11.0-alpine, or to a digest (@sha256:…).",
      cs: "Každý FROM zafixuj na přesnou verzi, třeba node:22.11.0-alpine, nebo na digest (@sha256:…).",
    },
    prompt: {
      en: "In the Dockerfile, pin every FROM to an exact version tag (x.y.z, for example node:22.11.0-alpine) or an @sha256 digest. Keep the same image flavour (alpine, slim, …). Don't use latest or a tag that names only a major version.",
      cs: "V Dockerfile zafixuj každý FROM na přesný tag verze (x.y.z, například node:22.11.0-alpine) nebo na digest @sha256. Zachovej stejnou variantu image (alpine, slim, …). Nepoužívej latest ani tag, který uvádí jen hlavní verzi.",
    },
  },
  PC012: {
    title: { en: "The container would run as root", cs: "Kontejner by běžel jako root" },
    text: {
      en: "The last stage of the Dockerfile doesn't switch to a normal user, so the app would run with full rights inside its container. The platform only runs apps as a non-privileged user.",
      cs: "Poslední stage Dockerfile nepřepíná na běžného uživatele, takže by aplikace uvnitř kontejneru běžela s plnými právy. Platforma spouští aplikace jen pod neprivilegovaným uživatelem.",
    },
    fix: {
      en: "Create a user in the Dockerfile and add a USER line for it just before CMD or ENTRYPOINT. Make sure that user can read the app files.",
      cs: "V Dockerfile vytvoř uživatele a těsně před CMD nebo ENTRYPOINT přidej řádek USER. Ověř, že ten uživatel smí číst soubory aplikace.",
    },
    prompt: {
      en: "Change the Dockerfile so the final stage runs as a non-root user: create a user (for example app), give it ownership of the app files and add USER app just before CMD or ENTRYPOINT.",
      cs: "Uprav Dockerfile tak, aby poslední stage běžela pod uživatelem bez práv roota: vytvoř uživatele (například app), dej mu vlastnictví souborů aplikace a těsně před CMD nebo ENTRYPOINT přidej USER app.",
    },
  },
  PC013: {
    title: { en: "The port in the Dockerfile doesn't match platform.yaml", cs: "Port v Dockerfile nesedí s platform.yaml" },
    text: {
      en: "EXPOSE or ENV PORT in the Dockerfile names another port than runtime.port in platform.yaml (8080 unless you changed it). The platform sends traffic to runtime.port, so the app wouldn't receive it.",
      cs: "EXPOSE nebo ENV PORT v Dockerfile uvádí jiný port než runtime.port v platform.yaml (8080, pokud jsi ho neměnil). Platforma posílá provoz na runtime.port, takže by ho aplikace nedostala.",
    },
    fix: {
      en: "Make them agree. The simplest way is to remove ENV PORT, let the app read the PORT variable, and keep EXPOSE equal to runtime.port.",
      cs: "Sjednoť je. Nejjednodušší je smazat ENV PORT, nechat aplikaci číst proměnnou PORT a nechat EXPOSE stejný jako runtime.port.",
    },
    prompt: {
      en: "Make the port consistent: EXPOSE and ENV PORT in the Dockerfile must equal runtime.port in platform.yaml. Prefer removing ENV PORT and letting the app read the PORT environment variable (default: runtime.port).",
      cs: "Sjednoť port: EXPOSE a ENV PORT v Dockerfile se musí rovnat runtime.port v platform.yaml. Nejlépe smaž ENV PORT a nech aplikaci číst proměnnou prostředí PORT (výchozí hodnota: runtime.port).",
    },
  },
  PC014: {
    title: { en: "The Dockerfile doesn't say which port the app uses", cs: "Dockerfile neuvádí, na kterém portu aplikace běží" },
    text: {
      en: "The last stage has no EXPOSE line. The app can still work, but the line documents the port and some tools rely on it.",
      cs: "Poslední stage nemá řádek EXPOSE. Aplikace může fungovat, ale řádek port dokumentuje a spoléhají na něj některé nástroje.",
    },
    fix: {
      en: "Add EXPOSE with the port from runtime.port (8080 unless you changed it) to the last stage.",
      cs: "Do poslední stage přidej EXPOSE s portem z runtime.port (8080, pokud jsi ho neměnil).",
    },
    prompt: {
      en: "Add an EXPOSE line with the runtime.port from platform.yaml to the final stage of the Dockerfile.",
      cs: "Do poslední stage Dockerfile přidej řádek EXPOSE s hodnotou runtime.port z platform.yaml.",
    },
  },
  PC020: {
    title: { en: "A secret is in the code", cs: "V kódu je tajná hodnota" },
    text: {
      en: "A password, key or token was found in a file of the repository. Everyone who can read the repository can use it, and it stays in the git history even after you delete the file.",
      cs: "V souboru repozitáře se našlo heslo, klíč nebo token. Může ho použít každý, kdo repozitář čte, a zůstává v historii gitu i po smazání souboru.",
    },
    fix: {
      en: "Remove it from the code and replace it with a new one: the old one counts as leaked. Add the new value in the app's Secrets tab and let the app read it from an environment variable.",
      cs: "Odstraň ji z kódu a nahraď ji novou, stará se považuje za vyzrazenou. Novou hodnotu přidej v záložce Tajné hodnoty u aplikace a nech aplikaci číst ji z proměnné prostředí.",
    },
    prompt: {
      en: "Remove the hard-coded secret from the file named in the check and read the value from an environment variable instead. Declare the secret in platform.yaml under secrets so the platform supplies it. Never print or copy the value anywhere. Tell me that the exposed secret must be replaced with a new one, because the old one is compromised.",
      cs: "Odstraň napevno zapsanou tajnou hodnotu ze souboru uvedeného u kontroly a čti ji z proměnné prostředí. Tajnou hodnotu uveď v platform.yaml v seznamu secrets, aby ji platforma dodala. Hodnotu nikam nevypisuj ani nekopíruj. Napiš mi, že se prozrazená hodnota musí nahradit novou, protože ta stará je vyzrazená.",
    },
  },
  PC021: {
    title: { en: "A second scanner found a secret in the code", cs: "Druhý skener našel v kódu tajnou hodnotu" },
    text: {
      en: "The secret scanner gitleaks found a password, key or token in a file of the repository. Everyone who can read the repository can use it, and it stays in the git history even after you delete the file.",
      cs: "Skener tajných hodnot gitleaks našel v souboru repozitáře heslo, klíč nebo token. Může ho použít každý, kdo repozitář čte, a zůstává v historii gitu i po smazání souboru.",
    },
    fix: {
      en: "Remove it from the code and replace it with a new one: the old one counts as leaked. Add the new value in the app's Secrets tab and let the app read it from an environment variable.",
      cs: "Odstraň ji z kódu a nahraď ji novou, stará se považuje za vyzrazenou. Novou hodnotu přidej v záložce Tajné hodnoty u aplikace a nech aplikaci číst ji z proměnné prostředí.",
    },
    prompt: {
      en: "Remove the hard-coded secret from the file named in the check and read the value from an environment variable instead. Declare the secret in platform.yaml under secrets so the platform supplies it. Never print or copy the value anywhere. Tell me that the exposed secret must be replaced with a new one, because the old one is compromised.",
      cs: "Odstraň napevno zapsanou tajnou hodnotu ze souboru uvedeného u kontroly a čti ji z proměnné prostředí. Tajnou hodnotu uveď v platform.yaml v seznamu secrets, aby ji platforma dodala. Hodnotu nikam nevypisuj ani nekopíruj. Napiš mi, že se prozrazená hodnota musí nahradit novou, protože ta stará je vyzrazená.",
    },
  },
  PC030: {
    title: { en: "An .env file is committed", cs: "V repozitáři je soubor .env" },
    text: {
      en: "Files like .env hold real settings and often passwords, so they must never be committed. The platform supplies settings and secrets to the app itself.",
      cs: "Soubory jako .env obsahují skutečná nastavení a často hesla, takže se nesmí commitovat. Nastavení a tajné hodnoty platforma aplikaci dodá sama.",
    },
    fix: {
      en: "Remove the file from git (git rm --cached) and add it to .gitignore. Keep only an example.env with made-up values. If it held a real secret, replace that secret: it counts as leaked.",
      cs: "Soubor odeber z gitu (git rm --cached) a přidej ho do .gitignore. Nech jen example.env s vymyšlenými hodnotami. Pokud obsahoval skutečnou tajnou hodnotu, nahraď ji: považuje se za vyzrazenou.",
    },
    prompt: {
      en: "Remove the committed env file from version control (git rm --cached) and add it to .gitignore. Create or refresh example.env (not .env.example) with placeholder values only. If the file held a real secret, tell me so it can be replaced.",
      cs: "Odeber commitnutý soubor s proměnnými prostředí z verzování (git rm --cached) a přidej ho do .gitignore. Vytvoř nebo aktualizuj example.env (ne .env.example) jen se zástupnými hodnotami. Pokud soubor obsahoval skutečnou tajnou hodnotu, napiš mi to, aby se mohla nahradit.",
    },
  },
  PC031: {
    title: { en: "Build output or installed packages are committed", cs: "V repozitáři je výstup sestavení nebo nainstalované balíčky" },
    text: {
      en: "A bin/, obj/ or node_modules/ folder is in the repository. The Docker build creates these folders itself, so in git they only make the repository big and slow.",
      cs: "V repozitáři je složka bin/, obj/ nebo node_modules/. Docker build je vytvoří sám, takže v gitu jen zvětšují repozitář a zpomalují ho.",
    },
    fix: {
      en: "Remove the folder from git (git rm -r --cached) and add it to .gitignore and .dockerignore.",
      cs: "Složku odeber z gitu (git rm -r --cached) a přidej ji do .gitignore a .dockerignore.",
    },
    prompt: {
      en: "Remove the folder named in the check from version control (git rm -r --cached) and add it to .gitignore and .dockerignore.",
      cs: "Odeber složku uvedenou u kontroly z verzování (git rm -r --cached) a přidej ji do .gitignore a .dockerignore.",
    },
  },
  PC032: {
    title: { en: "A file is too large", cs: "Soubor je příliš velký" },
    text: {
      en: "A file in the repository is larger than the allowed size. Large files slow down every clone and build, and rarely belong in git.",
      cs: "Soubor v repozitáři je větší, než je povoleno. Velké soubory zpomalují každý klon i sestavení a do gitu většinou nepatří.",
    },
    fix: {
      en: "Remove it from git. Fetch or generate it during the Docker build, or keep it in the app's file storage.",
      cs: "Odeber ho z gitu. Stáhni ho nebo vygeneruj při Docker buildu, případně ho ulož do úložiště souborů aplikace.",
    },
    prompt: {
      en: "Remove the large file named in the check from version control (git rm, and add it to .gitignore). Fetch or generate it during the Docker build, or keep it in the app's file storage instead.",
      cs: "Odeber velký soubor uvedený u kontroly z verzování (git rm a přidej ho do .gitignore). Stahuj ho nebo generuj při Docker buildu, případně ho ukládej do úložiště souborů aplikace.",
    },
  },
  PC033: {
    title: { en: "A key or certificate file is committed", cs: "V repozitáři je soubor s klíčem nebo certifikátem" },
    text: {
      en: "A key or certificate store (.pfx, .p12, .jks, .key and similar) is in the repository. These files hold private keys that must stay secret.",
      cs: "V repozitáři je úložiště klíčů nebo certifikátů (.pfx, .p12, .jks, .key a podobné). Takové soubory obsahují soukromé klíče, které musí zůstat tajné.",
    },
    fix: {
      en: "Remove the file from the repository and its history, store the material in the app's secrets, and replace the key: it counts as leaked.",
      cs: "Soubor odstraň z repozitáře i z jeho historie, materiál ulož do tajných hodnot aplikace a klíč vyměň: považuje se za vyzrazený.",
    },
    prompt: {
      en: "Remove the key or certificate file named in the check from the repository (and from its history if it holds a private key). Load the material from the app's secrets through the secrets list in platform.yaml instead, and tell me the key must be replaced.",
      cs: "Odstraň soubor s klíčem nebo certifikátem uvedený u kontroly z repozitáře (a z jeho historie, pokud obsahuje soukromý klíč). Materiál místo toho načítej z tajných hodnot aplikace přes seznam secrets v platform.yaml a napiš mi, že se klíč musí vyměnit.",
    },
  },
  PC040: {
    title: { en: "CHANGELOG.md wasn't updated", cs: "CHANGELOG.md se neaktualizoval" },
    text: {
      en: "The code changed but CHANGELOG.md didn't. The changelog is how owners, approvers and users learn what changed in a version.",
      cs: "Změnil se kód, ale CHANGELOG.md ne. Podle changelogu se vlastníci, schvalovatelé i uživatelé dozvědí, co se v dané verzi změnilo.",
    },
    fix: {
      en: "Add one or two plain lines under [Unreleased] that say what changes for the people using the app.",
      cs: "Pod [Unreleased] přidej jeden nebo dva jednoduché řádky o tom, co se mění pro lidi, kteří aplikaci používají.",
    },
    prompt: {
      en: "Summarise the changes in one or two plain-language lines under [Unreleased] in CHANGELOG.md: what changes for the people using the app, not implementation details.",
      cs: "Shrň změny v jednom nebo dvou jednoduchých řádcích pod [Unreleased] v CHANGELOG.md: co se mění pro lidi, kteří aplikaci používají, ne technické detaily.",
    },
  },
  PC041: {
    title: { en: "README.md or CHANGELOG.md is missing", cs: "Chybí README.md nebo CHANGELOG.md" },
    text: {
      en: "Every app repository needs a README.md (what the app does, how to run it, who owns it) and a CHANGELOG.md. The next person, or the next AI agent, starts from them.",
      cs: "Každý repozitář aplikace potřebuje README.md (co aplikace dělá, jak ji spustit, kdo ji vlastní) a CHANGELOG.md. Od nich začíná další člověk nebo další AI agent.",
    },
    fix: {
      en: "Add the missing file. The starter template has both.",
      cs: "Přidej chybějící soubor. Startovací šablona obsahuje oba.",
    },
    prompt: {
      en: "Create the missing README.md (what the app does, how to run it locally, who owns it) or CHANGELOG.md (Keep a Changelog format with an [Unreleased] section) in the repository root.",
      cs: "V kořeni repozitáře vytvoř chybějící README.md (co aplikace dělá, jak ji spustit lokálně, kdo ji vlastní) nebo CHANGELOG.md (formát Keep a Changelog se sekcí [Unreleased]).",
    },
  },
  PC050: {
    title: { en: "An AI skill file is invalid", cs: "Soubor se skillem pro AI je neplatný" },
    text: {
      en: "A SKILL.md under .agents/skills/ is missing or has an invalid header: its name must equal the folder name and it needs a description. AI agents can't load such a skill.",
      cs: "Soubor SKILL.md v .agents/skills/ chybí nebo má neplatnou hlavičku: jeho name se musí rovnat názvu složky a musí mít description. AI agenti takový skill nenačtou.",
    },
    fix: {
      en: "Fix the header of that SKILL.md (name = folder name, lowercase letters, digits and single hyphens; a description of 1 to 1024 characters), then run `platform sync-agent-files`.",
      cs: "Oprav hlavičku toho SKILL.md (name = název složky, malá písmena, číslice a jednotlivé pomlčky; description o 1 až 1024 znacích) a spusť `platform sync-agent-files`.",
    },
    prompt: {
      en: "Fix the frontmatter of the SKILL.md named in the check: name must equal the folder name (lowercase letters, digits and single hyphens) and description must be 1 to 1024 characters. Then run `platform sync-agent-files`.",
      cs: "Oprav frontmatter v SKILL.md uvedeném u kontroly: name se musí rovnat názvu složky (malá písmena, číslice a jednotlivé pomlčky) a description musí mít 1 až 1024 znaků. Potom spusť `platform sync-agent-files`.",
    },
  },
  PC051: {
    title: { en: "The copy of the AI skills is out of date", cs: "Kopie skillů pro AI je zastaralá" },
    text: {
      en: ".claude/skills/ must be an exact copy of .agents/skills/. They differ, so different AI tools would follow different instructions.",
      cs: ".claude/skills/ musí být přesná kopie .agents/skills/. Liší se, takže by různé AI nástroje řídily různé pokyny.",
    },
    fix: {
      en: "Edit skills only in .agents/skills/ and run `platform sync-agent-files` to refresh the copy.",
      cs: "Skilly upravuj jen v .agents/skills/ a kopii obnov příkazem `platform sync-agent-files`.",
    },
    prompt: {
      en: "Make sure the intended change is in .agents/skills/, then run `platform sync-agent-files` to regenerate .claude/skills/. Never edit the .claude/skills copy by hand.",
      cs: "Ověř, že zamýšlená změna je v .agents/skills/, a potom spusť `platform sync-agent-files`, které přegeneruje .claude/skills/. Kopii v .claude/skills nikdy neupravuj ručně.",
    },
  },
  PC052: {
    title: { en: "CLAUDE.md doesn't import AGENTS.md", cs: "CLAUDE.md nenačítá AGENTS.md" },
    text: {
      en: "CLAUDE.md must start with the line @AGENTS.md, so Claude reads the same instructions as every other AI tool.",
      cs: "CLAUDE.md musí začínat řádkem @AGENTS.md, aby Claude četl stejné pokyny jako všechny ostatní AI nástroje.",
    },
    fix: {
      en: "Run `platform sync-agent-files` to repair it.",
      cs: "Spusť `platform sync-agent-files`, soubor se opraví.",
    },
    prompt: {
      en: "CLAUDE.md must start with the line @AGENTS.md and only import it. Run `platform sync-agent-files` to repair it.",
      cs: "CLAUDE.md musí začínat řádkem @AGENTS.md a jen ho načítat. Oprav ho příkazem `platform sync-agent-files`.",
    },
  },
  PC053: {
    title: { en: "AGENTS.md is missing or too long", cs: "AGENTS.md chybí nebo je příliš dlouhý" },
    text: {
      en: "AGENTS.md is the one set of instructions every AI tool reads. It's missing, or at 32 KiB or more it's too long to be read reliably.",
      cs: "AGENTS.md je jedna sada pokynů, kterou čte každý AI nástroj. Chybí, nebo je s 32 KiB a víc příliš dlouhý na to, aby se četl spolehlivě.",
    },
    fix: {
      en: "Restore it from the starter template. If it's too long, move detailed procedures into skills in .agents/skills/ and keep AGENTS.md short.",
      cs: "Obnov ho ze startovací šablony. Pokud je moc dlouhý, přesuň podrobné postupy do skillů v .agents/skills/ a AGENTS.md nech krátký.",
    },
    prompt: {
      en: "AGENTS.md is missing or 32 KiB or larger. Restore it from the app template, or move detailed procedures into skills in .agents/skills/<name>/SKILL.md and keep AGENTS.md short. Then run `platform sync-agent-files`.",
      cs: "AGENTS.md chybí nebo má 32 KiB a víc. Obnov ho ze šablony aplikace, nebo přesuň podrobné postupy do skillů v .agents/skills/<name>/SKILL.md a AGENTS.md nech krátký. Potom spusť `platform sync-agent-files`.",
    },
  },
  PC054: {
    title: { en: "A symbolic link in the AI agent files", cs: "V souborech pro AI agenty je symbolický odkaz" },
    text: {
      en: "Symbolic links in agent files don't survive every checkout (Windows in particular) and can point outside the repository, so they aren't allowed.",
      cs: "Symbolické odkazy v souborech pro agenty nepřežijí každý checkout (hlavně na Windows) a mohou ukazovat mimo repozitář, proto nejsou povolené.",
    },
    fix: {
      en: "Replace each link with a real file or folder copy, then run `platform sync-agent-files`.",
      cs: "Každý odkaz nahraď skutečnou kopií souboru nebo složky a spusť `platform sync-agent-files`.",
    },
    prompt: {
      en: "Replace the symbolic link named in the check with a real file or folder copy (no symlinks in agent files), then run `platform sync-agent-files`.",
      cs: "Nahraď symbolický odkaz uvedený u kontroly skutečnou kopií souboru nebo složky (v souborech pro agenty nejsou odkazy povolené) a spusť `platform sync-agent-files`.",
    },
  },
  PC055: {
    title: { en: "A helper file for AI tools is missing or wrong", cs: "Pomocný soubor pro AI nástroje chybí nebo je špatně" },
    text: {
      en: "One of the small generated files (.gemini/settings.json, .claude/settings.json, .gitattributes or the Copilot pointer) is missing or has the wrong content. Some AI tools may then miss the platform's instructions.",
      cs: "Jeden z malých generovaných souborů (.gemini/settings.json, .claude/settings.json, .gitattributes nebo odkaz pro Copilota) chybí nebo má špatný obsah. Některé AI nástroje pak nemusí najít pokyny platformy.",
    },
    fix: {
      en: "Run `platform sync-agent-files` to create or repair it.",
      cs: "Spusť `platform sync-agent-files`, soubor se vytvoří nebo opraví.",
    },
    prompt: {
      en: "Run `platform sync-agent-files` to create or repair the helper file named in the check.",
      cs: "Spusť `platform sync-agent-files`, které vytvoří nebo opraví pomocný soubor uvedený u kontroly.",
    },
  },
  PC056: {
    title: { en: "The Copilot instructions file is too long", cs: "Soubor s pokyny pro Copilota je příliš dlouhý" },
    text: {
      en: ".github/copilot-instructions.md should be a short pointer to AGENTS.md. A long one means the rules live in two places and drift apart.",
      cs: ".github/copilot-instructions.md má být krátký odkaz na AGENTS.md. Dlouhý soubor znamená, že pravidla žijí na dvou místech a rozcházejí se.",
    },
    fix: {
      en: "Shorten it to a pointer and move any rules into AGENTS.md or a skill.",
      cs: "Zkrať ho na odkaz a pravidla přesuň do AGENTS.md nebo do skillu.",
    },
    prompt: {
      en: "Reduce .github/copilot-instructions.md to a short pointer to AGENTS.md and move any rules it holds into AGENTS.md or a skill.",
      cs: "Zkrať .github/copilot-instructions.md na krátký odkaz na AGENTS.md a pravidla, která obsahuje, přesuň do AGENTS.md nebo do skillu.",
    },
  },
  PC057: {
    title: { en: "The agent files are out of date", cs: "Soubory pro AI agenta jsou zastaralé" },
    text: {
      en: "The platform has improved the instructions and skills for AI agents (AGENTS.md, the skills in .agents/skills, the tool settings) since this repository got its copy. The platform never pushes them into the repository: the repository takes them when you update it, so your agent works with the old rules until then.",
      cs: "Platforma od doby, kdy repozitář dostal svou kopii, vylepšila pokyny a skills pro AI agenty (AGENTS.md, skills v .agents/skills, nastavení nástrojů). Do repozitáře je sama nikdy nepushuje: repozitář si je vezme, až ho aktualizuješ, takže do té doby tvůj agent pracuje podle starých pravidel.",
    },
    fix: {
      en: "Run `platform agent-files update`, look at the diff and commit it. Your notes in the app-specific section of AGENTS.md stay.",
      cs: "Spusť `platform agent-files update`, prohlédni si změny a commitni je. Tvoje poznámky v sekci pro konkrétní aplikaci v AGENTS.md zůstanou.",
    },
    prompt: {
      en: "Run `platform agent-files update` to take the platform's current agent files. Show me what changed (git diff), run `platform check`, and commit the update with my OK. Don't change the app's code for it.",
      cs: "Spusť `platform agent-files update` a vezmi si aktuální soubory pro AI agenta od platformy. Ukaž mi, co se změnilo (git diff), spusť `platform check` a s mým souhlasem aktualizaci commitni. Kód aplikace kvůli tomu neměň.",
    },
  },
  PC060: {
    title: { en: "The container test couldn't run", cs: "Test kontejneru se nemohl spustit" },
    text: {
      en: "The check that builds and starts your app needs Docker, and Docker wasn't available where the checks ran. The pipeline treats a skipped test as failed.",
      cs: "Kontrola, která aplikaci sestaví a spustí, potřebuje Docker, a ten tam, kde kontroly běžely, nebyl. Pipeline bere přeskočený test jako selhání.",
    },
    fix: {
      en: "On your computer, start Docker and run `platform check` again. If it happened in the pipeline, tell the platform team: your code isn't the cause.",
      cs: "U sebe spusť Docker a znovu `platform check`. Pokud se to stalo v pipeline, dej vědět platform týmu: příčina není v tvém kódu.",
    },
    prompt: {
      en: "The container test of `platform check` could not run because Docker isn't available. Start Docker and run `platform check` again. Don't change the code for this.",
      cs: "Test kontejneru v `platform check` se nemohl spustit, protože není dostupný Docker. Spusť Docker a znovu `platform check`. Kvůli tomu neměň kód.",
    },
  },
  PC061: {
    title: { en: "The Docker build failed", cs: "Docker build selhal" },
    text: {
      en: "Building the image from your Dockerfile failed, so there is nothing to start or deploy.",
      cs: "Sestavení image z tvého Dockerfile selhalo, takže není co spustit ani nasadit.",
    },
    fix: {
      en: "Run `docker build .` on your computer, read the error at the end of its output and fix it. Keep the Dockerfile rules: a pinned base image and a non-root user.",
      cs: "U sebe spusť `docker build .`, přečti chybu na konci výstupu a oprav ji. Dodrž pravidla pro Dockerfile: zafixovaný základní image a neprivilegovaný uživatel.",
    },
    prompt: {
      en: "`docker build` fails for this repository. Run it locally, read the error and fix the cause without weakening the Dockerfile rules (pinned base image, non-root USER).",
      cs: "`docker build` v tomto repozitáři selhává. Spusť ho lokálně, přečti chybu a oprav příčinu, aniž bys oslabil pravidla pro Dockerfile (zafixovaný základní image, USER bez práv roota).",
    },
  },
  PC062: {
    title: { en: "The app doesn't answer its health check", cs: "Aplikace neodpovídá na kontrolu zdraví" },
    text: {
      en: "The platform starts the container with only the PORT variable set and asks the liveness path (/healthz unless you chose another) for a 200 answer. The app didn't answer in time, so the platform can't tell it's alive.",
      cs: "Platforma spustí kontejner jen s proměnnou PORT a na adrese kontroly života (/healthz, pokud sis nezvolil jinou) čeká odpověď 200. Aplikace včas neodpověděla, takže platforma nepozná, že žije.",
    },
    fix: {
      en: "Make the app start without a database or secrets, listen on 0.0.0.0 and the PORT, and answer 200 on the liveness path.",
      cs: "Uprav aplikaci tak, aby naběhla i bez databáze a tajných hodnot, poslouchala na 0.0.0.0 a na portu z PORT a na adrese kontroly života vracela 200.",
    },
    prompt: {
      en: "The container doesn't answer the liveness path with 200 in time when it runs with only PORT set. Add or fix the health endpoint (runtime.health.liveness in platform.yaml, /healthz by default), make the app listen on 0.0.0.0:$PORT and start without a database or secrets.",
      cs: "Kontejner spuštěný jen s PORT včas neodpoví na adrese kontroly života kódem 200. Přidej nebo oprav health endpoint (runtime.health.liveness v platform.yaml, výchozí /healthz), nech aplikaci poslouchat na 0.0.0.0:$PORT a startovat bez databáze a tajných hodnot.",
    },
  },
  PC063: {
    title: { en: "The app doesn't say when it is ready", cs: "Aplikace neoznámí, kdy je připravená" },
    text: {
      en: "The readiness path (runtime.health.readiness) didn't answer 200. The platform sends traffic to a new version only once that path says it's ready. A 503 while the app waits for a database the test doesn't provide is only a warning.",
      cs: "Adresa připravenosti (runtime.health.readiness) neodpověděla 200. Platforma posílá provoz na novou verzi, až když tato adresa hlásí, že je připravená. Odpověď 503, když aplikace čeká na databázi, kterou test nemá, je jen upozornění.",
    },
    fix: {
      en: "Add or fix the readiness endpoint so it returns 200 once the app can serve requests, and set runtime.health.readiness if you use another path.",
      cs: "Přidej nebo oprav adresu připravenosti tak, aby vracela 200, jakmile aplikace umí obsluhovat požadavky, a pokud používáš jinou cestu, nastav runtime.health.readiness.",
    },
    prompt: {
      en: "Add or fix a readiness endpoint that returns HTTP 200 once the app can serve requests (set runtime.health.readiness in platform.yaml if you use another path). If it returns 503 only because it waits for a database, storage or secrets that the platform provides, leave it as it is.",
      cs: "Přidej nebo oprav endpoint připravenosti, který vrací HTTP 200, jakmile aplikace umí obsluhovat požadavky (pokud používáš jinou cestu, nastav runtime.health.readiness v platform.yaml). Pokud vrací 503 jen proto, že čeká na databázi, úložiště nebo tajné hodnoty, které dodá platforma, nech to tak.",
    },
  },
  PC064: {
    title: { en: "The running container is root", cs: "Běžící kontejner je root" },
    text: {
      en: "The container actually runs as the root user (uid 0), whatever the Dockerfile suggests. The platform doesn't run apps with those rights.",
      cs: "Kontejner skutečně běží jako uživatel root (uid 0), ať Dockerfile naznačuje cokoli. Platforma s takovými právy aplikace nespouští.",
    },
    fix: {
      en: "Add a non-root USER to the last stage of the Dockerfile and make sure that user can read the app files.",
      cs: "Do poslední stage Dockerfile přidej USER bez práv roota a ověř, že smí číst soubory aplikace.",
    },
    prompt: {
      en: "The running container is uid 0. Add a non-root USER to the final Dockerfile stage and make sure the app files are readable by it.",
      cs: "Běžící kontejner má uid 0. Přidej do poslední stage Dockerfile USER bez práv roota a ověř, že soubory aplikace smí číst.",
    },
  },
  PC065: {
    title: { en: "The container stopped right after it started", cs: "Kontejner se po spuštění hned zastavil" },
    text: {
      en: "The app exited before it became healthy. Usually it needs a setting, a secret or a database that the test doesn't provide, and gives up instead of starting without it.",
      cs: "Aplikace skončila dřív, než byla zdravá. Obvykle potřebuje nastavení, tajnou hodnotu nebo databázi, které test nemá, a místo aby naběhla bez nich, to vzdá.",
    },
    fix: {
      en: "Run the container locally with only PORT set, read its log, and make the app start anyway: read settings from environment variables and cope with a missing database.",
      cs: "Spusť kontejner u sebe jen s PORT, přečti si jeho log a uprav aplikaci, aby naběhla i tak: nastavení čti z proměnných prostředí a počítej s tím, že databáze chybí.",
    },
    prompt: {
      en: "The container exits at startup when it runs with only PORT set. Run it that way locally, read the log and make the app start without secrets or a database (read config from environment variables), listening on $PORT.",
      cs: "Kontejner spuštěný jen s PORT při startu skončí. Spusť ho takhle lokálně, přečti log a uprav aplikaci, aby naběhla bez tajných hodnot a databáze (konfiguraci čti z proměnných prostředí) a poslouchala na $PORT.",
    },
  },
  PC066: {
    title: { en: "The app's roles aren't enforced by default", cs: "Role aplikace se automaticky nehlídají" },
    text: {
      en: "The app has sign-in, but the platform's default access policy, or the test that checks it, is missing. Without it, any signed-in user may do what a route doesn't forbid explicitly: a Reader could change data.",
      cs: "Aplikace má přihlášení, ale chybí výchozí pravidla přístupu platformy nebo test, který je kontroluje. Bez nich smí každý přihlášený uživatel všechno, co cesta výslovně nezakáže: i Reader by mohl měnit data.",
    },
    fix: {
      en: "Ask your AI agent to add the default access policy and its contract test (skill auth-entra): reading needs the level read, changing data write, the settings admin.",
      cs: "Požádej AI agenta, ať doplní výchozí pravidla přístupu a jejich test (skill auth-entra): čtení potřebuje úroveň read, změny dat write, nastavení admin.",
    },
    prompt: {
      en: "Load the skill auth-entra and add the platform's default access policy (deny by default on every /api route; GET needs level read, POST/PUT/PATCH/DELETE write, /api/admin/** and /api/settings/** admin; levels from .platform/roles.json; exceptions only on their route), marked with saf:access-policy, and its contract test marked with saf:access-contract-test. Run the tests and platform check.",
      cs: "Načti skill auth-entra a doplň výchozí pravidla přístupu platformy (na každé cestě /api je vše zakázané, co není povolené; GET potřebuje úroveň read, POST/PUT/PATCH/DELETE write, /api/admin/** a /api/settings/** admin; úrovně z .platform/roles.json; výjimky jen u své cesty) s označením saf:access-policy a jejich test s označením saf:access-contract-test. Spusť testy a platform check.",
    },
  },
  PC067: {
    title: { en: "A role can't do anything yet", cs: "Role zatím nic nesmí" },
    text: {
      en: "A role of the app has no level (see, change data, manage the app), so the app gives the people with it no access.",
      cs: "Role aplikace nemá úroveň (vidí, mění data, spravuje aplikaci), takže lidé s touto rolí v aplikaci nemají žádný přístup.",
    },
    fix: {
      en: "Set the role's level on the app's Access tab in the portal, then update the agent files (platform agent-files update).",
      cs: "Nastav úroveň role na záložce Přístup v portálu a pak aktualizuj soubory pro agenta (platform agent-files update).",
    },
    prompt: {
      en: "A role in .platform/roles.json has no level. Tell the user to set its level on the app's Access tab in the portal, then run platform agent-files update and commit the result. Don't edit .platform/roles.json by hand.",
      cs: "Role v .platform/roles.json nemá úroveň. Řekni uživateli, ať ji nastaví na záložce Přístup v portálu, pak spusť platform agent-files update a výsledek commitni. .platform/roles.json neupravuj ručně.",
    },
  },
  PC068: {
    title: { en: "The app doesn't show who is signed in", cs: "Aplikace neukazuje, kdo je přihlášený" },
    text: {
      en: "Every app with sign-in shows the signed-in user, their roles, Sign out and Sign in as another user. This one has no sign-out link.",
      cs: "Každá aplikace s přihlášením ukazuje přihlášeného uživatele, jeho role, odhlášení a přihlášení jiného uživatele. Tahle nemá odkaz na odhlášení.",
    },
    fix: {
      en: "Ask your AI agent to add the user menu (skill ui-and-brand).",
      cs: "Požádej AI agenta, ať doplní nabídku uživatele (skill ui-and-brand).",
    },
    prompt: {
      en: "Load the skill ui-and-brand and add the user menu: the signed-in user's name and email (from /api/me), their roles with what each may do, Sign out (/.auth/logout?post_logout_redirect_uri=/) and Sign in as another user (/.auth/login/aad?prompt=select_account&post_login_redirect_uri=/).",
      cs: "Načti skill ui-and-brand a doplň nabídku uživatele: jméno a e-mail přihlášeného uživatele (z /api/me), jeho role s tím, co smí, odhlášení (/.auth/logout?post_logout_redirect_uri=/) a přihlášení jiného uživatele (/.auth/login/aad?prompt=select_account&post_login_redirect_uri=/).",
    },
  },
};

export const PIPELINE_EXPLANATIONS: Readonly<Record<PipelineCheckId, CheckExplanation>> = {
  "scan-gate": {
    title: { en: "Vulnerabilities stop the release to production", cs: "Zranitelnosti zastavují nasazení do produkce" },
    text: {
      en: "The image contains vulnerabilities that are too serious to run in production. The release is held back until they're fixed, and the version that ran before keeps running.",
      cs: "Image obsahuje zranitelnosti, které jsou na produkci příliš závažné. Nasazení se zastaví, dokud se neopraví, a dosavadní verze dál běží.",
    },
    fix: {
      en: "Update the base image and the packages named in the results to the fixed versions and push. The new build is checked again.",
      cs: "Aktualizuj základní image a balíčky uvedené ve výsledcích na opravené verze a pushni. Nová verze se zkontroluje znovu.",
    },
    prompt: {
      en: "The production scan gate rejected the image: it contains vulnerabilities that have to be fixed before production. Update the base image in the Dockerfile and the dependencies to the fixed versions, then rebuild.",
      cs: "Kontrola zranitelností před produkcí image odmítla: obsahuje zranitelnosti, které se musí opravit před nasazením do produkce. Aktualizuj základní image v Dockerfile a závislosti na opravené verze a znovu sestav.",
    },
  },
  deployment: {
    title: { en: "The deployment didn't finish", cs: "Nasazení se nedokončilo" },
    text: {
      en: "The version was built and checked, but its deployment to the environment or the smoke test after it failed: it didn't start there or didn't answer its health check. The version that ran before keeps running.",
      cs: "Verze se sestavila a prošla kontrolami, ale její nasazení do prostředí nebo smoke test po něm selhal: v prostředí nenaběhla nebo neodpověděla na kontrolu zdraví. Dosavadní verze dál běží.",
    },
    fix: {
      en: "Open the app's Logs tab to see what the new version printed at startup. Typical causes are a missing environment variable or secret, a database that can't be reached and a port mismatch. Fix it and push again.",
      cs: "V záložce Logy u aplikace uvidíš, co nová verze při startu vypsala. Typické příčiny jsou chybějící proměnná nebo tajná hodnota, nedostupná databáze a nesedící port. Oprav to a pushni znovu.",
    },
    prompt: {
      en: "The deployment failed after the build and the checks passed: the new version didn't start in the environment or didn't answer its health check. Find the cause (a missing environment variable or secret, an unreachable database, a port mismatch) from the app's logs and the run, and fix it in the repository. The app must start with the variables the platform injects and answer on the liveness path.",
      cs: "Nasazení selhalo poté, co sestavení i kontroly prošly: nová verze v prostředí nenaběhla nebo neodpověděla na kontrolu zdraví. Příčinu (chybějící proměnná prostředí nebo tajná hodnota, nedostupná databáze, nesedící port) najdi v logu aplikace a v běhu a oprav ji v repozitáři. Aplikace musí naběhnout s proměnnými, které platforma dodá, a odpovídat na adrese kontroly života.",
    },
  },
  "capacity-reservation": {
    title: { en: "The app asks for more capacity than it has reserved", cs: "Aplikace chce víc výkonu, než má rezervováno" },
    text: {
      en: "Every app has a capacity reservation in each environment: the largest container size and the most copies (replicas) it may run. The platform keeps that much free for it and promises the rest to other apps. platform.yaml sets a larger size or more replicas than the reservation, so the app could take capacity other apps were promised. New checks warn first: until the date in the message this is a warning, from then on the release stops.",
      cs: "Každá aplikace má v každém prostředí rezervovaný výkon: největší velikost kontejneru a nejvíc kopií (replik), které smí běžet. Platforma jí tolik drží volné a zbytek slibuje ostatním aplikacím. platform.yaml nastavuje větší velikost nebo víc replik, než je rezervace, takže by aplikace mohla vzít výkon slíbený jiným. Nové kontroly nejdřív jen varují: do data ve zprávě je to upozornění, od něj se nasazení zastaví.",
    },
    fix: {
      en: "Either lower runtime.size or runtime.scale.maxReplicas in platform.yaml to the reservation, or ask for more: open the app in the portal and choose More capacity. The platform team reviews the request, and once it's approved the next build passes.",
      cs: "Buď v platform.yaml sniž runtime.size nebo runtime.scale.maxReplicas na rezervaci, nebo požádej o víc: otevři aplikaci v portálu a zvol Víc výkonu. Žádost posoudí tým platformy a po schválení další sestavení projde.",
    },
    prompt: {
      en: "The delivery pipeline found that platform.yaml asks for more capacity than the app has reserved in an environment (the message names the environment, the size and maxReplicas, and the reservation). Lower runtime.size and runtime.scale.maxReplicas (or the override under environments.<env>) so they stay within the reservation, unless the app really needs more; then leave platform.yaml as it is and tell me to request More capacity in the portal.",
      cs: "Delivery pipeline zjistila, že platform.yaml chce víc výkonu, než má aplikace v některém prostředí rezervováno (zpráva uvádí prostředí, velikost a maxReplicas a rezervaci). Sniž runtime.size a runtime.scale.maxReplicas (nebo jejich přepsání pod environments.<env>), aby se vešly do rezervace, pokud aplikace opravdu nepotřebuje víc; pak platform.yaml nech být a řekni mi, ať v portálu požádám o Víc výkonu.",
    },
  },
};

/**
 * Checks of an app definition (apps/<slug>/app.yaml in platform-config), not of the app repository:
 * `platform validate app`, the pull request's build validation and the portal's request forms report
 * them (ADR-0052). Their findings carry the ID as `checkId`.
 */
export const DEFINITION_CHECK_IDS = [
  "front-door-domain-name",
  "cell-unknown",
  "cell-capacity",
  "cell-subnet-capacity",
  "decommission-grace",
  "decommission-tombstone",
  "decommission-immediate",
  "network-mode-change",
  "cell-change",
  "slug-reuse-generation",
  "slug-reuse-incarnation",
  "incarnation-fixed",
  "deleted-archive",
] as const;
export type DefinitionCheckId = (typeof DEFINITION_CHECK_IDS)[number];

export const DEFINITION_EXPLANATIONS: Readonly<Record<DefinitionCheckId, CheckExplanation>> = {
  "front-door-domain-name": {
    title: { en: "Two custom domains would share one name in the platform", cs: "Dvě vlastní domény by v platformě měly stejný název" },
    text: {
      en: "Inside the platform each custom domain is stored under a name made from its address, with every dot turned into a hyphen. So orders-test.contoso.com and orders.test.contoso.com get the same name, and in the same environment one app's deployment would take over the other app's domain and cut it off.",
      cs: "Platforma si každou vlastní doménu ukládá pod názvem odvozeným z její adresy, kde se každá tečka změní na pomlčku. Adresy orders-test.contoso.com a orders.test.contoso.com tak dostanou stejný název a ve stejném prostředí by nasazení jedné aplikace převzalo doménu té druhé a odpojilo ji.",
    },
    fix: {
      en: "Choose an address that differs from the other app's in more than dots and hyphens, for example by another word. The app that has the address already keeps it.",
      cs: "Vyber adresu, která se od adresy druhé aplikace liší víc než tečkami a pomlčkami, třeba jiným slovem. Aplikace, která adresu už má, si ji nechá.",
    },
    prompt: {
      en: "In the app definition, change environments.<env>.frontDoor.hostName so that, with every dot replaced by a hyphen, it no longer equals the host of the other app named in the message in the same environment. Keep the host inside the same DNS zone, and change nothing else.",
      cs: "V definici aplikace změň environments.<env>.frontDoor.hostName tak, aby se po nahrazení každé tečky pomlčkou už nerovnal adrese druhé aplikace ze zprávy ve stejném prostředí. Adresa ať zůstane ve stejné DNS zóně a nic jiného neměň.",
    },
  },
  "cell-unknown": {
    title: { en: "The app names a capacity cell that doesn't exist", cs: "Aplikace má nastavenou kapacitní buňku, která neexistuje" },
    text: {
      en: "Apps of a network mode run in one of its capacity cells, each a separate hosting environment with its own capacity. The app definition names a cell (environments.<env>.cell) that the instance doesn't have for that network mode.",
      cs: "Aplikace jednoho síťového režimu běží v některé z jeho kapacitních buněk. Každá je samostatné hostingové prostředí s vlastní kapacitou. Definice aplikace uvádí buňku (environments.<env>.cell), kterou instance pro tenhle síťový režim nemá.",
    },
    fix: {
      en: "Name one of the cells the message lists, or leave cell out: the app then runs in cell 01. A running app changes cell only together with its network mode; then the cell must be one of the new mode's.",
      cs: "Uveď jednu z buněk, které zpráva vypisuje, nebo cell vynech: aplikace pak poběží v buňce 01. Běžící aplikace mění buňku jen spolu se síťovým režimem; buňka pak musí patřit novému režimu.",
    },
    prompt: {
      en: "In the app definition, set environments.<env>.cell to one of the cells the message lists for the app's network mode, or remove the key so the app runs in cell 01. Change nothing else.",
      cs: "V definici aplikace nastav environments.<env>.cell na jednu z buněk, které zpráva vypisuje pro síťový režim aplikace, nebo klíč odstraň, aby aplikace běžela v buňce 01. Nic jiného neměň.",
    },
  },
  "cell-capacity": {
    title: { en: "A capacity cell would be promised more than it has", cs: "Kapacitní buňce by se slíbilo víc, než má" },
    text: {
      en: "The apps of a cell share its processor cores. Each app reserves its largest size times its most replicas, and together the reservations must stay within the cell's budget, so one app scaling out never takes what another was promised. With this change the cell's apps would reserve more than the budget; the message names the cell, what's reserved and the budget.",
      cs: "Aplikace jedné buňky sdílejí její procesorová jádra. Každá si rezervuje svou největší velikost krát nejvíc replik a dohromady se rezervace musí vejít do rozpočtu buňky, aby si jedna aplikace při škálování nevzala, co bylo slíbeno jiné. S touhle změnou by aplikace buňky rezervovaly víc, než je rozpočet; zpráva uvádí buňku, kolik je rezervováno a jaký je rozpočet.",
    },
    fix: {
      en: "Ask for a smaller reservation (a smaller size or fewer replicas). If the app really needs it, the platform team can make room: a larger budget for the cell, smaller reservations of other apps, or later another cell.",
      cs: "Požádej o menší rezervaci (menší velikost nebo míň replik). Pokud ji aplikace opravdu potřebuje, tým platformy může udělat místo: větší rozpočet buňky, menší rezervace jiných aplikací, nebo později další buňku.",
    },
    prompt: {
      en: "In the app definition, lower environments.<env>.capacity (size or maxReplicas) so the cell named in the message stays within its budget, or remove capacity to use the instance default if that is smaller. Don't change other apps' definitions or instance.yaml; the platform team decides those.",
      cs: "V definici aplikace sniž environments.<env>.capacity (size nebo maxReplicas), aby se buňka ze zprávy vešla do svého rozpočtu, nebo capacity odstraň a použij výchozí rezervaci instance, pokud je menší. Definice jiných aplikací ani instance.yaml neměň, o nich rozhoduje tým platformy.",
    },
  },
  "cell-subnet-capacity": {
    title: { en: "A capacity cell's network would run out of addresses", cs: "Síti kapacitní buňky by došly adresy" },
    text: {
      en: "In a network mode with its own virtual network, every running copy of an app needs room in the cell's subnet, and a subnet can't grow once the cell exists. Together the apps of the cell would be allowed more replicas than the subnet holds; the message names the cell, the replicas and the subnet's limit.",
      cs: "V síťovém režimu s vlastní virtuální sítí potřebuje každá běžící kopie aplikace místo v podsíti buňky a podsíť se po vytvoření buňky už nedá zvětšit. Aplikace buňky by dohromady směly běžet ve víc replikách, než se do podsítě vejde; zpráva uvádí buňku, počet replik a limit podsítě.",
    },
    fix: {
      en: "Ask for fewer replicas (maxReplicas). If the app needs them, ask the platform team: another cell with its own subnet comes with a later release.",
      cs: "Požádej o míň replik (maxReplicas). Pokud je aplikace potřebuje, obrať se na tým platformy: další buňka s vlastní podsítí přijde v pozdější verzi.",
    },
    prompt: {
      en: "In the app definition, lower environments.<env>.capacity.maxReplicas so the sum of maxReplicas in the cell named in the message stays within its subnet's limit. Change nothing else.",
      cs: "V definici aplikace sniž environments.<env>.capacity.maxReplicas, aby se součet maxReplicas v buňce ze zprávy vešel do limitu její podsítě. Nic jiného neměň.",
    },
  },
  "decommission-grace": {
    title: { en: "The app would be deleted before its grace period ends", cs: "Aplikace by se smazala dřív, než skončí ochranná lhůta" },
    text: {
      en: "When an app is decommissioned, it stops first and stays complete for a grace period, so its owner can still cancel or take out what must be kept. The instance sets how many days that is. The deletion date in the app definition (decommission.deleteAfter) is earlier than the request day plus that grace period, or the request day was changed after the request was approved.",
      cs: "Při vyřazení se aplikace nejdřív zastaví a po ochrannou lhůtu zůstane celá, aby vlastník mohl vyřazení ještě zrušit nebo si odnést, co má zůstat. Kolik dní lhůta trvá, určuje instance. Datum smazání v definici aplikace (decommission.deleteAfter) je dřív než den žádosti plus ochranná lhůta, nebo se den žádosti po schválení změnil.",
    },
    fix: {
      en: "Set the deletion date to the date the message names or later, and keep the request day as it was. To delete sooner, the platform team would have to shorten the grace period of the whole instance.",
      cs: "Nastav datum smazání na den ze zprávy nebo pozdější a den žádosti nech, jak byl. Smazat dřív by šlo jen tak, že tým platformy zkrátí ochrannou lhůtu celé instance.",
    },
    prompt: {
      en: "In the app definition, set decommission.deleteAfter to the date the message names or later. Don't change decommission.requestedOn or anything else.",
      cs: "V definici aplikace nastav decommission.deleteAfter na datum ze zprávy nebo pozdější. Neměň decommission.requestedOn ani nic jiného.",
    },
  },
  "decommission-tombstone": {
    title: { en: "An app in its delete phase can't come back", cs: "Aplikace ve fázi mazání se nedá vrátit" },
    text: {
      en: "Once the deletion date of a decommissioned app has passed (decommission.deleteAfter, or the request day for an immediate deletion), the platform deletes the app and then finds out by itself that nothing is left. Its definition stays as it is. Once the app is deleted, a new app may use its name again: the new app's request moves this definition to the archive of deleted apps (apps-deleted/) and starts with a higher generation. This change removes the decommission block or changes its dates after that day, which would bring back an app that is being deleted or is gone.",
      cs: "Jakmile u vyřazené aplikace uplyne datum smazání (decommission.deleteAfter, u okamžitého smazání den žádosti), platforma aplikaci smaže a pak sama zjistí, že nic nezbylo. Její definice zůstane, jak je. Jakmile je aplikace smazaná, může její jméno znovu použít nová aplikace: žádost o novou aplikaci přesune tuhle definici do archivu smazaných aplikací (apps-deleted/) a začne s vyšší generací. Tahle změna po tom dni odstraňuje blok decommission nebo mění jeho data, čímž by vracela aplikaci, která se maže nebo už je pryč.",
    },
    fix: {
      en: "Leave the decommission block as it is on the default branch. If you need the app again, request a new app: under another name, or under this name once the portal shows the app as deleted. Data of a deleted app can only be recovered by the platform team, within the recovery windows the decommissioning runbook lists.",
      cs: "Blok decommission nech, jak je na výchozí větvi. Pokud aplikaci zase potřebuješ, požádej o novou: pod jiným jménem, nebo pod tímhle, jakmile portál ukáže aplikaci jako smazanou. Data smazané aplikace umí obnovit jen tým platformy, a to v lhůtách, které uvádí runbook k vyřazení.",
    },
    prompt: {
      en: "Revert the change to the decommission block of this app definition (keep requestedOn, deleteAfter and immediate as they are on the default branch, and don't remove the block). If a new app is needed, it is requested in the portal as a new app (with another slug, or with this slug once the app is deleted); don't edit this definition into a new app.",
      cs: "Vrať změnu bloku decommission v téhle definici aplikace (requestedOn, deleteAfter a immediate nech jako na výchozí větvi a blok neodstraňuj). Pokud je potřeba nová aplikace, požádá se o ni v portálu jako o novou (s jiným slugem, nebo s tímhle, až bude aplikace smazaná); tuhle definici na novou aplikaci nepřepisuj.",
    },
  },
  "decommission-immediate": {
    title: { en: "Only an app without production can be deleted immediately", cs: "Hned smazat jde jen aplikace bez produkce" },
    text: {
      en: "Usually a decommissioned app stops first and is deleted only after a grace period, so mistakes can still be undone. An app that never ran in production may skip that wait: it is deleted right after the request is approved, and nothing can be cancelled. An app with production may skip it only on an instance for developing the platform that allows it (decommission.allowImmediateWithProduction in the instance settings); an instance that runs apps people rely on doesn't. This app definition asks for that (decommission.immediate) although the app has a production environment and the instance doesn't allow it, the deletion date isn't the request day, or the choice was changed after the request was approved.",
      cs: "Vyřazená aplikace se obvykle nejdřív zastaví a smaže se až po ochranné lhůtě, aby se dala chyba ještě vrátit. Aplikace, která nikdy neběžela v produkci, může čekání přeskočit: smaže se hned po schválení žádosti a nic se nedá zrušit. Aplikace s produkcí ho může přeskočit jen na instanci pro vývoj platformy, která to dovoluje (decommission.allowImmediateWithProduction v nastavení instance); instance, kde běží aplikace, na které se lidé spoléhají, to nedovoluje. Tahle definice aplikace o to žádá (decommission.immediate), ačkoli aplikace má produkční prostředí a instance to nedovoluje, datum smazání není den žádosti, nebo se volba po schválení žádosti změnila.",
    },
    fix: {
      en: "For an app with production, ask for an ordinary decommissioning: it stops and is deleted after the grace period. Without production, keep the deletion date equal to the request day. Once a request is approved, immediate can't be switched on or off; cancel and ask again instead.",
      cs: "U aplikace s produkcí požádej o běžné vyřazení: zastaví se a smaže se po ochranné lhůtě. Bez produkce nech datum smazání stejné jako den žádosti. Po schválení žádosti už se okamžité smazání zapnout ani vypnout nedá; místo toho žádost zruš a požádej znovu.",
    },
    prompt: {
      en: "In the app definition, if the app has an environment of kind prod and the message says the instance doesn't allow immediate deletion with production, remove decommission.immediate and set decommission.deleteAfter to the date the message names or later; otherwise set decommission.deleteAfter equal to decommission.requestedOn. If the default branch already has the decommission block, keep immediate as it is there. Don't change instance.yaml. Change nothing else.",
      cs: "V definici aplikace: pokud má aplikace prostředí druhu prod a zpráva říká, že instance okamžité smazání s produkcí nedovoluje, odstraň decommission.immediate a nastav decommission.deleteAfter na datum ze zprávy nebo pozdější; jinak nastav decommission.deleteAfter stejně jako decommission.requestedOn. Pokud blok decommission už je na výchozí větvi, nech immediate tak, jak je tam. instance.yaml neměň. Nic jiného neměň.",
    },
  },
  "network-mode-change": {
    title: { en: "A network mode change the platform can't make", cs: "Změna síťového režimu, kterou platforma neumí" },
    text: {
      en: "The network mode decides how an app is connected: to the internet only, or also to the company's internal systems. The platform can move an app that already runs in an environment between From the internet (externalOnly) and Internet + internal systems (externalHybrid), in any capacity cell: it deletes the app there and creates it again in the other network, in a set order, with a short outage. It can't make this change, because Internal only isn't available yet or the change isn't between those two modes. If this change were merged, the app would be left half-moved and broken in that environment.",
      cs: "Síťový režim určuje, jak je aplikace připojená: jen do internetu, nebo i k interním systémům firmy. Aplikaci, která už v prostředí běží, umí platforma přesunout mezi režimy Z internetu (externalOnly) a Z internetu + interní systémy (externalHybrid), v libovolné kapacitní buňce: smaže ji tam a v druhé síti ji v přesném pořadí vytvoří znovu, s krátkým výpadkem. Tuhle změnu ale neumí, protože režim Jen interně zatím není k dispozici, nebo nejde o přesun mezi těmi dvěma režimy. Kdyby se změna sloučila, aplikace by v tom prostředí zůstala napůl přesunutá a nefungovala by.",
    },
    fix: {
      en: "Keep the network mode the app has on the default branch. A move between From the internet and Internet + internal systems is fine; the owner can ask for it on the app's page in the portal, which also picks a capacity cell of the new mode with room for the app. A new environment can start in any mode the instance offers. For anything else, ask the platform team: they can remove the environment from the app and add it back in the new mode in a later request, but everything the app has there, its data included, is deleted.",
      cs: "Nech síťový režim, který má aplikace na výchozí větvi. Přesun mezi režimy Z internetu a Z internetu + interní systémy je v pořádku; vlastník o něj může požádat na stránce aplikace v portálu, který zároveň vybere kapacitní buňku nového režimu, kde je pro aplikaci místo. Nové prostředí může začít v libovolném režimu, který instance nabízí. S čímkoli jiným se obrať na tým platformy: může prostředí z aplikace odebrat a v pozdější žádosti ho přidat zpátky v novém režimu, ale všechno, co tam aplikace má, včetně dat, se smaže.",
    },
    prompt: {
      en: "In the app definition, set environments.<env>.networkMode of the environment the message names back to its value on the default branch, and keep environments.<env>.cell as it is there. Change nothing else.",
      cs: "V definici aplikace vrať environments.<env>.networkMode prostředí ze zprávy na hodnotu z výchozí větve a environments.<env>.cell nech, jak je tam. Nic jiného neměň.",
    },
  },
  "cell-change": {
    title: { en: "A running app can't move to another capacity cell of its network mode", cs: "Běžící aplikaci nejde přesunout do jiné kapacitní buňky jejího síťového režimu" },
    text: {
      en: "Each capacity cell is a separate hosting environment with its own capacity. The app already runs in this environment, and the change names another cell of the same network mode. The platform can't move a running app between the cells of one network mode. It changes the cell only when it moves the app to the other network mode, because it creates the app again there anyway. If this change were merged, the app's next update in that environment would fail.",
      cs: "Každá kapacitní buňka je samostatné hostingové prostředí s vlastní kapacitou. Aplikace už v tomhle prostředí běží a změna uvádí jinou buňku stejného síťového režimu. Platforma neumí běžící aplikaci přesunout mezi buňkami jednoho síťového režimu. Buňku mění jen tehdy, když aplikaci přesouvá do druhého síťového režimu, protože ji tam stejně vytváří znovu. Kdyby se změna sloučila, další aktualizace aplikace v tom prostředí by selhala.",
    },
    fix: {
      en: "Keep the cell the app has on the default branch. If its cell is short of room, ask the platform team for capacity there.",
      cs: "Nech buňku, kterou má aplikace na výchozí větvi. Pokud je v její buňce málo místa, požádej tým platformy o kapacitu.",
    },
    prompt: {
      en: "In the app definition, set environments.<env>.cell of the environment the message names back to its value on the default branch, or remove the key if the default branch has none. Change nothing else.",
      cs: "V definici aplikace vrať environments.<env>.cell prostředí ze zprávy na hodnotu z výchozí větve, nebo klíč odstraň, pokud ho výchozí větev nemá. Nic jiného neměň.",
    },
  },
  "slug-reuse-generation": {
    title: { en: "A new app with a deleted app's name needs a higher generation", cs: "Nová aplikace se jménem smazané aplikace potřebuje vyšší generaci" },
    text: {
      en: "Once an app is deleted, a new app may use its name (slug) again. Some parts of the deleted app, such as its key vault, stay soft-deleted for a while, and names that must be unique in the whole cloud would clash with them. The generation in the app definition (generation) is part of those names: a new app with the same slug gets new names only when its generation is above that of every deleted app with the slug. Their definitions are kept in apps-deleted/<slug>/. This app definition's generation isn't above them.",
      cs: "Když se aplikace smaže, může její jméno (slug) znovu použít nová aplikace. Některé části smazané aplikace, třeba její trezor klíčů, ale ještě nějakou dobu zůstávají smazané jen dočasně a názvy, které musí být jedinečné v celém cloudu, by se s nimi srazily. Generace v definici aplikace (generation) je součástí těch názvů: nová aplikace se stejným slugem dostane nové názvy jen tehdy, když má generaci vyšší než každá smazaná aplikace s tímhle slugem. Jejich definice zůstávají v apps-deleted/<slug>/. Generace téhle definice aplikace vyšší není.",
    },
    fix: {
      en: "Set generation to the number the message names: one above the highest generation in the archive. The portal does this by itself when it requests a new app with a deleted app's name.",
      cs: "Nastav generation na číslo ze zprávy: o jedna vyšší než nejvyšší generace v archivu. Portál to udělá sám, když žádá o novou aplikaci se jménem smazané aplikace.",
    },
    prompt: {
      en: "In the app definition apps/<slug>/app.yaml, set generation to the number the message names, one above the highest generation of the definitions in apps-deleted/<slug>/. Don't change the archived definitions in apps-deleted/ or anything else.",
      cs: "V definici aplikace apps/<slug>/app.yaml nastav generation na číslo ze zprávy, o jedna vyšší než nejvyšší generace definic v apps-deleted/<slug>/. Archivované definice v apps-deleted/ ani nic jiného neměň.",
    },
  },
  "slug-reuse-incarnation": {
    title: { en: "A new app with a deleted app's name needs a higher incarnation", cs: "Nová aplikace se jménem smazané aplikace potřebuje vyšší inkarnaci" },
    text: {
      en: "Once an app is deleted, a new app may use its name (slug) again. Its sign-in registration in the company's directory can't simply take the deleted app's: the directory keeps a deleted registration for 30 days with its name, and that name can never change. So each app with a given slug gets its own registration, told apart by its incarnation (incarnation in the app definition): 0 for the first app with the slug, one more for every app after it. Nobody sees it; the app's name at sign-in stays the same. The definitions of the deleted apps with the slug are kept in apps-deleted/<slug>/, and this app definition's incarnation isn't above theirs (a definition without it counts as 0).",
      cs: "Když se aplikace smaže, může její jméno (slug) znovu použít nová aplikace. Její registrace pro přihlášení ve firemním adresáři ale nemůže jednoduše převzít tu smazanou: adresář drží smazanou registraci 30 dní i s jejím názvem a ten se nikdy nedá změnit. Každá aplikace s daným slugem proto dostane vlastní registraci, rozlišenou inkarnací (incarnation v definici aplikace): 0 pro první aplikaci s tím slugem a o jedna víc pro každou další. Nikdo ji nevidí; název aplikace při přihlášení zůstává stejný. Definice smazaných aplikací s tímhle slugem zůstávají v apps-deleted/<slug>/ a inkarnace téhle definice aplikace není vyšší než jejich (definice bez ní se počítá jako 0).",
    },
    fix: {
      en: "Set incarnation to the number the message names: one above the highest incarnation in the archive. The portal does this by itself when it requests a new app with a deleted app's name.",
      cs: "Nastav incarnation na číslo ze zprávy: o jedna vyšší než nejvyšší inkarnace v archivu. Portál to udělá sám, když žádá o novou aplikaci se jménem smazané aplikace.",
    },
    prompt: {
      en: "In the app definition apps/<slug>/app.yaml, set incarnation to the number the message names, one above the highest incarnation of the definitions in apps-deleted/<slug>/ (a definition without incarnation counts as 0). Don't change the archived definitions in apps-deleted/ or anything else.",
      cs: "V definici aplikace apps/<slug>/app.yaml nastav incarnation na číslo ze zprávy, o jedna vyšší než nejvyšší inkarnace definic v apps-deleted/<slug>/ (definice bez incarnation se počítá jako 0). Archivované definice v apps-deleted/ ani nic jiného neměň.",
    },
  },
  "incarnation-fixed": {
    title: { en: "An app's incarnation never changes", cs: "Inkarnace aplikace se nikdy nemění" },
    text: {
      en: "The incarnation in the app definition (incarnation) tells apart the apps that have had the same name (slug) one after another: 0 for the first, one more for every app after it. It names the app's sign-in registration in the company's directory, and the directory never lets that name change. If the incarnation changed, the platform would create a second registration for the same app: a new client ID and secret, the people and groups assigned again, and the old registration left behind. So it is set once, when the app is requested, and stays for the app's whole life. This change sets it to another value than the default branch has.",
      cs: "Inkarnace v definici aplikace (incarnation) rozlišuje aplikace, které měly postupně stejné jméno (slug): 0 pro první a o jedna víc pro každou další. Pojmenovává registraci aplikace pro přihlášení ve firemním adresáři a adresář ten název nikdy nedovolí změnit. Kdyby se inkarnace změnila, platforma by stejné aplikaci založila druhou registraci: nové ID klienta a tajemství, znovu přiřazené lidi a skupiny a stará registrace by zůstala viset. Proto se nastaví jednou, při žádosti o aplikaci, a platí po celý její život. Tahle změna ji nastavuje na jinou hodnotu, než má výchozí větev.",
    },
    fix: {
      en: "Keep incarnation as it is on the default branch (no value there means 0). Only a new app with a deleted app's name gets a higher one, in the pull request that moves the deleted app's definition to apps-deleted/<slug>/; the portal writes it.",
      cs: "Nech incarnation tak, jak je na výchozí větvi (bez hodnoty to znamená 0). Vyšší dostane jen nová aplikace se jménem smazané aplikace, a to v pull requestu, který přesouvá definici smazané aplikace do apps-deleted/<slug>/; zapíše ji portál.",
    },
    prompt: {
      en: "In the app definition apps/<slug>/app.yaml, set incarnation back to its value on the default branch, or remove the key if the default branch has none. Change nothing else.",
      cs: "V definici aplikace apps/<slug>/app.yaml vrať incarnation na hodnotu z výchozí větve, nebo klíč odstraň, pokud ho výchozí větev nemá. Nic jiného neměň.",
    },
  },
  "deleted-archive": {
    title: { en: "The archive of deleted apps changes in a way that isn't allowed", cs: "Archiv smazaných aplikací se mění nedovoleným způsobem" },
    text: {
      en: "When a new app takes the name of a deleted app, the deleted app's definition moves unchanged from apps/<slug>/app.yaml to apps-deleted/<slug>/<requestedOn>/app.yaml, a folder named for the day its decommissioning was requested. The platform never sets anything up from this archive; it is the record of deleted apps. So a definition enters the archive only by that move and only once the app's deletion date (decommission.deleteAfter) has passed. Once archived, it never changes and stays, with one exception: a definition archived before the platform found the app deleted may move back unchanged to apps/<slug>/app.yaml, as long as no new app has the slug. The archive holds nothing but these app.yaml files. This change breaks one of these rules; the message says which.",
      cs: "Když si nová aplikace vezme jméno smazané aplikace, definice smazané aplikace se beze změny přesune z apps/<slug>/app.yaml do apps-deleted/<slug>/<requestedOn>/app.yaml, do složky pojmenované podle dne, kdy se o vyřazení požádalo. Z tohohle archivu platforma nikdy nic nezakládá, je to záznam o smazaných aplikacích. Definice se proto do archivu dostane jen takovým přesunem a jen tehdy, když už uplynulo datum smazání aplikace (decommission.deleteAfter). Jakmile v archivu je, už se nemění a zůstává tam, s jedinou výjimkou: definici přesunutou do archivu dřív, než platforma zjistila, že je aplikace smazaná, jde beze změny vrátit do apps/<slug>/app.yaml, dokud tenhle slug nemá žádná nová aplikace. Archiv neobsahuje nic jiného než tyhle soubory app.yaml. Tahle změna některé z pravidel porušuje; které, říká zpráva.",
    },
    fix: {
      en: "Move the deleted app's app.yaml exactly as it is on the default branch into the folder named for its decommission.requestedOn, and remove its delivery.yml. Move only an app whose deletion date has passed: the portal offers its name once the app is deleted. Leave everything already in apps-deleted/ as it is on the default branch; only a definition archived too early may move back unchanged, while no new app has its slug (the decommissioning runbook says how).",
      cs: "Přesuň app.yaml smazané aplikace přesně tak, jak je na výchozí větvi, do složky pojmenované podle jejího decommission.requestedOn a odstraň její delivery.yml. Přesouvej jen aplikaci, které už uplynulo datum smazání: portál nabídne její jméno, jakmile je aplikace smazaná. Všechno, co už v apps-deleted/ je, nech tak, jak je na výchozí větvi; jen definici archivovanou předčasně jde beze změny vrátit zpátky, dokud její slug nemá žádná nová aplikace (jak na to, popisuje runbook k vyřazení).",
    },
    prompt: {
      en: "Restore every file under apps-deleted/ that exists on the default branch to its content there, unless this change moves it back unchanged to apps/<slug>/app.yaml and the default branch has no apps/<slug>/app.yaml. Make an archived definition this change adds an exact copy of apps/<slug>/app.yaml from the default branch, at apps-deleted/<slug>/<its decommission.requestedOn>/app.yaml, with nothing else in that folder; if that app's decommission.deleteAfter is still in the future, undo the move instead. Change nothing else.",
      cs: "Každý soubor v apps-deleted/, který existuje na výchozí větvi, vrať na jeho obsah z výchozí větve, ledaže ho tahle změna beze změny vrací do apps/<slug>/app.yaml a výchozí větev žádný apps/<slug>/app.yaml nemá. Archivovanou definici, kterou tahle změna přidává, udělej přesnou kopií apps/<slug>/app.yaml z výchozí větve v apps-deleted/<slug>/<její decommission.requestedOn>/app.yaml a nic jiného do té složky nedávej; pokud je decommission.deleteAfter té aplikace ještě v budoucnu, přesun místo toho zruš. Nic jiného neměň.",
    },
  },
};

/**
 * Checks of instance.yaml (`platform validate instance`, the pull request's build validation, the
 * portal's Settings area) that have an explanation. log-retention-lifecycle and
 * decommission-immediate-with-production (ADR-0056 amendment 2026-11-21) are warnings; with `--base`,
 * environment-network-in-use is an error (ADR-0027 amendment 2026-11-12).
 */
export const INSTANCE_CHECK_IDS = ["log-retention-lifecycle", "environment-network-in-use", "decommission-immediate-with-production"] as const;
export type InstanceCheckId = (typeof INSTANCE_CHECK_IDS)[number];

export const INSTANCE_EXPLANATIONS: Readonly<Record<InstanceCheckId, CheckExplanation>> = {
  "log-retention-lifecycle": {
    title: { en: "The platform's logs are kept for less time than the unused-app rule needs", cs: "Logy platformy se drží kratší dobu, než potřebuje pravidlo o nepoužívaných aplikacích" },
    text: {
      en: "The Lifecycle tab counts an app as unused when nobody has used it for a number of days (lifecycle.unusedAfterDaysWithoutRequests). It reads that from the platform's logs, which are kept for observability.logRetentionDays. When the logs are kept for less time than the rule's days, the portal can never see that an app has been unused that long, so no app ever shows as unused. This is a warning: nothing fails.",
      cs: "Záložka Životní cyklus považuje aplikaci za nepoužívanou, když ji nikdo nepoužil určitý počet dní (lifecycle.unusedAfterDaysWithoutRequests). Zjišťuje to z logů platformy, které se drží po dobu observability.logRetentionDays. Když se logy drží kratší dobu, než je počet dní pravidla, portál nikdy neuvidí, že aplikaci tak dlouho nikdo nepoužil, a žádná se jako nepoužívaná neukáže. Je to jen upozornění, nic neselže.",
    },
    fix: {
      en: "Keep the logs at least as long as the unused-app rule (the defaults are 90 days of logs and 60 days for the rule), or shorten the rule. Longer logs cost more: Log Analytics charges for retention beyond the days included with ingestion. The platform pipeline applies the new retention after its approval.",
      cs: "Drž logy aspoň tak dlouho, jak počítá pravidlo o nepoužívaných aplikacích (výchozí je 90 dní logů a 60 dní pro pravidlo), nebo pravidlo zkrať. Delší logy stojí víc: Log Analytics účtuje uchování nad dny zahrnuté v ceně příjmu dat. Novou dobu uchování nasadí platform pipeline po svém schválení.",
    },
    prompt: {
      en: "In instance.yaml, raise observability.logRetentionDays to at least lifecycle.unusedAfterDaysWithoutRequests (or lower that rule if the platform team prefers). Change nothing else.",
      cs: "V instance.yaml zvyš observability.logRetentionDays aspoň na hodnotu lifecycle.unusedAfterDaysWithoutRequests (nebo to pravidlo sniž, pokud to tým platformy preferuje). Nic jiného neměň.",
    },
  },
  "environment-network-in-use": {
    title: { en: "The network of an environment with apps would change", cs: "Změnila by se síť prostředí, ve kterém běží aplikace" },
    text: {
      en: "An environment's network (address ranges, subnets, route table, DNS servers, the hub it connects to) is settled before its first app arrives. Once an app runs there, its containers, private connections and firewall rules depend on those values, and several of them can't be changed in place at all. The change edits the network of an environment that at least one app definition lists.",
      cs: "Síť prostředí (rozsahy adres, podsítě, směrovací tabulka, DNS servery, hub, ke kterému se připojuje) se ustálí před příchodem první aplikace. Jakmile tam nějaká aplikace běží, závisí na těch hodnotách její kontejnery, privátní připojení i pravidla firewallu, a několik z nich se za běhu změnit vůbec nedá. Tahle změna upravuje síť prostředí, které uvádí aspoň jedna definice aplikace.",
    },
    fix: {
      en: "Keep the environment's network as it is on the target branch. A different network for apps needs a new environment, or a migration the network team and the platform team plan together.",
      cs: "Síť prostředí nech, jak je na cílové větvi. Jiná síť pro aplikace znamená nové prostředí, nebo migraci, kterou spolu naplánuje tým sítí a tým platformy.",
    },
    prompt: {
      en: "In instance.yaml, restore the network fields of the environment the message names (hub, the ranges under networkModes.<mode>, route table, DNS servers, VNet) to their values on the target branch. Change nothing else.",
      cs: "V instance.yaml vrať síťová pole prostředí ze zprávy (hub, rozsahy v networkModes.<mode>, směrovací tabulku, DNS servery, VNet) na hodnoty z cílové větve. Nic jiného neměň.",
    },
  },
  "decommission-immediate-with-production": {
    title: { en: "Apps with production may be deleted immediately: for developing the platform only", cs: "Aplikace s produkcí jde smazat hned: jen pro vývoj platformy" },
    text: {
      en: "Usually only an app that never ran in production can be deleted right after its decommissioning request is approved. An app with production stops first and is deleted only after a grace period, so a mistake can still be undone. This instance allows immediate deletion for apps with production too (decommission.allowImmediateWithProduction). That helps while the platform itself is being developed, for example in a sandbox where test apps with a production environment come and go. On an instance that runs apps people rely on it is dangerous: once the platform team approves such a request, the app's production data and its users' access are gone within the next provisioning runs, and nothing can be cancelled. This is a warning: nothing fails.",
      cs: "Hned po schválení žádosti o vyřazení jde obvykle smazat jen aplikace, která nikdy neběžela v produkci. Aplikace s produkcí se nejdřív zastaví a smaže se až po ochranné lhůtě, aby se dala chyba ještě vrátit. Tahle instance dovoluje smazat hned i aplikace s produkcí (decommission.allowImmediateWithProduction). Hodí se to při vývoji samotné platformy, třeba v sandboxu, kde testovací aplikace s produkčním prostředím vznikají a zanikají. Na instanci, kde běží aplikace, na které se lidé spoléhají, je to nebezpečné: jakmile tým platformy takovou žádost schválí, produkční data aplikace i přístup jejích uživatelů jsou během dalších běhů nastavování pryč a nic se nedá zrušit. Je to jen upozornění, nic neselže.",
    },
    fix: {
      en: "On an instance that runs apps people rely on, set decommission.allowImmediateWithProduction to false or remove it: apps with production are then deleted only after the grace period, and only apps without production can be deleted immediately. Keep it on only on an instance for developing the platform.",
      cs: "Na instanci, kde běží aplikace, na které se lidé spoléhají, nastav decommission.allowImmediateWithProduction na false nebo ho odstraň: aplikace s produkcí se pak smažou až po ochranné lhůtě a hned smazat jde jen aplikace bez produkce. Zapnuté to nech jen na instanci pro vývoj platformy.",
    },
    prompt: {
      en: "In instance.yaml, set decommission.allowImmediateWithProduction to false, or remove the key, unless the platform team says this instance is only for developing the platform. Change nothing else.",
      cs: "V instance.yaml nastav decommission.allowImmediateWithProduction na false nebo klíč odstraň, pokud tým platformy neřekne, že tahle instance slouží jen k vývoji platformy. Nic jiného neměň.",
    },
  },
};

/**
 * Failures of the provisioning pipeline (ADR-0064, backlog US04.10, US04.11): a stable code per
 * failure an app owner or the platform team can act on, and PE001 for every other one. The pipeline
 * writes only the code into the app's status file (never the cloud's error text); the portal, the
 * run's report and the failure catalogue show these texts. Codes are never renumbered or reused: a
 * code that is no longer reported keeps its entry.
 *
 * Unlike a check, a failure has no prompt for an AI agent: the platform team fixes it in the cloud or
 * in platform-config, following a runbook, not in an app's repository. `runbook` names the core
 * runbook (docs/runbooks/<name>.md) when there is one. Which errors map to which code:
 * provisioning/failure-code.ts and the pipeline scripts (prov_failure); every mapped cloud error
 * code was seen in a sandbox run or is documented by Microsoft (hard rule 8).
 */
export interface ProvisioningFailureExplanation {
  /** The problem as a short statement. */
  title: LocalizedText;
  /** What happened and why, in one to three sentences. */
  text: LocalizedText;
  /** What happens next and who acts. */
  fix: LocalizedText;
  /** The core runbook the platform team follows (its file name in docs/runbooks, without .md). */
  runbook?: string;
}

/** The provisioning failure codes, in catalogue order. PE001 is the generic code (see the run's log). */
export const PROVISIONING_FAILURE_IDS = ["PE001", "PE002", "PE003", "PE004", "PE005", "PE006", "PE007", "PE008", "PE009", "PE010"] as const;
export type ProvisioningFailureId = (typeof PROVISIONING_FAILURE_IDS)[number];
/** The code of a failure no other code describes. */
export const UNKNOWN_PROVISIONING_FAILURE: ProvisioningFailureId = "PE001";

export const PROVISIONING_FAILURES: Readonly<Record<ProvisioningFailureId, ProvisioningFailureExplanation>> = {
  PE001: {
    title: { en: "Setting up the app stopped for a reason the platform doesn't recognise", cs: "Nastavení aplikace se zastavilo z důvodu, který platforma nezná" },
    text: {
      en: "A step of the setup run failed, and its error isn't one the platform knows how to explain. The other apps of the run weren't affected.",
      cs: "Krok nastavovacího běhu selhal a jeho chyba není z těch, které platforma umí vysvětlit. Ostatních aplikací v běhu se to nedotklo.",
    },
    fix: {
      en: "The platform team reads the run's log, which shows the step's error, and removes the cause. The step runs again in the next setup run.",
      cs: "Platform tým si přečte log běhu, kde je chyba kroku vidět, a příčinu odstraní. Krok se spustí znovu při příštím nastavování.",
    },
  },
  PE002: {
    title: { en: "The app's definition doesn't pass the platform's checks", cs: "Definice aplikace neprošla kontrolami platformy" },
    text: {
      en: "The setup run first checks every app definition (apps/<slug>/app.yaml in platform-config). This one has a problem, so nothing was set up for the app in this run. Usually a newer platform version checks something the definition doesn't meet yet.",
      cs: "Nastavovací běh nejdřív zkontroluje každou definici aplikace (apps/<slug>/app.yaml v platform-config). Tahle má problém, takže se pro aplikaci v tomto běhu nic nenastavilo. Většinou novější verze platformy kontroluje něco, co definice ještě nesplňuje.",
    },
    fix: {
      en: "The platform team runs `platform validate app apps/<slug>/app.yaml --instance instance.yaml` in platform-config and fixes the definition through a pull request. Its merge starts the next setup run.",
      cs: "Platform tým spustí v platform-config `platform validate app apps/<slug>/app.yaml --instance instance.yaml` a definici opraví přes pull request. Jeho sloučení spustí další nastavování.",
    },
  },
  PE003: {
    title: { en: "The platform couldn't read the app's current state", cs: "Platforma nemohla zjistit, v jakém stavu aplikace je" },
    text: {
      en: "Before it changes anything, the setup run reads what exists for every app in each environment. For this app the read failed in this environment, so none of its steps ran there and nothing was changed.",
      cs: "Než cokoli změní, nastavovací běh zjistí, co pro každou aplikaci v každém prostředí existuje. U téhle aplikace se to v tomto prostředí nepovedlo, takže tam neproběhl žádný z jejích kroků a nic se nezměnilo.",
    },
    fix: {
      en: "Usually a passing problem in the cloud: the next setup run reads it again. If it keeps failing, the platform team reads the log of that environment's plan job.",
      cs: "Většinou jde o přechodný problém v cloudu a příští nastavování to zjistí znovu. Pokud to selhává opakovaně, platform tým si přečte log plánovací úlohy toho prostředí.",
    },
  },
  PE004: {
    title: { en: "The cloud was still busy after several tries", cs: "Cloud byl i po několika pokusech pořád zaneprázdněný" },
    text: {
      en: "Some steps meet delays that pass on their own: new permissions take a few minutes to reach every part of the cloud, and two changes can't run on the same shared resource at once. The platform waits and tries again a few times, but this delay lasted longer than its tries.",
      cs: "Některé kroky narazí na zdržení, které samo přejde: nová oprávnění se do všech částí cloudu dostanou až za pár minut a dvě změny nemůžou běžet na stejném sdíleném prostředku najednou. Platforma počká a několikrát to zkusí znovu, tohle zdržení ale trvalo déle než její pokusy.",
    },
    fix: {
      en: "Nothing needs fixing: the next setup run tries again, and the platform team can start one at any time. If it fails the same way twice in a row, the platform team reads the run's log.",
      cs: "Není co opravovat: příští nastavování to zkusí znovu a platform tým ho může spustit kdykoli. Pokud to selže stejně dvakrát za sebou, platform tým si přečte log běhu.",
    },
  },
  PE005: {
    title: { en: "The cloud has no room for a requested size right now", cs: "Cloud teď nemá místo pro požadovanou velikost" },
    text: {
      en: "The cloud region refused a size the app asks for, such as the size of its database, because it has no capacity for it at the moment or doesn't offer it here. The app's setup itself is in order.",
      cs: "Cloudová oblast odmítla velikost, o kterou aplikace žádá, třeba velikost její databáze, protože na ni teď nemá kapacitu nebo ji tady nenabízí. Samotné nastavení aplikace je v pořádku.",
    },
    fix: {
      en: "The next setup run tries again; capacity often comes back within hours or days. If it doesn't, the platform team changes the size or the kind of database in the app's definition, or asks the cloud provider for capacity.",
      cs: "Příští nastavování to zkusí znovu; kapacita se často vrátí během hodin nebo dnů. Pokud ne, platform tým změní v definici aplikace velikost nebo druh databáze, případně požádá poskytovatele cloudu o kapacitu.",
    },
  },
  PE006: {
    title: { en: "The platform lacks a permission it needs", cs: "Platformě chybí oprávnění, které potřebuje" },
    text: {
      en: "The cloud refused an action of the identity the setup run works with. Its permissions are set once per environment when the platform is installed: someone may have changed them, or a newer platform version needs one it doesn't have yet. The same refusal can mean that a cloud service the app needs isn't switched on for the environment.",
      cs: "Cloud odmítl akci identity, se kterou nastavovací běh pracuje. Její oprávnění se nastavují jednou pro každé prostředí při instalaci platformy: někdo je mohl změnit, nebo novější verze platformy potřebuje oprávnění, které ještě nemá. Stejné odmítnutí může znamenat i to, že služba cloudu, kterou aplikace potřebuje, není pro prostředí zapnutá.",
    },
    fix: {
      en: "The platform team finds the refused action in the run's log and compares the identity's roles with the ones the platform's bootstrap gives. It never widens a role beyond what the platform asks for.",
      cs: "Platform tým najde odmítnutou akci v logu běhu a porovná role identity s těmi, které dává bootstrap platformy. Roli nikdy nerozšiřuje nad to, co platforma žádá.",
    },
    runbook: "onboard-instance",
  },
  PE007: {
    title: { en: "A rule of your organisation's cloud refused a resource", cs: "Pravidlo cloudu tvé organizace odmítlo prostředek" },
    text: {
      en: "Your organisation's cloud has a policy that refused a resource the app needs, for example its region, a size or a setting the policy doesn't allow. The people who run the organisation's cloud set these policies, not the platform.",
      cs: "Cloud tvé organizace má pravidlo (policy), které odmítlo prostředek, jejž aplikace potřebuje, například oblast, velikost nebo nastavení, které pravidlo nedovoluje. Taková pravidla nastavují lidé, kteří spravují cloud organizace, ne platforma.",
    },
    fix: {
      en: "The platform team finds the policy in the run's log and agrees an exception with its owners, or changes the platform's settings so the resource meets it. The next setup run then goes on.",
      cs: "Platform tým najde pravidlo v logu běhu a s jeho správci se dohodne na výjimce, nebo upraví nastavení platformy tak, aby mu prostředek vyhověl. Příští nastavování pak pokračuje.",
    },
  },
  PE008: {
    title: { en: "The platform may not change the app's sign-in registration", cs: "Platforma nesmí měnit registraci aplikace pro přihlášení" },
    text: {
      en: "The company directory refused a change to the app's sign-in registration, also when the platform tried again. The platform may change only the registrations it owns: someone made this one by hand or changed its owners, or the platform's permissions in the directory are missing.",
      cs: "Firemní adresář odmítl změnu registrace aplikace pro přihlášení, i když to platforma zkusila znovu. Platforma smí měnit jen registrace, které vlastní: tuhle někdo vytvořil ručně nebo změnil její vlastníky, nebo platformě v adresáři chybí oprávnění.",
    },
    fix: {
      en: "The platform team makes the platform's directory identity an owner of the registration again, or the identity team restores the directory permissions the platform was given when it was installed. What already works doesn't change meanwhile.",
      cs: "Platform tým vrátí identitě platformy v adresáři vlastnictví registrace, nebo tým identit obnoví oprávnění v adresáři, která platforma dostala při instalaci. Co už funguje, se mezitím nemění.",
    },
    runbook: "onboard-instance",
  },
  PE009: {
    title: { en: "The name of the app's vault is still held by a deleted vault", cs: "Název trezoru aplikace pořád drží smazaný trezor" },
    text: {
      en: "Every app gets a vault for its secrets, with a name that is unique worldwide. A vault with this name was deleted, and a deleted vault keeps its name for 7 to 90 days so that it can be recovered, so a new one can't be created under it. This can happen after an app's resources were deleted.",
      cs: "Každá aplikace dostane trezor na tajné hodnoty s názvem, který je jedinečný na celém světě. Trezor s tímto názvem byl smazán a smazaný trezor si název drží 7 až 90 dní, aby se dal obnovit, takže pod ním nový vytvořit nejde. Může se to stát poté, co byly prostředky aplikace smazány.",
    },
    fix: {
      en: "The platform team follows the runbook: it recovers the old vault or purges it, or, when the app is gone in every environment, raises generation in apps/<slug>/app.yaml through a pull request, which gives the app new names for its vault, registry, databases and storage everywhere. The next setup run then goes on.",
      cs: "Platform tým postupuje podle runbooku: starý trezor obnoví nebo trvale smaže, nebo, když už aplikace není v žádném prostředí, zvýší přes pull request generation v apps/<slug>/app.yaml, čímž aplikace dostane nové názvy trezoru, registru, databází i úložiště ve všech prostředích. Příští nastavování pak pokračuje.",
    },
    runbook: "key-vault-name-clash",
  },
  PE010: {
    title: {
      en: "A permission left over from the app's deleted resources blocks its setup",
      cs: "Nastavení aplikace blokuje oprávnění, které zůstalo po jejích smazaných prostředcích",
    },
    text: {
      en: "The app's resources in this environment were deleted outside the platform and are being set up again. A permission the old resources had on a shared part of the platform is still there under the same name, and the cloud doesn't let the new ones take it over. Other apps aren't affected.",
      cs: "Prostředky aplikace v tomto prostředí někdo smazal mimo platformu a teď se nastavují znovu. Oprávnění, které staré prostředky měly ke sdílené části platformy, pořád existuje pod stejným názvem a cloud nedovolí, aby ho převzaly nové. Ostatních aplikací se to netýká.",
    },
    fix: {
      en: "The platform removes such a leftover by itself when its own records prove it belonged to the app, and sets the app up again. This one it couldn't prove, so the platform team checks it as the runbook shows and deletes it by hand. The next setup run then goes on.",
      cs: "Takový pozůstatek platforma odstraní sama, když z vlastních záznamů dokáže, že patřil téhle aplikaci, a aplikaci nastaví znovu. U tohohle to dokázat nešlo, takže ho platform tým podle runbooku zkontroluje a smaže ručně. Příští nastavování pak pokračuje.",
    },
    runbook: "app-resource-group-deleted",
  },
};

/** The explanation of a provisioning failure code (ADR-0064), or undefined for a code this version doesn't know. */
export function explainProvisioningFailure(code: string): ProvisioningFailureExplanation | undefined {
  return (PROVISIONING_FAILURE_IDS as readonly string[]).includes(code) ? PROVISIONING_FAILURES[code as ProvisioningFailureId] : undefined;
}

/**
 * Whether a value has the shape of a failure code (PE and three digits). A code of a newer pipeline
 * that this version's catalogue doesn't know has the shape too: show it, with PE001's text.
 */
export function isProvisioningFailureCode(code: unknown): code is string {
  return typeof code === "string" && /^PE[0-9]{3}$/.test(code);
}

/** The explanation of a rule ID (an alias resolves to the current rule), a pipeline check, a check of an app definition or of the instance. */
export function explainCheck(id: string): CheckExplanation | undefined {
  if ((PIPELINE_CHECK_IDS as readonly string[]).includes(id)) return PIPELINE_EXPLANATIONS[id as PipelineCheckId];
  if ((DEFINITION_CHECK_IDS as readonly string[]).includes(id)) return DEFINITION_EXPLANATIONS[id as DefinitionCheckId];
  if ((INSTANCE_CHECK_IDS as readonly string[]).includes(id)) return INSTANCE_EXPLANATIONS[id as InstanceCheckId];
  const current = canonicalRuleId(id);
  return current !== undefined && Object.hasOwn(RULE_EXPLANATIONS, current) ? RULE_EXPLANATIONS[current] : undefined;
}

/** What the portal (or anything else) knows about a failed check, to put around a rule's prompt. */
export interface PromptContext {
  /** The app's name or slug. */
  app?: string;
  /** The environment the check failed for. */
  environment?: string;
  /** A path in the app repository, as the check reported it. */
  file?: string;
  line?: number;
  /** Every place the check found it (at most 10 are named); instead of `file` and `line` when there are several. */
  places?: { file: string; line?: number }[];
  /** The pipeline run. */
  runUrl?: string;
  /** Facts the check results give (a few lines, such as the vulnerabilities that block production). */
  details?: string[];
}

/** One line of untrusted text for a prompt: no control, format or line characters, no backticks, bounded. */
function plain(value: string, max: number): string {
  const clean = value.replace(/[\p{Cc}\p{Cf}\u2028\u2029`]+/gu, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const PROMPT_TEXT = {
  en: {
    failed: (title: string, id: string, who: string) => `The platform's check "${title}" (${id}) failed${who}`,
    inEnv: (app: string, env: string) => `${app ? ` for ${app}` : ""}${env ? ` in ${env}` : ""}`,
    where: (file: string, line: number | undefined) => ` (${file}${line ? `, line ${line}` : ""})`,
    run: (url: string) => `Run: ${url}`,
    details: "Details:",
    tail: "When you're done, run `platform check`, fix anything it still reports, update CHANGELOG.md and commit the fix.",
    tailDefinition: "When you're done, run `platform validate app apps/<slug>/app.yaml --instance instance.yaml` in platform-config and fix anything it still reports.",
    tailInstance: "When you're done, run `platform validate instance instance.yaml --base <target branch>` in platform-config and fix anything it still reports.",
    tailArchive: "When you're done, run `platform validate archive . --base <target branch>` in platform-config and fix anything it still reports.",
  },
  cs: {
    failed: (title: string, id: string, who: string) => `Kontrola platformy „${title}“ (${id}) selhala${who}`,
    inEnv: (app: string, env: string) => `${app ? ` u aplikace ${app}` : ""}${env ? ` v prostředí ${env}` : ""}`,
    where: (file: string, line: number | undefined) => ` (${file}${line ? `, řádek ${line}` : ""})`,
    run: (url: string) => `Běh: ${url}`,
    details: "Podrobnosti:",
    tail: "Až skončíš, spusť `platform check`, oprav všechno, co ještě ohlásí, doplň CHANGELOG.md a commitni opravu.",
    tailDefinition: "Až skončíš, spusť v platform-config `platform validate app apps/<slug>/app.yaml --instance instance.yaml` a oprav všechno, co ještě ohlásí.",
    tailInstance: "Až skončíš, spusť v platform-config `platform validate instance instance.yaml --base <cílová větev>` a oprav všechno, co ještě ohlásí.",
    tailArchive: "Až skončíš, spusť v platform-config `platform validate archive . --base <cílová větev>` a oprav všechno, co ještě ohlásí.",
  },
} as const;

/**
 * The prompt for the developer's AI agent for a failed check: what failed and where, what the check
 * found, what to do, and the usual finish (`platform check`, CHANGELOG.md, commit). undefined for an
 * ID the catalogue doesn't know. Every value of `ctx` is shortened and stripped of line breaks and
 * backticks: file names come from the app's own repository.
 */
export function checkAiPrompt(id: string, lang: ExplanationLanguage, ctx: PromptContext = {}): string | undefined {
  const e = explainCheck(id);
  if (!e) return undefined;
  const x = PROMPT_TEXT[lang];
  const shown = canonicalRuleId(id) ?? id;
  const who = x.inEnv(ctx.app ? plain(ctx.app, 80) : "", ctx.environment ? plain(ctx.environment, 40) : "");
  const places = (ctx.places ?? (ctx.file ? [{ file: ctx.file, ...(ctx.line !== undefined ? { line: ctx.line } : {}) }] : [])).slice(0, 10).map((p) => ({ file: plain(p.file, 200), line: p.line })).filter((p) => p.file !== "");
  const first = places[0];
  const where = places.length === 1 && first ? x.where(first.file, first.line) : places.length > 1 ? ` (${places.map((p) => `${p.file}${p.line ? `:${p.line}` : ""}`).join(", ")})` : "";
  const lines = [
    `${x.failed(e.title[lang], shown, who)}${where}.`,
    e.text[lang],
    e.prompt[lang],
    ...(ctx.details && ctx.details.length > 0 ? [x.details, ...ctx.details.slice(0, 10).map((d) => `- ${plain(d, 200)}`)] : []),
    ...(ctx.runUrl && /^https:\/\/[^\s`]{1,500}$/.test(ctx.runUrl) ? [x.run(ctx.runUrl)] : []),
    id === "deleted-archive" ? x.tailArchive : (DEFINITION_CHECK_IDS as readonly string[]).includes(id) ? x.tailDefinition : (INSTANCE_CHECK_IDS as readonly string[]).includes(id) ? x.tailInstance : x.tail,
  ];
  return lines.join("\n");
}
