/**
 * Local OpenAI-compatible proxy for the Nosana Qwen3.5 "thinking mode" endpoint.
 *
 * Problems it solves:
 *   1. Upstream returns `choices[0].message.content = null` with the real answer in
 *      a non-standard `reasoning` field. Clients (like @elizaos/plugin-openai) expect
 *      content to be a string.
 *   2. When clients echo a prior assistant turn back with `content: null`, upstream
 *      rejects it as "Unexpected message role."
 *
 * This proxy:
 *   - Rewrites outgoing requests: drops messages whose content is null/empty.
 *   - Rewrites incoming responses: if content is null but reasoning has text,
 *     extracts the final answer from the reasoning trace and puts it in content.
 *   - Forces a reasonable max_tokens so reasoning-mode doesn't burn the budget.
 */

const UPSTREAM = process.env.UPSTREAM_URL ?? "https://5i8frj7ann99bbw9gzpprvzj2esugg39hxbb4unypskq.node.k8s.prd.nos.ci/v1";
const EMBED_UPSTREAM = process.env.UPSTREAM_EMBED_URL ?? "https://4yiccatpyxx773jtewo5ccwhw1s2hezq5pehndb6fcfq.node.k8s.prd.nos.ci/v1";
const PORT = Number(process.env.PROXY_PORT ?? 3939);

function extractFinalAnswer(reasoning: string): string {
  const stripped = reasoning.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  // Look for an explicit "Final Answer:" / "Response:" label and take everything after it.
  const labelMatch = stripped.match(/(?:final answer|final output|response|answer)\s*[:\-]\s*([\s\S]+?)$/i);
  if (labelMatch) {
    const tail = labelMatch[1].trim();
    // Take the first quoted string if present; otherwise the first line.
    const quoted = tail.match(/[`"']([^`"'\n]{1,500})[`"']/);
    if (quoted) return quoted[1].trim();
    return tail.split(/\n/)[0].trim();
  }

  // No explicit label (often means truncated mid-reasoning). Grab the last
  // quoted candidate answer from the trace.
  const quotes = [...stripped.matchAll(/[`"']([^`"'\n]{1,500})[`"']/g)];
  if (quotes.length > 0) return quotes[quotes.length - 1][1].trim();

  const paragraphs = stripped.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paragraphs[paragraphs.length - 1] ?? stripped;
}

const ALLOWED_ROLES = new Set(["system", "user", "assistant", "tool"]);

function normalizeRole(role: string): string {
  if (role === "developer") return "system";
  if (ALLOWED_ROLES.has(role)) return role;
  return "user";
}

function sanitizeMessages(messages: any[]): any[] {
  return messages
    .filter((m) => {
      if (!m) return false;
      const c = m.content;
      if (c === null || c === undefined) return false;
      if (typeof c === "string" && c.trim() === "") return false;
      return true;
    })
    .map((m) => ({
      role: normalizeRole(m.role),
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      ...(m.name ? { name: m.name } : {}),
    }));
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    console.log(`[proxy] ${req.method} ${url.pathname}`);

    if (url.pathname === "/v1/embeddings") {
      const upstreamRes = await fetch(`${EMBED_UPSTREAM}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: req.headers.get("authorization") ?? "" },
        body: await req.text(),
      });
      return new Response(upstreamRes.body, { status: upstreamRes.status, headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "Qwen3.5-9B-FP8", object: "model", owned_by: "nosana" }] });
    }

    if (url.pathname === "/v1/responses") {
      // Translate OpenAI Responses API → chat/completions for Nosana vLLM.
      const body = await req.json();
      console.log("[proxy] /v1/responses body keys:", Object.keys(body).join(","));
      if (body.text) console.log("[proxy] text field:", JSON.stringify(body.text).slice(0, 500));
      if (body.response_format) console.log("[proxy] response_format:", JSON.stringify(body.response_format).slice(0, 500));
      const messages: any[] = [];
      if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
      const inputItems = Array.isArray(body.input) ? body.input : (body.input ? [body.input] : []);
      for (const item of inputItems) {
        if (typeof item === "string") {
          messages.push({ role: "user", content: item });
          continue;
        }
        if (item?.role && item?.content !== undefined) {
          let text = "";
          if (typeof item.content === "string") text = item.content;
          else if (Array.isArray(item.content)) {
            text = item.content
              .map((c: any) => {
                if (typeof c === "string") return c;
                if (c?.text) return c.text;
                if (c?.type === "input_text" && c?.text) return c.text;
                if (c?.type === "output_text" && c?.text) return c.text;
                return "";
              })
              .filter(Boolean)
              .join("\n");
          }
          if (text) messages.push({ role: item.role, content: text });
        }
      }
      const sanitized = sanitizeMessages(messages);
      const chatBody: any = {
        model: body.model ?? "Qwen3.5-9B-FP8",
        messages: sanitized,
        max_tokens: 4096,
        temperature: body.temperature,
        chat_template_kwargs: { enable_thinking: false },
      };

      const upstreamRes = await fetch(`${UPSTREAM}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: req.headers.get("authorization") ?? "" },
        body: JSON.stringify(chatBody),
      });

      if (!upstreamRes.ok) {
        const text = await upstreamRes.text();
        console.error("[proxy] upstream error (responses→chat)", upstreamRes.status, text.slice(0, 400));
        console.error("[proxy] incoming body was:", JSON.stringify(body).slice(0, 2000));
        console.error("[proxy] translated chatBody:", JSON.stringify(chatBody).slice(0, 2000));
        return new Response(text, { status: upstreamRes.status, headers: { "Content-Type": "application/json" } });
      }

      const chatJson: any = await upstreamRes.json();
      const choice = chatJson.choices?.[0];
      const msg = choice?.message ?? {};
      let answer = typeof msg.content === "string" && msg.content.trim() ? msg.content : "";
      if (!answer && typeof msg.reasoning === "string" && msg.reasoning.trim()) {
        answer = extractFinalAnswer(msg.reasoning).trim();
      }
      console.log(`[proxy] upstream answer (${answer.length} chars, finish=${choice?.finish_reason}):`, answer.slice(0, 400));

      // Build a minimal Responses-API-shaped reply.
      const responsesJson = {
        id: chatJson.id ?? `resp_${Date.now()}`,
        object: "response",
        created_at: chatJson.created ?? Math.floor(Date.now() / 1000),
        model: chatJson.model ?? chatBody.model,
        status: "completed",
        output: [
          {
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: answer, annotations: [] }],
          },
        ],
        output_text: answer,
        usage: {
          input_tokens: chatJson.usage?.prompt_tokens ?? 0,
          output_tokens: chatJson.usage?.completion_tokens ?? 0,
        },
      };
      return Response.json(responsesJson);
    }

    if (url.pathname === "/v1/chat/completions") {
      const body = await req.json();
      console.log("[proxy] /v1/chat/completions roles:", (body.messages ?? []).map((m: any) => m?.role).join(","));
      if (Array.isArray(body.messages)) body.messages = sanitizeMessages(body.messages);
      console.log("[proxy] after sanitize roles:", (body.messages ?? []).map((m: any) => m?.role).join(","));
      body.max_tokens = 4096;

      const upstreamRes = await fetch(`${UPSTREAM}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: req.headers.get("authorization") ?? "" },
        body: JSON.stringify(body),
      });

      if (!upstreamRes.ok) {
        const text = await upstreamRes.text();
        console.error("upstream error", upstreamRes.status, text.slice(0, 400));
        return new Response(text, { status: upstreamRes.status, headers: { "Content-Type": "application/json" } });
      }

      const json: any = await upstreamRes.json();
      for (const choice of json.choices ?? []) {
        const msg = choice.message;
        if (!msg) continue;
        const contentMissing = msg.content === null || msg.content === undefined || msg.content === "";
        if (contentMissing && typeof msg.reasoning === "string" && msg.reasoning.trim()) {
          msg.content = extractFinalAnswer(msg.reasoning).trim();
        }
        if (msg.content === null || msg.content === undefined) msg.content = "";
        // Replace the message with a clean object so stray fields don't confuse clients.
        choice.message = { role: msg.role ?? "assistant", content: msg.content };
      }
      return Response.json(json);
    }

    console.warn(`[proxy] unhandled path: ${url.pathname}`);
    return new Response(JSON.stringify({ error: { message: `proxy: no handler for ${url.pathname}` } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
});

console.log(`qwen-proxy listening on http://127.0.0.1:${PORT}`);
