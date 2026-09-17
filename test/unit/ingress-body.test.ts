import { expect, test } from "vitest";
import { declaredIngressContentLength, readCappedIngressBody } from "../../src/ingress-body";

test("declaredIngressContentLength reads a numeric Content-Length header", () => {
  expect(
    declaredIngressContentLength(
      new Request("https://example.com", {
        headers: { "Content-Length": "2048" }
      })
    )
  ).toBe(2048);
  expect(declaredIngressContentLength(new Request("https://example.com"))).toBeNull();
});

test("readCappedIngressBody rejects a body above the 768 KiB tunnel cap", async () => {
  const over = await readCappedIngressBody(
    new Request("https://example.com", { method: "POST", body: "hello world" }),
    4
  );
  expect(over).toMatchObject({ ok: false, error: "request_too_large" });

  const ok = await readCappedIngressBody(
    new Request("https://example.com", { method: "POST", body: "hello" }),
    16
  );
  expect(ok.ok).toBe(true);
  if (ok.ok) {
    expect(new TextDecoder().decode(ok.body)).toBe("hello");
  }
});
