'use strict';
// Optional. Turns the keyword table into a short opportunity brief using the Claude API and your own API key.
async function insights({ key, model, seed, city, total, intents, places, top, signal, base }) {
  const prompt = `You are a market analyst helping a small software founder decide what to sell and to whom.
Seed topic: "${seed}"${city ? ` (home city: ${city})` : ''}. The data below is REAL search-suggestion data (not search volume). ${total} phrases were collected.

Intent counts: ${JSON.stringify(intents)}
Places mentioned (count): ${JSON.stringify(places)}
Top phrases (score 0-100, intent):
${top.map((r) => `${r.score} ${r.intent} | ${r.phrase}`).join('\n')}

Write a brief. Only use evidence in the data; if a claim is a guess, say so. Ignore phrases that clearly mean something unrelated to the topic.
Return ONLY JSON: {"summary":"2-3 sentences","opportunities":[{"title":"","evidence":"phrases from the data that support it","who_to_sell_to":"","offer_idea":"","first_message":"a 2-sentence message in simple English"}],"watch_out":["risks or gaps in this data"]}
Give 4 to 6 opportunities, best first.`;
  const res = await fetch((base || 'https://api.anthropic.com') + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    signal,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j.error && j.error.message) || `Claude API returned HTTP ${res.status}`);
  const text = (j.content || []).map((c) => c.text || '').join('');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('The AI reply was not JSON. Try again.');
  return JSON.parse(text.slice(a, b + 1));
}
module.exports = { insights };
