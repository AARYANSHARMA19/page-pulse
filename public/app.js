const form = document.querySelector("#audit-form");
const input = document.querySelector("#url");
const button = form.querySelector("button");
const resultPanel = document.querySelector("#result");
const resultContent = document.querySelector("#result-content");
const cacheBadge = document.querySelector("#cache-badge");
const errorMessage = document.querySelector("#error");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function renderResult(data, cache) {
  const statusClass = data.ok ? "ok" : "bad";
  cacheBadge.textContent = cache === "hit" ? "CACHED" : "FRESH";
  cacheBadge.className = `badge ${cache}`;
  resultContent.innerHTML = `
    <div class="status-row">
      <div class="status ${statusClass}"><strong>${escapeHtml(data.status)}</strong><span>${escapeHtml(data.statusText || "HTTP response")}</span></div>
      <div class="timing"><strong>${escapeHtml(data.responseTimeMs)} ms</strong><span>response time</span></div>
    </div>
    <dl class="facts">
      <div><dt>Final URL</dt><dd>${escapeHtml(data.url)}</dd></div>
      <div><dt>Page title</dt><dd>${escapeHtml(data.title || "No HTML title found")}</dd></div>
      <div><dt>Content type</dt><dd>${escapeHtml(data.contentType || "Unknown")}</dd></div>
      <div><dt>Redirects</dt><dd>${escapeHtml(data.redirects.length)}</dd></div>
    </dl>
  `;
  resultPanel.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  resultPanel.hidden = true;
  errorMessage.hidden = true;
  button.disabled = true;
  button.textContent = "Auditing…";

  try {
    const response = await fetch("/audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: input.value }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || "The audit could not be completed.");
    renderResult(payload.data, payload.meta.cache);
  } catch (error) {
    errorMessage.textContent = error instanceof Error ? error.message : "The audit could not be completed.";
    errorMessage.hidden = false;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Audit page <span aria-hidden="true">→</span>';
  }
});
