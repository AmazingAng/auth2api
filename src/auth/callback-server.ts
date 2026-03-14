import http from "http";
import { URL } from "url";

export interface CallbackResult {
  code: string;
  state: string;
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html><body style="font-family:sans-serif;text-align:center;padding-top:80px">
<h1>Login Successful</h1>
<p>You can close this tab and return to the terminal.</p>
</body></html>`;

export function waitForCallback(port = 54545, timeoutMs = 300000): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);

      if (url.pathname === "/callback") {
        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`OAuth error: ${error}`);
          cleanup();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (!code || !state) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing code or state parameter");
          return; // don't consume the one-shot flow
        }

        res.writeHead(302, { Location: "/success" });
        res.end();
        cleanup();
        resolve({ code, state });
      } else if (url.pathname === "/success") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(SUCCESS_HTML);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("OAuth callback timeout"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      server.close();
    }

    server.listen(port, "127.0.0.1", () => {
      console.log(`OAuth callback server listening on http://127.0.0.1:${port}`);
    });
  });
}
