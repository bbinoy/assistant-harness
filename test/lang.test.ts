import test from "node:test";
import assert from "node:assert/strict";
import { detectLanguage, parseLanguages, unsupportedForVoice } from "../src/lang.ts";
import { voiceOption } from "../src/voicereply.ts";

test("language detection: common languages are recognised, short or unclear text is not guessed", () => {
  assert.equal(detectLanguage("You have two meetings today, and the first one is at ten thirty."), "en");
  assert.equal(detectLanguage("Du hast heute zwei Termine, und der erste ist um halb elf. Viel Erfolg!"), "de");
  assert.equal(detectLanguage("Heute ist das Wetter schön, aber morgen wird es regnen."), "de");
  assert.equal(detectLanguage("Tu as deux réunions aujourd'hui, et la première est à dix heures."), "fr");
  assert.equal(detectLanguage("Hoy tienes dos reuniones, y la primera es a las diez y media."), "es");
  assert.equal(detectLanguage("Oggi hai due riunioni, e la prima è alle dieci e mezza."), "it");
  assert.equal(detectLanguage("Привет, у тебя сегодня две встречи, первая в десять тридцать."), "ru");
  assert.equal(detectLanguage("今日は二つの会議があります。最初は十時半です。"), "ja");
  assert.equal(detectLanguage("Danke!"), undefined);
  assert.equal(detectLanguage("OK, Termin 14:30 Uhr"), undefined);
  assert.equal(detectLanguage("Spotify Anthropic Kubernetes Zürich Berlin München"), undefined);
});

test("language list: parsed from the setting, regions dropped, default en", () => {
  assert.deepEqual(parseLanguages(undefined), ["en"]);
  assert.deepEqual(parseLanguages(""), ["en"]);
  assert.deepEqual(parseLanguages(" en-US, DE ,de"), ["en", "de"]);
});

test("voice safety net: only text detected in an unsupported language is held back", () => {
  const de = "Du hast heute zwei Termine, und der erste ist um halb elf.";
  assert.equal(unsupportedForVoice(de, ["en"]), "de");
  assert.equal(unsupportedForVoice(de, ["en", "de"]), undefined);
  assert.equal(unsupportedForVoice("You have two meetings today, and the first is at ten.", ["en"]), undefined);
  assert.equal(unsupportedForVoice("Danke!", ["en"]), undefined); // unsure: let it through
});

test("the voice prompt names the supported languages and says to use text for any other", () => {
  assert.match(voiceOption(true, ["en"]), /speaks only these languages: en\. If your reply is in any other language, answer in text and do not use \[\[voice\]\]/);
  assert.match(voiceOption(true, ["en", "de"]), /languages: en, de\./);
  assert.match(voiceOption(true), /languages: en\./); // the default setting
});
