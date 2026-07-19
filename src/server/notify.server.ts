const DISCORD_CONTENT_LIMIT = 1_900;

export async function notify(text: string): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text.slice(0, DISCORD_CONTENT_LIMIT) }),
  }).catch(() => undefined);
}
