export interface BannerOptions {
  // When false, emit plain ASCII with no ANSI escapes (for NO_COLOR / non-TTY).
  color?: boolean;
}

// ANSI Shadow figlet rows, split into the "PRO" group and the "dex" group so each
// can be colored independently. Both groups keep a fixed per-row width so the
// halves line up when concatenated.
const PRO_ROWS = [
  "██████╗ ██████╗  ██████╗ ",
  "██╔══██╗██╔══██╗██╔═══██╗",
  "██████╔╝██████╔╝██║   ██║",
  "██╔═══╝ ██╔══██╗██║   ██║",
  "██║     ██║  ██║╚██████╔╝",
  "╚═╝     ╚═╝  ╚═╝ ╚═════╝ "
];

const DEX_ROWS = [
  "██████╗ ███████╗██╗  ██╗",
  "██╔══██╗██╔════╝╚██╗██╔╝",
  "██║  ██║█████╗   ╚███╔╝ ",
  "██║  ██║██╔══╝   ██╔██╗ ",
  "██████╔╝███████╗██╔╝ ██╗",
  "╚═════╝ ╚══════╝╚═╝  ╚═╝ "
];

const ESC = "";
const RED = `${ESC}[38;2;190;28;28m`; // PRO — #BE1C1C
const DEX = `${ESC}[38;2;210;213;219m`; // dex — light graphite (visible on dark terminals)
const DIM = `${ESC}[38;2;140;144;150m`; // tagline
const RESET = `${ESC}[0m`;

const TAGLINE = "Local bridge so Codex, Claude & other agents share ChatGPT Pro";

export function renderBanner(options: BannerOptions = {}): string {
  const color = options.color ?? true;
  const rows: string[] = [];
  for (let i = 0; i < PRO_ROWS.length; i++) {
    const pro = PRO_ROWS[i];
    const dex = DEX_ROWS[i];
    rows.push(color ? `${RED}${pro}${DEX}${dex}${RESET}` : `${pro}${dex}`);
  }
  rows.push("");
  rows.push(color ? `  ${DIM}${TAGLINE}${RESET}` : `  ${TAGLINE}`);
  return rows.join("\n");
}

// Decide whether to colorize based on the environment (honors NO_COLOR, FORCE_COLOR, TTY).
export function shouldColorize(env: NodeJS.ProcessEnv = process.env, isTty = process.stdout.isTTY): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") return true;
  return Boolean(isTty);
}
