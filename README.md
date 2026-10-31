# Silent failure lab

Reproduce three customer-facing failures over real local HTTP requests. The save says it worked, the download returns 200, and the payment receipt is acknowledged. The result is still wrong.

No installation, API keys or account. Requires Node.js 20 or newer.

```sh
git clone https://github.com/shaygavan-ui/silent-failure-lab.git
cd silent-failure-lab
node lab.mjs
```

The script starts a server on a temporary loopback port, checks the broken and corrected cases, prints the results and shuts it down.

```text
SAVE: POST 200 says saved; fresh GET still returns the original document.
DOWNLOAD: final GET 200, but the response is a sign-in page, not a CSV.
ACCESS: payment fixture acknowledged with 200; the paid feature still returns 403.
```

## What to check instead of just the status

| Case | What looks successful | Evidence of the problem | Corrected control |
| --- | --- | --- | --- |
| Save | The response contains `saved: true` | A fresh, uncached read still returns the original title | Read back the acknowledged title and revision |
| Download | Fetch follows a redirect and its final response is 200 | The body is HTML from the sign-in page | Check the final content type and known CSV records |
| Paid access | The local payment fixture is acknowledged | The intended paid-feature request returns 403 | Verify access; processing the same fixture twice grants once |

A valid export with no matching records also passes. Empty does not automatically mean broken. The checks also exercise an invalid save and an unknown endpoint. None of the deliberately broken cases raises an internal server exception.

## Inspect the requests yourself

Keep the server running:

```sh
node lab.mjs --serve
```

Use `--serve 0` for a temporary port if 4374 is busy. Substitute the printed address below. These manual commands use POSIX shell quoting; the automatic `node lab.mjs` check works on Windows too.

```sh
curl -i -X POST http://127.0.0.1:4374/broken/document -H "Content-Type: application/json" -d '{"title":"Customer changes"}'
curl -i http://127.0.0.1:4374/broken/document

# -L follows the redirect. The final response is HTML, despite the CSV URL.
curl -i -L http://127.0.0.1:4374/broken/export.csv

curl -i -X POST http://127.0.0.1:4374/broken/payment-receipt
curl -i http://127.0.0.1:4374/broken/paid-feature
```

Replace `/broken/` with `/fixed/` to inspect the corrected fixtures. An expected empty CSV is available at `/fixed/export.csv?empty=1`. State resets when the server stops.

For the manual save check in PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4374/broken/document -ContentType application/json -Body '{"title":"Customer changes"}'
Invoke-RestMethod -Uri http://127.0.0.1:4374/broken/document
```

## Scope

These are intentionally authored reproductions, not customer incidents or AI-generated findings. They run in memory, send requests only to the local server and never contact a payment provider, database or Braith. The payment endpoint is a fake fixture, not a handler to put into production. Nothing is installed or written to disk by the lab.

This is not a monitoring engine or a benchmark of Braith. In a real app, an old value can also come from a cache or another writer. An access denial can be intentional. Correlate the same account, record and attempt, allow expected processing time, and use authoritative evidence before calling the result a failure. A missing event alone is inconclusive.

## Related debugging tools

- [Read a HAR file](https://app.braith.dev/guides/read-har-file) or inspect a recording with the [browser-only HAR viewer](https://app.braith.dev/tools/har-viewer).
- [Debug changes that disappear after saving](https://app.braith.dev/guides/saved-changes-disappear).
- [Debug a download containing HTML instead of CSV](https://app.braith.dev/guides/download-returns-html-instead-of-csv).
- [Debug payment succeeded but access is still denied](https://app.braith.dev/guides/stripe-payment-succeeded-no-access).

I built this lab while working on [Braith](https://app.braith.dev/), which reviews sampled app activity for likely customer problems, including flows without a predefined outcome check. These scripts do not connect an app to Braith. [Setup documentation](https://app.braith.dev/docs/agents).

## References and licence

[Fetch `Response.ok`](https://developer.mozilla.org/en-US/docs/Web/API/Response/ok) describes the HTTP status range, not whether the response delivered the intended customer result. The server uses [Node's built-in HTTP module](https://nodejs.org/api/http.html).

MIT licensed. The licence covers this standalone lab only, not the private Braith application.
