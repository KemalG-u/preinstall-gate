(() => {
  /* model lane example (not included in this repository) */
  var OAUTH_PROVIDER_MARKERS = ["codex", "oauth", "claude-code"];
  var METERED_PROVIDERS = new Set([
    "openai",
    "anthropic",
    "googlegemini",
    "openrouter",
    "xai",
    "mistral",
    "groq",
    "cohere",
    "deepseek",
    "minimax",
    "nvidia",
    "sakana"
  ]);
  var LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "llamacpp"]);
  var norm = (s) => (s ?? "").trim().toLowerCase();
  function isOauthProvider(provider) {
    const p = norm(provider);
    if (!p)
      return false;
    return OAUTH_PROVIDER_MARKERS.some((m) => p.includes(m));
  }
  function isMeteredProvider(provider) {
    const p = norm(provider);
    if (!p)
      return false;
    if (isOauthProvider(p))
      return false;
    if (LOCAL_PROVIDERS.has(p))
      return false;
    if (p.includes("openrouter"))
      return true;
    return METERED_PROVIDERS.has(p);
  }
  function isLocalProvider(provider) {
    return LOCAL_PROVIDERS.has(norm(provider));
  }
  function laneFromProvider(provider) {
    const p = norm(provider);
    if (!p)
      return null;
    if (p.includes("codex"))
      return "codex";
    if (p.includes("openrouter"))
      return "ccr";
    if (p === "claude-code")
      return "sub";
    if (METERED_PROVIDERS.has(p) || LOCAL_PROVIDERS.has(p) || isOauthProvider(p))
      return "other";
    return null;
  }
  function laneFromName(name) {
    const n = (name ?? "").trim();
    if (!n)
      return "sub";
    if (/^gpt-/.test(n))
      return "codex";
    if (n.includes("/"))
      return "ccr";
    if (/^(claude-|opus|sonnet|haiku|fable)/i.test(n))
      return "sub";
    return "other";
  }
  function laneFor(name, provider) {
    return laneFromProvider(provider) ?? laneFromName(name);
  }
  function payerLabel(lane, provider) {
    if (lane === "ccr")
      return "OpenRouter kredisi";
    if (lane === "codex")
      return "ChatGPT planı";
    if (lane === "sub")
      return "Claude aboneliği";
    if (isLocalProvider(provider))
      return "yerelde çalışır — ücretlendirilmez";
    if (isOauthProvider(provider))
      return `${provider} aboneliği`;
    if (isMeteredProvider(provider))
      return `${provider} hesabınız (kullandıkça ücretli)`;
    return "bilinmiyor — bu yol ödeme kaynağını bildirmiyor";
  }

  /* model entry prototype (not included in this repository) */
  globalThis.agenticLane = { laneFor, payerLabel };
})();
