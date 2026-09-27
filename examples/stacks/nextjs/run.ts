/**
 * Runs the two Next.js route handlers the way Next.js calls them (a Web Request
 * in, a Response out) without starting Next.js. Run: pnpm example:nextjs
 *
 * From this repository the layer runs from source with BVSALA_DEV_OPEN=1; the
 * published package has no unlicensed mode and needs BIVELIO_LICENSE_KEY.
 */
import { GET } from "./app/api/bivelio-check/route";
import { POST } from "./app/api/chat/route";

const check = await GET();
console.log(`GET /api/bivelio-check → ${check.status}`, await check.json());

const chat = await POST(
  new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "What is 2 + 2 * 3?" }),
  }),
);
console.log(`POST /api/chat → ${chat.status}`, await chat.json());
