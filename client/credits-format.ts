/**
 * Codex credit balances arrive as decimal strings exactly as the issuer sent them. They are shown rounded
 * to two decimals (half up), trailing zeros dropped, grouped with commas whatever the locale. All of it is
 * exact decimal arithmetic on the string (BigInt), never binary floating point. Anything that is not a
 * plain decimal ("1e3", "abc", "12,5", ...) is shown as the raw string.
 */
const plain = /^([+-]?)(\d*)(?:\.(\d*))?$/;

function parse(raw: string): { negative: boolean; int: string; frac: string } | null {
  const text = raw.trim();
  const m = plain.exec(text);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return null;
  return { negative: m[1] === "-", int: m[2] || "0", frac: m[3] ?? "" };
}
const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** "71023.5086225000" -> "71,023.51"; "12.50" -> "12.5"; "0" -> "0". */
export function formatCredits(raw: string): string {
  const p = parse(raw);
  if (!p) return raw;
  const frac3 = (p.frac + "000").slice(0, 3);
  // two decimals, rounded half up on the third digit of the magnitude
  let cents = BigInt(p.int + frac3.slice(0, 2));
  if (frac3[2]! >= "5") cents += 1n;
  const digits = cents.toString().padStart(3, "0");
  const whole = digits.slice(0, -2);
  const decimals = digits.slice(-2).replace(/0+$/, "");
  const body = group(whole) + (decimals ? "." + decimals : "");
  if (cents === 0n) {
    // A positive balance below half a cent must not read as zero credits.
    const positive = !p.negative && /[1-9]/.test(p.int + p.frac);
    return positive ? "<0.01" : "0";
  }
  return p.negative ? "-" + body : body;
}

/** Whole credits for speech: "71023.5086225000" -> "71,023" (truncated, not rounded). */
export function formatCreditsWhole(raw: string): string {
  const p = parse(raw);
  if (!p) return raw;
  const whole = BigInt(p.int);
  return (p.negative && whole !== 0n ? "-" : "") + group(whole.toString());
}

/** Spoken form: whole credits, or "less than 1 credit" for a positive balance below 1. */
export function spokenCredits(raw: string): string {
  const p = parse(raw);
  if (!p) return `${raw} credits`;
  const whole = formatCreditsWhole(raw);
  if (!p.negative && whole === "0" && /[1-9]/.test(p.int + p.frac)) return "less than 1 credit";
  return whole === "1" ? "1 credit" : `${whole} credits`;
}
