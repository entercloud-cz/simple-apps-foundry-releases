/**
 * Azure DevOps agents interpret `##vso[...]` logging commands and `##[...]` formatting commands
 * anywhere in a line written to stdout or stderr. Text the CLI did not write itself (file
 * contents, docker output, image data, Trivy output, ARM errors) could carry such a command and
 * set variables, upload files or fake log groups in a trusted job. Every byte the CLI prints goes
 * through this function, so a zero-width space is inserted between the two `#` (case-insensitive,
 * like the agent's own parser). The only logging command the CLI emits on purpose is the output
 * variable of `platform pipeline deploy-branch --set-output`, written past this function.
 */
const ZWSP = "​";

export function neutralize(text: string): string {
  return text.replace(/##(?=vso\[|\[)/gi, `#${ZWSP}#`);
}
