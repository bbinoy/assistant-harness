// The model may answer with an emoji reaction on the owner's message instead of (or before) a text,
// for acknowledgements that need no words: thanks, ok, a joke that landed. It writes
// "[[react: 👍]]" at the very start of its reply. Pure and strict: exactly one emoji, only at the
// start, so ordinary text can never be mistaken for it.

const MARK = /^\s*\[\[react:\s*([^\]]{1,16}?)\s*\]\]\s*/;

const isOneEmoji = (s: string) => {
  const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)];
  return parts.length === 1 && /\p{Extended_Pictographic}/u.test(s);
};

// { reaction, text }: the emoji to react with (if any) and what remains to be said.
export function splitReaction(reply: string): { reaction?: string; text: string } {
  const m = MARK.exec(reply);
  if (!m || !isOneEmoji(m[1]!)) return { text: reply };
  return { reaction: m[1]!, text: reply.slice(m[0].length).trim() };
}
