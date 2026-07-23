// Both execution and chat inherit the full server env, so run logs can contain
// live credentials. A consultation transcript is persisted and may be shared,
// so every section of a context package passes through here first.
const SECRET_NAME = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
const MIN_SECRET_LENGTH = 8;
const REDACTED = "[REDACTED]";

const SHAPES: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
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
