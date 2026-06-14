/**
 * Source for the built-in `deep-research` workflow (Epic 3.1).
 *
 * Shipped as a string constant (built-ins live in the bundle, not on disk — see
 * {@link ./builtins}). The canonical Anthropic deep-research shape: fan out web
 * searches across independent angles, extract checkable claims with source URLs,
 * adversarially verify each claim against its own source (refuter stance — assume
 * unsupported until the source proves it), then synthesize a cited report with
 * the unsupported claims dropped.
 *
 * The agents that touch the web request an explicit `tools` allowlist
 * (`websearch`/`webfetch`/`exa`/`firecrawl`) via the Epic 2.1 seam; names are
 * environment-dependent — whichever the deployment provides activates, the rest
 * are no-ops. The synthesis agent needs no web access (it works from the
 * verified claims) so it omits `tools`.
 *
 * Authoring note: this is a JS program embedded in a TS template literal, so
 * string newlines inside it MUST be written as `\\n` (an actual newline would
 * break the embedded double-quoted literal), and the program uses `+`
 * concatenation only — no backticks or `${}` — so nothing collides with the
 * outer template.
 */
export const DEEP_RESEARCH_SOURCE = `export const meta = {
  name: "deep-research",
  description: "Multi-angle web research: fan out searches across angles, extract checkable claims, adversarially verify each against its source, and synthesize a cited report with unsupported claims dropped.",
  whenToUse: "When the user asks for a deep, cited research report on a question.",
  phases: [
    { title: "Plan" },
    { title: "Search" },
    { title: "Verify" },
    { title: "Synthesize" },
  ],
};

// Web tool names enabled for research agents (Epic 2.1 seam). Environment-
// dependent: whichever the deployment provides activates; unknown names are
// no-ops. Adjust to match your OpenCode / MCP setup.
const WEB_TOOLS = ["websearch", "webfetch", "exa", "firecrawl"];
const MAX_CLAIMS = 40;

const question =
  args && typeof args === "object" && args.question
    ? args.question
    : typeof args === "string"
      ? args
      : "";
if (!question) {
  return { error: "deep-research needs a question — pass args.question (or a string)." };
}

// 1. Plan: decompose the question into independent research angles.
phase("Plan");
const planSchema = {
  type: "object",
  properties: { angles: { type: "array", items: { type: "string" } } },
  required: ["angles"],
};
const plan = await agent(
  "Decompose this research question into 3 to 5 INDEPENDENT search angles — distinct facets worth investigating separately. Return JSON {angles:[...]}.\\n\\nQuestion: " + question,
  { label: "plan", phase: "Plan", schema: planSchema, tools: WEB_TOOLS },
);
const angles = plan && plan.angles && plan.angles.length > 0 ? plan.angles : [question];

// 2. Search + extract claims per angle, each in its own clean context (fan-out).
phase("Search");
const claimsSchema = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, source: { type: "string" } },
        required: ["text", "source"],
      },
    },
  },
  required: ["claims"],
};
const perAngle = await parallel(
  angles.map((angle, i) => () =>
    agent(
      "Research this angle of the question using web search and fetch. Extract specific, checkable factual claims; for each, give the EXACT source URL it came from. Return JSON {claims:[{text, source}]}.\\n\\nQuestion: " + question + "\\nAngle: " + angle,
      { label: "search:" + i, phase: "Search", schema: claimsSchema, tools: WEB_TOOLS },
    ),
  ),
);
const allClaims = perAngle.filter(Boolean).flatMap((r) => r.claims || []);
const claims = allClaims.slice(0, MAX_CLAIMS);
if (allClaims.length > MAX_CLAIMS) {
  log("Capped verification to " + MAX_CLAIMS + " of " + allClaims.length + " extracted claims.");
}

// 3. Adversarially verify each claim against its cited source (refuter stance).
phase("Verify");
const verdictSchema = {
  type: "object",
  properties: { supported: { type: "boolean" }, reason: { type: "string" } },
  required: ["supported", "reason"],
};
const verified = await pipeline(claims, (claim) =>
  agent(
    "Adversarially verify this claim against its source. Fetch the source and check whether it ACTUALLY supports the claim. Assume supported:false unless the source clearly backs it. Return JSON {supported, reason}.\\n\\nClaim: " + claim.text + "\\nSource: " + claim.source,
    { label: "verify", phase: "Verify", schema: verdictSchema, tools: WEB_TOOLS },
  ).then((v) => (v ? { text: claim.text, source: claim.source, verdict: v } : null)),
);
const survivors = verified
  .filter(Boolean)
  .filter((c) => c.verdict && c.verdict.supported);

// 4. Synthesize a cited report from the surviving claims only.
phase("Synthesize");
const citationList = survivors
  .map((c) => "- " + c.text + " [" + c.source + "]")
  .join("\\n");
const report = await agent(
  "Synthesize a clear, well-structured report answering the question using ONLY these verified claims. Cite the source URL inline for each point. If the verified evidence is thin, say so honestly rather than padding.\\n\\nQuestion: " + question + "\\n\\nVerified claims:\\n" + citationList,
  { label: "synthesize", phase: "Synthesize" },
);

return {
  question: question,
  report: report,
  citations: survivors.map((c) => ({ text: c.text, source: c.source })),
  dropped: verified.filter(Boolean).length - survivors.length,
};
`;
