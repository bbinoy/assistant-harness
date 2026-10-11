// Phone-readable approval text, built deterministically from the exact tool
// arguments. Deliberately not model-written: an approval prompt that a model
// paraphrases can misrepresent the call it is meant to guard.

const TOOLS: Record<string, { icon: string; title: string }> = {
  mcp__claude_ai_Google_Calendar__create_event: { icon: "📅", title: "Create calendar event" },
  mcp__claude_ai_Google_Calendar__update_event: { icon: "📅", title: "Change calendar event" },
  mcp__claude_ai_Google_Calendar__respond_to_event: { icon: "📅", title: "Respond to invite" },
  mcp__mailbird__send_message_now: { icon: "✉️", title: "Send email now" },
  mcp__mailbird__forward_conversation: { icon: "✉️", title: "Forward email" },
  mcp__claude_ai_Gmail__send_message: { icon: "✉️", title: "Send email" },
  mcp__claude_ai_Gmail__forward: { icon: "✉️", title: "Forward email" },
  mcp__claude_ai_Gmail__reply: { icon: "✉️", title: "Reply to email" },
  mcp__claude_ai_Google_Drive__share_file: { icon: "🔗", title: "Share a Drive file" },
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Stamp = { day: string; time?: string };

// "2026-10-12T16:00:00" -> { day: "Mon 12 Oct", time: "16:00" }. Local wall time, no zone maths.
function stamp(value: unknown): Stamp | undefined {
  if (typeof value !== "string") return undefined;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return {
    day: `${DAYS[date.getUTCDay()]} ${Number(d)} ${MONTHS[date.getUTCMonth()]}`,
    time: h !== undefined ? `${h}:${mi}` : undefined,
  };
}

function when(start: unknown, end: unknown, zone: unknown): string | undefined {
  const s = stamp(start);
  if (!s) return undefined;
  const e = stamp(end);
  const tz = typeof zone === "string" && zone ? ` (${zone})` : "";
  if (!s.time) return e && e.day !== s.day ? `${s.day} to ${e.day}, all day` : `${s.day}, all day`;
  if (!e) return `${s.day}, ${s.time}${tz}`;
  if (e.day === s.day) return `${s.day}, ${s.time}–${e.time}${tz}`;
  return `${s.day} ${s.time} → ${e.day} ${e.time}${tz}`;
}

// An approval must never hide content silently: whatever is cut is announced.
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}… (+${flat.length - max} more characters not shown)` : flat;
}

// Free text the owner is being asked to approve (an email body, event notes) gets more room.
const LONG_TEXT = new Set(["body", "description", "message", "text", "content", "markdownBody"]);

// Shape of an attendee/recipient object: shown as just its address. Anything else is shown whole.
const PERSON_KEYS = new Set(["email", "address", "name", "displayName", "responseStatus", "optional"]);

function show(key: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => show(key, v)).join(", ");
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const id = o.email ?? o.address;
    if (typeof id === "string" && Object.keys(o).every((k) => PERSON_KEYS.has(k))) return id;
    return clip(JSON.stringify(value), 300);
  }
  return clip(String(value), LONG_TEXT.has(key) ? 1200 : 200);
}

function humanise(tool: string): string {
  const [server, name] = tool.replace(/^mcp__(claude_ai_)?/, "").split("__");
  const words = (name ?? server ?? tool).replace(/[_-]+/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} (${(server ?? "").replace(/_/g, " ")})`;
}

const LABELS: Record<string, string> = {
  summary: "Title", title: "Title", subject: "Subject", to: "To", cc: "Cc", bcc: "Bcc",
  location: "Where", attendees: "With", description: "Notes", body: "Message",
};
// Fields shown specially or not worth showing.
const SKIP = new Set(["startTime", "endTime", "start", "end", "timeZone", "timezone", "summary", "title"]);
const SKIP_VALUES = new Set(["primary"]);

export function describeCall(tool: string, input: Record<string, unknown>): string {
  const meta = TOOLS[tool];
  const lines: string[] = [meta ? `${meta.icon} ${meta.title}` : `❓ ${humanise(tool)}`];

  const title = input.summary ?? input.title;
  if (typeof title === "string" && title) lines.push(`“${clip(title, 120)}”`);

  const time = when(input.startTime ?? input.start, input.endTime ?? input.end, input.timeZone ?? input.timezone);
  if (time) lines.push(`🕒 ${time}`);

  for (const [key, value] of Object.entries(input)) {
    if (SKIP.has(key) || value === undefined || value === null || value === "") continue;
    if (typeof value === "string" && SKIP_VALUES.has(value)) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    lines.push(`${LABELS[key] ?? key}: ${show(key, value)}`);
  }
  return lines.join("\n");
}
