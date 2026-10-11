// Wraps untrusted or stored text as clearly fenced DATA for a prompt. A closing tag inside
// the body is broken up (in any letter case), so the text cannot end its own fence and pose
// as instructions. Tags are plain identifiers, so they are safe inside a RegExp.
export const fence = (tag: string, body: string) =>
  `<${tag}>\n${body.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1")}\n</${tag}>`;
