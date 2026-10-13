// A reply the model chose to SPEAK starts with "[[voice]]", followed by the words to say aloud.
// Same shape as the emoji reaction (reaction.ts): strict and only at the very start, so ordinary
// text can never be mistaken for it. Pure.

const MARK = /^\s*\[\[voice\]\]\s*/i;

// { voice, text }: the words to speak (if the model chose to speak), or the text to send.
export function splitVoice(reply: string): { voice?: string; text: string } {
  const m = MARK.exec(reply);
  return m ? { voice: reply.slice(m[0].length).trim(), text: reply.slice(m[0].length).trim() } : { text: reply };
}

// The voice option, added to every prompt that can produce a reply whenever speech is set up (private chat, group
// messages addressed or not, wake-ups): the model chooses freely, whatever kind of message it answers. The notes
// can overrule this default ("never use voice", "voice for pep talks").
export const VOICE_INVITE =
  "you may answer by voice by starting your reply with [[voice]] and then only the words to say aloud, short and plain (no markdown, emoji, links or lists); good for warm, personal or spoken-style replies such as a pep talk or a joke; keep exact, long or detailed answers (times, figures, links, lists) in text. If the notes say how to use voice (or never to), follow them";
export const voiceOption = (canSpeak: boolean): string => (canSpeak ? `Voice: ${VOICE_INVITE}.` : "");
