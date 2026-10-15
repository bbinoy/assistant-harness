// A tiny, dependency-free guess at the language of a short text (no network). Used before speech: the voice
// speaks only the languages in TTS_LANGUAGES, and a German sentence read by an English voice sounds bad.
// Pure. It answers only when fairly sure, otherwise undefined (and the caller then lets the text through).

const WORDS: Record<string, string> = {
  en: "the and is are was were to of in that it for you with this have not but be on at as your we they will can what there so just about from my me do if or would how",
  de: "der die das und ist nicht ich du sie wir ihr es ein eine einen mit für auf von zu den dem des im auch aber wie wenn dann noch nur schon mein dein hast habe haben wird werden kann sind war heute morgen bitte danke ja nein",
  fr: "le la les des un une et est que qui pas pour dans sur avec ce cette je tu il elle nous vous ils sont mais ou comme plus tout très être avoir fait bien merci bonjour oui non du au aux",
  es: "el la los las un una y es que de en por para con no se su lo como más pero muy está están soy eres tengo tiene hay este esta yo tú nosotros gracias hola sí al del",
  it: "il lo la gli le un una e è che di in per con non si come più ma molto sono siamo ho ha hanno questo questa io tu noi voi grazie ciao sì al del della",
  pt: "o os as um uma e é que de em por para com não se como mais mas muito estou está são tenho tem isso este esta eu você nós obrigado olá sim ao do da",
  nl: "de het een en is dat van in op te voor met niet zijn ik je we jullie ze maar ook als nog wel heel dank hallo ja nee",
};
const SETS = Object.entries(WORDS).map(([lang, w]) => [lang, new Set(w.split(" "))] as const);

// Scripts that are never English: a third of the letters in one is enough.
const SCRIPTS: ReadonlyArray<[string, RegExp]> = [
  ["ru", /[Ѐ-ӿ]/g], ["ar", /[؀-ۿ]/g], ["he", /[֐-׿]/g], ["hi", /[ऀ-ॿ]/g],
  ["ja", /[぀-ヿ]/g], ["ko", /[가-힯]/g], ["zh", /[一-鿿]/g], ["el", /[Ͱ-Ͽ]/g],
];

const MIN_LETTERS = 12;

// ISO 639-1 code of the likely language, or undefined when unsure (too short, mixed, or an unknown language).
export function detectLanguage(text: string): string | undefined {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters < MIN_LETTERS) return undefined;
  for (const [lang, re] of SCRIPTS) if ((text.match(re)?.length ?? 0) >= letters / 3) return lang === "zh" && /[぀-ヿ]/.test(text) ? "ja" : lang;
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 3) return undefined;
  const score = new Map<string, number>();
  for (const [lang, set] of SETS) score.set(lang, words.filter((w) => set.has(w)).length);
  // Letters only some languages use are strong hints.
  // They count only on top of real word hits, so a list of names with umlauts is not taken for German.
  const bump = (lang: string, re: RegExp) => { if ((score.get(lang) ?? 0) > 0) score.set(lang, score.get(lang)! + Math.min(3, text.match(re)?.length ?? 0)); };
  bump("de", /[äöüß]/gi); bump("es", /[ñ¿¡]/gi); bump("fr", /[çèêëàâîôûœ]/gi); bump("pt", /[ãõ]/gi);
  const ranked = [...score].sort((a, b) => b[1] - a[1]);
  const [best, top] = ranked[0]!;
  const second = ranked[1]![1];
  if (top < 2 || top < second * 1.5 || top / words.length < 0.12) return undefined;
  return best;
}

// The configured list, e.g. "en, de" -> ["en","de"]. Region suffixes are dropped ("en-US" -> "en"). Empty means en.
export const parseLanguages = (raw: string | undefined): string[] => {
  const l = (raw ?? "").split(",").map((s) => s.trim().toLowerCase().split(/[-_]/)[0]!).filter(Boolean);
  return l.length ? [...new Set(l)] : ["en"];
};

// The detected language when the voice should NOT speak this text (detected and not supported), else undefined.
export const unsupportedForVoice = (text: string, supported: readonly string[]): string | undefined => {
  const lang = detectLanguage(text);
  return lang && !supported.includes(lang) ? lang : undefined;
};
