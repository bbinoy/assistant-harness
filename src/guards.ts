// The security boundary for incoming Signal messages, as a pure function.
// The linked Signal device sees ALL of the owner's incoming traffic (friends, groups),
// so the agent must only ever act on the owner's own private channel with it: their Note to Self,
// or (when the assistant has its own Signal account) a one-to-one chat with them, never a group.
export function acceptOwner(m: { from: string; direct: boolean }, ownerNumber: string): boolean {
  return m.direct && m.from === ownerNumber && ownerNumber.length > 0;
}
