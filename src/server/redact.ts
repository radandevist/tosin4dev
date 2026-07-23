// Defense-in-depth for structured context fields; this is not the primary control.
// Raw log text is excluded from the context package before values reach here.
const SECRET_NAME = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
const MIN_SECRET_LENGTH = 8;
const REDACTED = "[REDACTED]";

const SHAPES: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[A-Za-z0-9_-]{35}/g,
  /[sr]k_(live|test)_[A-Za-z0-9]{16,}/g,
  /whsec_[A-Za-z0-9]{16,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSecrets(text: string): string {
  let out = text;
  // Env-derived first: this catches the ACTUAL live secrets regardless of shape.
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (!SECRET_NAME.test(name)) continue;
    out = out.replace(new RegExp(escapeRegExp(value), "g"), REDACTED);
  }
  for (const shape of SHAPES) out = out.replace(shape, REDACTED);
  return out;
}
