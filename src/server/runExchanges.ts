import { InputExchangeSchema, type InputExchange } from "../domain/schemas";

export function projectExchanges(raw: unknown): {
  exchanges: InputExchange[];
  dropped: number;
} {
  const rows = Array.isArray(raw) ? raw : [];
  const exchanges = rows.flatMap((exchange) => {
    const parsed = InputExchangeSchema.safeParse(exchange);
    return parsed.success ? [parsed.data] : [];
  });
  return { exchanges, dropped: rows.length - exchanges.length };
}
