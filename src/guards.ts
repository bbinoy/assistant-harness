// The security boundary for incoming Signal messages, as a pure function.
// The linked Signal device sees ALL of the owner's incoming traffic (friends, groups),
// so the agent must only ever act on the owner's own Note to Self.
export function acceptOwner(m: { from: string; noteToSelf: boolean }, ownerNumber: string): boolean {
  return m.noteToSelf && m.from === ownerNumber && ownerNumber.length > 0;
}
