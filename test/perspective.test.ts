import { describe, expect, it } from "vitest";

import { scanPerspective } from "../src/perspective/scan.ts";

const TODAY = "2026-11-14";
const rules = (file: string, text: string, today = TODAY) =>
  scanPerspective(file, text, today).map((f) => `${f.line}:${f.rule}`);

describe("Perspective endpoint", () => {
  it("flags a hard-coded URL with the shutdown date", () => {
    // lm-evaluation-harness lm_eval/tasks/realtoxicityprompts/metric.py
    const text = 'url = f"https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key={API_KEY}"\n';
    const [finding] = scanPerspective("metric.py", text, TODAY);
    expect(finding).toMatchObject({ line: 1, rule: "endpoint", severity: "error", provider: "perspective", urgent: false });
    expect(finding?.message).toContain("stops after 2026-12-31 (47 days left)");
  });

  it("flags a bare host constant (Discourse plugin style)", () => {
    const text = 'GOOGLE_API_DOMAIN = "commentanalyzer.googleapis.com"\nANALYZE = "/v1alpha1/comments:analyze"\n';
    expect(rules("lib/discourse_perspective.rb", text)).toEqual(["1:endpoint"]);
  });

  it("marks a URL that is only a setting's default as a warning", () => {
    const py = 'BASE = os.getenv("PERSPECTIVE_URL", "https://commentanalyzer.googleapis.com/v1alpha1")\n';
    const js = "const base = process.env.PERSPECTIVE_URL ?? 'https://commentanalyzer.googleapis.com';\n";
    expect(rules("a.py", py)).toEqual(["1:endpoint-default"]);
    expect(rules("a.ts", js)).toEqual(["1:endpoint-default"]);
  });

  it("reads a default passed on the line under the lookup", () => {
    const text = 'BASE = os.environ.get(\n    "PERSPECTIVE_URL",\n    "https://commentanalyzer.googleapis.com/v1alpha1",\n)\n';
    expect(rules("a.py", text)).toEqual(["3:endpoint-default"]);
  });

  it("keeps a lone string error when the line above is not a lookup", () => {
    const text = "URLS = [\n    'https://commentanalyzer.googleapis.com/v1alpha1',\n]\n";
    expect(rules("a.py", text)).toEqual(["2:endpoint"]);
  });

  it("skips comments and prose files", () => {
    expect(rules("a.py", "# docs: https://commentanalyzer.googleapis.com\n")).toEqual([]);
    expect(rules("README.md", "Calls https://commentanalyzer.googleapis.com\n")).toEqual([]);
  });

  it("is urgent within 30 days and after the date", () => {
    const text = 'u = "https://commentanalyzer.googleapis.com"\n';
    expect(scanPerspective("a.py", text, "2026-12-05")[0]?.urgent).toBe(true);
    const [after] = scanPerspective("a.py", text, "2027-01-02");
    expect(after?.urgent).toBe(true);
    expect(after?.message).toContain("stopped after 2026-12-31");
    expect(scanPerspective("a.py", text, "2026-12-31")[0]?.message).toContain("today is the last day");
  });
});

describe("Google API client", () => {
  it("flags discovery builds and the generated Node and Go clients", () => {
    expect(rules("a.py", 'client = discovery.build("commentanalyzer", "v1alpha1", developerKey=KEY)\n')).toEqual(["1:google-client"]);
    expect(rules("a.js", "const client = await google.commentanalyzer({ version: 'v1alpha1', auth });\n")).toEqual(["1:google-client"]);
    expect(rules("a.go", '\tcommentanalyzer "google.golang.org/api/commentanalyzer/v1alpha1"\n')).toEqual(["1:google-client"]);
  });

  it("does not flag look-alike identifiers", () => {
    expect(rules("a.py", "from app.comment_analyzer import CommentAnalyzer\nx = commentanalyzer_v2\n")).toEqual([]);
  });
});

describe("client packages", () => {
  it("flags npm, composer and gem clients", () => {
    expect(rules("package.json", '{\n  "dependencies": {\n    "perspective-api-client": "^3.1.0"\n  }\n}\n')).toEqual(["3:client-package"]);
    expect(rules("composer.json", '{"require": {\n "bredmor/comment-analyzer": "^1.0"\n}}\n')).toEqual(["2:client-package"]);
    expect(rules("Gemfile", "gem 'google_perspective'\n")).toEqual(["1:client-package"]);
  });

  it("flags the PyPI clients but not FINOS perspective-python", () => {
    expect(rules("requirements.txt", "perspective==1.0.3\nrequests\n")).toEqual(["1:client-package"]);
    expect(rules("pyproject.toml", 'dependencies = [\n  "perspectiveapi>=1.1",\n]\n')).toEqual(["2:client-package"]);
    expect(rules("requirements.txt", "perspective-python==3.1.0\n# perspective==1.0\n")).toEqual([]);
  });
});

describe("API key variable", () => {
  it("reports a key only when nothing else in the file points at the API", () => {
    expect(rules(".env.example", "PERSPECTIVE_API_KEY=\nOTHER=1\nPERSPECTIVE_API_KEY_2=\n")).toEqual(["1:api-key"]);
    const both = 'KEY = os.environ["PERSPECTIVE_API_KEY"]\nURL = "https://commentanalyzer.googleapis.com/v1alpha1"\n';
    expect(rules("a.py", both)).toEqual(["2:endpoint"]);
  });
});

describe("census regressions", () => {
  it("reports a multi-line discovery build once, on the URL line", () => {
    // HELM / garak / TrustLLM: googleapiclient.discovery.build(...)
    const text = [
      "client = discovery.build(",
      '    "commentanalyzer",',
      '    "v1alpha1",',
      "    developerKey=api_key,",
      '    discoveryServiceUrl="https://commentanalyzer.googleapis.com/$discovery/rest?version=v1alpha1",',
      "    static_discovery=False,",
      ")",
    ].join("\n");
    expect(rules("perspective_api_client.py", text)).toEqual(["5:google-client"]);
  });

  it("reads constants and keys named as defaults as settings defaults", () => {
    // Coral Talk common/lib/constants.ts, greenearth ingest client.go, a Discourse settings.yml
    expect(rules("constants.ts", 'export const TOXICITY_ENDPOINT_DEFAULT =\n  "https://commentanalyzer.googleapis.com/v1alpha1";\n')).toEqual(["2:endpoint-default"]);
    expect(rules("client.go", 'const DefaultHost = "https://commentanalyzer.googleapis.com"\n')).toEqual(["1:endpoint-default"]);
    expect(rules("settings.yml", 'perspective_api_host:\n    default: "https://commentanalyzer.googleapis.com"\n')).toEqual(["2:endpoint-default"]);
  });

  it("flags the googleapis Node client type import", () => {
    expect(rules("serving.ts", "import {commentanalyzer_v1alpha1} from 'googleapis';\n")).toEqual(["1:google-client"]);
  });
});

describe("paths", () => {
  it("reads manifest names and extensions from POSIX and Windows paths", () => {
    expect(rules("pkg/sub/package.json", '"perspective-api-client": "^3"\n')).toEqual(["1:client-package"]);
    expect(rules("pkg\\sub\\requirements-dev.txt", "perspectiveapi==1.1\n")).toEqual(["1:client-package"]);
    expect(rules("docs\\README.md", 'u = "https://commentanalyzer.googleapis.com"\n')).toEqual([]);
    expect(rules(".env", "PERSPECTIVE_API_KEY=x\n")).toEqual(["1:api-key"]);
  });
});

describe("second review", () => {
  it("keeps a hard-coded URL an error when only the key comes from config", () => {
    expect(rules("a.js", "const u = `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${process.env.PERSPECTIVE_API_KEY}`;\n")).toEqual(["1:endpoint"]);
    expect(rules("a.rb", 'Excon.post("https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=#{SiteSetting.perspective_api_key}")\n')).toEqual(["1:endpoint"]);
    expect(rules("a.go", 'req, _ := http.NewRequest("POST", "https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key="+os.Getenv("PERSPECTIVE_API_KEY"), body)\n')).toEqual(["1:endpoint"]);
    expect(rules("a.py", 'r = requests.post("https://commentanalyzer.googleapis.com/x", timeout=settings.TIMEOUT)\n')).toEqual(["1:endpoint"]);
  });

  it("treats only an assigned name as a default, not the word anywhere", () => {
    expect(rules("a.py", 'URL = "https://commentanalyzer.googleapis.com/v1alpha1"  # TODO: default region\n')).toEqual(["1:endpoint"]);
    expect(rules("a.js", 'fetch("https://commentanalyzer.googleapis.com/v1alpha1", { headers: defaultHeaders });\n')).toEqual(["1:endpoint"]);
    expect(rules("a.py", 'session.post(  # uses default timeout\n    "https://commentanalyzer.googleapis.com/v1alpha1",\n)\n')).toEqual(["2:endpoint"]);
    expect(rules("a.py", 'url = settings.get("perspective_url", "https://commentanalyzer.googleapis.com")\n')).toEqual(["1:endpoint-default"]);
  });

  it("needs client context for the service name", () => {
    expect(rules("a.py", 'logger.info("commentanalyzer request failed")\nname = "commentanalyzer"\n')).toEqual([]);
    expect(rules("a.py", 'client = discovery.build(\n    "commentanalyzer",\n    "v1alpha1",\n    developerKey=k,\n)\n')).toEqual(["2:google-client"]);
    expect(rules("a.ts", 'const BASE = "https://commentanalyzer."\n  + "googleapis.com/v1alpha1";\n')).toEqual(["1:endpoint"]);
  });

  it("skips trailing comments and docstrings", () => {
    expect(rules("a.py", "x = 1  # was https://commentanalyzer.googleapis.com\n")).toEqual([]);
    expect(rules("a.py", 'def f():\n    """Before: https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze\n    After: ours."""\n')).toEqual([]);
    expect(rules("a.rb", "x = 1 # was https://commentanalyzer.googleapis.com\n")).toEqual([]);
    expect(rules("a.go", 'x := 1 // https://commentanalyzer.googleapis.com\nu := "https://commentanalyzer.googleapis.com" // the API\n')).toEqual(["2:endpoint"]);
  });

  it("reads PyPI dependencies only, not the project's own package names", () => {
    expect(rules("pyproject.toml", 'name = "perspective"\npackages = [{ include = "perspective" }]\n')).toEqual([]);
    expect(rules("setup.py", 'setup(name="x", packages=["perspective"])\n')).toEqual([]);
    expect(rules("requirements.txt", "perspective  # toxicity\nperspectiveapi @ git+https://example.org/p.git\n")).toEqual(["1:client-package", "2:client-package"]);
    expect(rules("Pipfile", '[packages]\nperspective = "*"\n')).toEqual(["2:client-package"]);
    expect(rules("environment.yml", "dependencies:\n  - perspective\n")).toEqual([]);
  });

  it("finds prefixed and lowercase key names", () => {
    expect(rules(".env.example", "VITE_PERSPECTIVE_API_KEY=\n")).toEqual(["1:api-key"]);
    expect(rules("settings.yml", "perspective_api_key:\n  default: ''\n")).toEqual(["1:api-key"]);
  });
});

describe("third review", () => {
  it("keeps block-string values, masks only standalone block strings", () => {
    expect(rules("a.py", 'URL = """https://commentanalyzer.googleapis.com/v1alpha1"""\n')).toEqual(["1:endpoint"]);
    expect(rules("a.py", 'requests.post("""https://commentanalyzer.googleapis.com/v1alpha1""")\n')).toEqual(["1:endpoint"]);
    expect(rules("a.ts", "const url = `\nhttps://commentanalyzer.googleapis.com/v1alpha1\n`.trim();\n")).toEqual(["2:endpoint"]);
    expect(rules("a.py", 'def f():\n    """https://commentanalyzer.googleapis.com is gone\n    soon."""\n    return 1\n')).toEqual([]);
  });

  it("reads install_requires on a one-line setup() and skips non-dependency tables", () => {
    expect(rules("setup.py", 'setup(name="x", install_requires=["perspective"])\n')).toEqual(["1:client-package"]);
    expect(rules("pyproject.toml", '[project.scripts]\nperspective = "perspective.cli:main"\n[tool.ruff.lint.isort]\nknown-first-party = ["perspective"]\n')).toEqual(["4:client-package"]);
    expect(rules("pyproject.toml", '[tool.poetry.dependencies]\nperspective = "^1.0"\n')).toEqual(["2:client-package"]);
  });

  it("sees default= arguments and default-named keys as defaults", () => {
    expect(rules("a.py", 'p.add_argument("--url", default="https://commentanalyzer.googleapis.com")\n')).toEqual(["1:endpoint-default"]);
    expect(rules("a.ts", 'const opts = { defaultUrl: "https://commentanalyzer.googleapis.com" };\n')).toEqual(["1:endpoint-default"]);
    expect(rules("a.py", 'r = session.get(timeout, "https://commentanalyzer.googleapis.com")\n')).toEqual(["1:endpoint"]);
  });
});
