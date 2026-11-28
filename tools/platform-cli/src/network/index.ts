import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { neutralize } from "../neutralize.js";
import { hubConnectionRequest, isConnectedMode, NetworkRequestError, REQUEST_LANGUAGES } from "../network-request.js";
import type { RequestInstance, RequestLanguage } from "../network-request.js";
import { CheckFailed, UsageError } from "../pipeline/common.js";
import { loadInstanceFile } from "../provisioning/model.js";

export const NETWORK_HELP = `platform network <command>: texts for the customer's network team (ADR-0027, amended
2026-11-12; pure: instance.yaml in, text out, no Azure calls; the platform changes no firewall rule)

  request [--config-dir <dir>] --env <name> [--mode externalHybrid] [--lang en|cs] [--output <file>]
      the request to connect the environment's connected network mode to the customer's hub: the
      spoke VNet, the peering both ways, the route table to the firewall, the DNS servers and the
      private DNS zones they must resolve, and the standing egress baseline (network-modes.md);
      from <dir>/instance.yaml (default dir: .); printed, or written to --output. The portal's
      Settings > Environments writes the same text. An app's request for an internal system is
      written in the portal (the app's Internal systems tab).

Exit codes: 0 ok, 1 the environment has no such mode or no hub, or instance.yaml is invalid (one
stderr line per problem), 2 usage or internal error.
`;

function report(cmd: string, e: unknown): number {
  const err = (msg: string): void => {
    process.stderr.write(neutralize(`platform ${cmd}: ${msg.replace(/\s*[\r\n]+\s*/g, " ")}`) + "\n");
  };
  if (e instanceof CheckFailed) {
    for (const p of e.problems) err(p);
    return 1;
  }
  if (e instanceof NetworkRequestError && e.code !== "input") {
    err(e.message);
    return 1;
  }
  if (e instanceof UsageError || e instanceof NetworkRequestError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
    err(`${(e as Error).message} Run "platform network help" for usage.`);
    return 2;
  }
  err(`internal error: ${e instanceof Error ? e.message : String(e)}`);
  return 2;
}

/** `platform network request`: the hub connection text of one environment. */
function cmdRequest(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { "config-dir": { type: "string", default: "." }, env: { type: "string" }, mode: { type: "string", default: "externalHybrid" }, lang: { type: "string", default: "en" }, output: { type: "string" } },
  });
  if (positionals.length) throw new UsageError("takes no positional arguments (use --config-dir).");
  if (!values.env) throw new UsageError("missing --env.");
  const lang = values.lang as string;
  if (!(REQUEST_LANGUAGES as readonly string[]).includes(lang)) throw new UsageError("--lang must be en or cs.");
  const mode = values.mode as string;
  if (!isConnectedMode(mode)) throw new UsageError("--mode must be externalHybrid (internalOnly later).");
  if (mode === "internalOnly") throw new UsageError("internalOnly is not built yet (ADR-0003): --mode externalHybrid.");
  const path = join(resolve(values["config-dir"] as string), "instance.yaml");
  if (!existsSync(path)) throw new CheckFailed([`${path} not found: --config-dir must be a platform-config checkout.`]);
  const instance = loadInstanceFile(path) as unknown as RequestInstance;
  const { text, fileName } = hubConnectionRequest({ instance, environment: values.env, mode, date: new Date(), lang: lang as RequestLanguage });
  if (values.output) {
    writeFileSync(values.output, text);
    process.stdout.write(neutralize(`OK  ${fileName.replace(/\.txt$/, "")} written to ${values.output}\n`));
  } else {
    process.stdout.write(neutralize(text));
  }
  return 0;
}

/** `platform network <command>` */
export function cmdNetwork(argv: string[]): number {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(NETWORK_HELP);
    return command ? 0 : 2;
  }
  try {
    if (command === "request") return cmdRequest(args);
    throw new UsageError(`unknown command "${command.slice(0, 40)}"; commands: request.`);
  } catch (e) {
    return report(`network ${command.slice(0, 40)}`, e);
  }
}
