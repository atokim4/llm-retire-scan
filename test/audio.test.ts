import { describe, expect, it } from "vitest";

import { scanText } from "../src/scan.ts";

const TODAY = "2026-11-15";
const scan = (file: string, text: string) => scanText(file, text, ["openai"], undefined, TODAY);
const callFindings = (file: string, text: string) =>
  scan(file, text).findings.filter((f) => f.rule === "speech-endpoint" || f.rule === "transcribe-params");

describe("Speech API calls", () => {
  it("flags a Python speech call once, with the voice and mp3 default it would lose", () => {
    const text = [
      "from openai import OpenAI",
      "client = OpenAI()",
      "with client.audio.speech.with_streaming_response.create(",
      '    model="tts-1", voice="nova", input=text,',
      ") as response:",
      '    response.stream_to_file("out.mp3")',
      "",
    ].join("\n");
    const [finding, ...rest] = callFindings("tts.py", text);
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ rule: "speech-endpoint", line: 3, severity: "error" });
    expect(finding?.message).toContain("2027-01-06 (in 52 days)");
    expect(finding?.message).toContain('voice "nova" is not one of the Realtime voices');
    expect(finding?.message).toContain("the mp3 this call gets needs its own encoder");
    // The model ID keeps its own finding, which now says the endpoint changes too.
    const id = scan("tts.py", text).findings.find((f) => f.rule === "audio-shutdown");
    expect(id?.message).toContain("only on the Realtime API");
  });

  it("flags a JS call with a model set elsewhere, and says nothing extra for wav + a Realtime voice", () => {
    const text = [
      "const audio = await openai.audio.speech.create({",
      "  model: process.env.TTS_MODEL,",
      '  voice: "coral",',
      "  input,",
      '  response_format: "wav",',
      "});",
    ].join("\n");
    const [finding] = callFindings("speak.ts", text);
    expect(finding?.rule).toBe("speech-endpoint");
    expect(finding?.message).not.toContain("Also:");
  });

  it("flags out-of-range speed", () => {
    const text = 'client.audio.speech.create(model="gpt-4o-mini-tts", voice="ash", input=t, response_format="pcm", speed=2.0)\n';
    expect(callFindings("s.py", text)[0]?.message).toContain("speed 2 is outside the Realtime range");
  });

  it("finds raw HTTP calls to /v1/audio/speech", () => {
    const text = [
      'const res = await fetch("https://api.openai.com/v1/audio/speech", {',
      '  method: "POST",',
      '  body: JSON.stringify({ model: "tts-1-hd", voice: "onyx", input }),',
      "});",
    ].join("\n");
    expect(callFindings("raw.js", text).map((f) => `${f.line}:${f.rule}`)).toEqual(["1:speech-endpoint"]);
  });
});

describe("Speech API look-alikes (from the proof run)", () => {
  it("skips the endpoint path in string handling and config lookups", () => {
    const text = [
      'if base.endswith("/audio/speech"):',
      '    base = base[: -len("/audio/speech")]',
      'api_url = entry.data.get(CONF_URL, "https://api.openai.com/v1/audio/speech")',
      'DEFAULT_URL = "https://api.openai.com/v1/audio/speech"',
      "",
    ].join("\n");
    expect(callFindings("voice_listing.py", text)).toEqual([]);
  });

  it("doesn't assume the mp3 default when a spread may set response_format", () => {
    const [finding] = callFindings("t.py", "return client.audio.speech.create(**create_kwargs)\n");
    expect(finding?.rule).toBe("speech-endpoint");
    expect(finding?.message).not.toContain("mp3");
  });

  it("finds fetch with a template-literal URL", () => {
    const text = "const r = await fetch(`${base.replace(/\\/+$/, '')}/audio/speech`, { method: 'POST', body })\n";
    expect(callFindings("v.ts", text).map((f) => f.rule)).toEqual(["speech-endpoint"]);
  });
});

describe("transcription calls", () => {
  it("lists every whisper-1 setting that changes on gpt-transcribe", () => {
    const text = [
      "transcript = client.audio.transcriptions.create(",
      '    model="whisper-1",',
      "    file=audio_file,",
      '    language="uz",',
      '    response_format="verbose_json",',
      '    timestamp_granularities=["word"],',
      ")",
    ].join("\n");
    const [finding, ...rest] = callFindings("stt.py", text);
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ rule: "transcribe-params", line: 1, severity: "warn" });
    expect(finding?.message).toContain("whisper-1, which shuts down on 2027-02-26");
    expect(finding?.message).toContain("timestamp_granularities is supported only on whisper-1");
    expect(finding?.message).toContain("`languages` (a list) in place of `language`");
    expect(finding?.message).toContain('response_format "verbose_json"');
  });

  it("reads requests.post(..., data={...}) to the raw endpoint", () => {
    const text = [
      "r = requests.post(",
      '    "https://api.openai.com/v1/audio/transcriptions",',
      "    headers=headers,",
      '    files={"file": f},',
      '    data={"model": "whisper-1", "response_format": "srt"},',
      ")",
    ].join("\n");
    expect(callFindings("raw.py", text)[0]?.message).toContain('response_format "srt"');
  });

  it("reads a FormData body built just before a fetch wrapper (URL as the second argument)", () => {
    const text = [
      "const form = new FormData();",
      'form.append("file", audio, filename);',
      'form.append("model", "whisper-1");',
      'form.append("response_format", "verbose_json");',
      'if (hint) form.append("language", hint);',
      'const res = await openaiFetch(auth, "https://api.openai.com/v1/audio/transcriptions", {',
      '  method: "POST",',
      "  body: form,",
      "});",
    ].join("\n");
    const [finding] = callFindings("meeting.ts", text);
    expect(finding?.message).toContain("whisper-1, which shuts down");
    expect(finding?.message).toContain("`languages`");
    expect(finding?.message).toContain('"verbose_json"');
  });

  it("reads a Python data dict filled in by key, and skips a form that already sends languages", () => {
    const py = [
      'data = {"model": self.model}',
      "if lang:",
      '    data["language"] = lang',
      'response = await self._client.post("/audio/transcriptions", files=files, data=data)',
      "",
    ].join("\n");
    expect(callFindings("p.py", py)[0]?.message).toContain("model is set elsewhere: if that is whisper-1");
    const js = [
      "const form = new FormData();",
      'form.append("model", model);',
      'if (gpt) form.append("languages[]", lang); else form.append("language", lang);',
      'await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", body: form });',
    ].join("\n");
    expect(callFindings("s.ts", js)).toEqual([]);
  });

  it("treats languages in extra_body as handled", () => {
    const py = [
      "def _create(path):",
      '    create_kwargs = {"model": model_name}',
      "    if language:",
      '        if model_name == "gpt-transcribe":',
      '            create_kwargs["extra_body"] = {"languages": [language]}',
      "        else:",
      '            create_kwargs["language"] = language',
      "    return client.audio.transcriptions.create(file=f, **create_kwargs)",
      "",
    ].join("\n");
    expect(callFindings("cloud.py", py)).toEqual([]);
  });

  it("only counts form settings made after the form was last assigned", () => {
    const js = [
      "let form = new FormData();",
      'form.append("language", lang);',
      'await fetch("https://other.example/v1/stt", { method: "POST", body: form });',
      "form = new FormData();",
      'form.append("model", "whisper-1");',
      'await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", body: form });',
    ].join("\n");
    expect(callFindings("two.ts", js)).toEqual([]);
  });

  it("stays quiet on calls with nothing that changes, and on calls already on gpt-transcribe", () => {
    const plain = 'client.audio.transcriptions.create(model="whisper-1", file=f)\n';
    const already = 'client.audio.transcriptions.create(model="gpt-transcribe", file=f, languages=["uz"])\n';
    const migrated = 'client.audio.transcriptions.create(model="gpt-transcribe", file=f, language="uz")\n';
    expect(callFindings("a.py", plain)).toEqual([]);
    expect(callFindings("b.py", already)).toEqual([]);
    expect(callFindings("c.py", migrated)).toEqual([]);
  });

  it("ignores the endpoints in comments, docstrings and Markdown", () => {
    const py = [
      "# client.audio.speech.create(model='tts-1', voice='nova', input=x)",
      '"""',
      'Calls client.audio.transcriptions.create(model="whisper-1", language="en").',
      '"""',
      "",
    ].join("\n");
    expect(callFindings("notes.py", py)).toEqual([]);
    expect(callFindings("CHANGELOG.md", "- moved off `client.audio.speech.create(model=\"tts-1\")`\n")).toEqual([]);
  });

  it("respects the ignore comment", () => {
    const text = 'client.audio.speech.create(model="tts-1", voice="alloy", input=t)  # llm-retire-scan: ignore\n';
    expect(scan("x.py", text).findings).toEqual([]);
  });
});

describe("review probes", () => {
  it("skips server routes, logging helpers and other providers' URLs", () => {
    const py = [
      '@app.post("/v1/audio/speech")',
      "async def speech(body: SpeechRequest): ...",
      'requests.post("https://api.elevenlabs.io/v1/audio/speech", json={"model": "tts-1", "text": t})',
      'httpx.post("http://localhost:8000/v1/audio/speech", json={"model": "tts-1", "input": t})',
      "",
    ].join("\n");
    const js = [
      'router.post("/v1/audio/speech", handler);',
      'logRequest("/v1/audio/speech", { model: "tts-1" });',
    ].join("\n");
    expect(callFindings("server.py", py)).toEqual([]);
    expect(callFindings("server.ts", js)).toEqual([]);
  });

  it("doesn't read a form built in another function", () => {
    const js = [
      "function legacy(file) {",
      "  const form = new FormData();",
      '  form.append("model", "whisper-1");',
      '  form.append("language", "en");',
      '  return fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", body: form });',
      "}",
      "function upload(form: FormData) {",
      '  return fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", body: form });',
      "}",
    ].join("\n");
    expect(callFindings("two.ts", js).map((f) => f.line)).toEqual([5]);
  });

  it("reads aiohttp add_field, a dict(**kwargs) spread, several appends on a line and a split append", () => {
    const aio = [
      "form = aiohttp.FormData()",
      'form.add_field("model", "whisper-1")',
      'form.add_field("language", "en")',
      'async with session.post("https://api.openai.com/v1/audio/transcriptions", data=form) as r:',
      "    pass",
      "",
    ].join("\n");
    const spread = [
      'kwargs = dict(model="whisper-1", file=f, response_format="vtt")',
      "result = client.audio.transcriptions.create(**kwargs)",
      "",
    ].join("\n");
    const oneLine = [
      'const fd = new FormData(); fd.append("file", b); fd.append("model", "whisper-1"); fd.append("timestamp_granularities[]", "word");',
      'await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", body: fd });',
    ].join("\n");
    const split = [
      "const fd = new FormData();",
      "fd.append(",
      '  "model",',
      '  "whisper-1",',
      ");",
      'fd.append("response_format", "srt");',
      'await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", body: fd });',
    ].join("\n");
    expect(callFindings("aio.py", aio)[0]?.message).toContain("`languages`");
    expect(callFindings("kw.py", spread)[0]?.message).toContain('"vtt"');
    expect(callFindings("one.ts", oneLine)[0]?.message).toContain("timestamp_granularities");
    expect(callFindings("split.ts", split)[0]?.message).toContain('"srt"');
  });
});

describe("audio rules on long lines", () => {
  it("stay fast on 20k-character runs before a call", () => {
    const runs = [" ".repeat(20_000), "\t".repeat(20_000), 'form.append("model", '.repeat(1000), "form[\"language\"] = ".repeat(1000),
      "form = ".repeat(3000), "((((".repeat(5000)];
    for (const run of runs) {
      const text = `const form = new FormData();\n${run}\nawait fetch("https://api.openai.com/v1/audio/transcriptions", { body: form });\n`;
      const started = performance.now();
      scan("long.ts", text);
      scan("long.py", text);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });
});

